import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../server/workflow/executor.js';
import { validateWorkflow, WorkflowError } from '../server/workflow/schema.js';
import { wf, record, loop, branch, NOW } from './helpers.js';

const accountFields = [{ name: 'Name', type: 'text', options: { mode: 'company' } }];
const lookup = (ref, mode = 'current', type = 'lookup') => ({ name: 'AccountId', type, options: { mode, ref } });
const contactFields = (ref = 'acc') => [
  { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
  lookup(ref),
  { name: 'Title', type: 'template', options: { template: '{{acc.Name}} #{{loop.index}}' } },
];
const acc = (id = 'a', extra) => record(id, 'Account', 'acc', accountFields, extra);
const errorsOf = (w) => validateWorkflow(w).errors;
const warningsOf = (w) => validateWorkflow(w).warnings;

function accountsWithContacts(accounts = 2, contacts = 3) {
  return wf([loop('outer', { count: accounts, alias: 'outer' }, [acc(), loop('inner', { count: contacts }, [record('c', 'Contact', 'con', contactFields())])])]);
}

test('nested loops produce parent/child records linked by $ref', () => {
  const { records, stats } = runWorkflow(accountsWithContacts(), { seed: 1, now: NOW });
  assert.deepEqual(stats.bySobject, { Account: 2, Contact: 6 });
  const contacts = records.filter((r) => r.sobject === 'Contact');
  assert.equal(contacts[0].fields.AccountId.$ref, 'acc#1');
  assert.equal(contacts[5].fields.AccountId.$ref, 'acc#2');
  assert.equal(contacts[2].fields.Title, `${records[0].fields.Name} #3`);
});

test('seed makes runs reproducible', () => {
  const a = runWorkflow(accountsWithContacts(), { seed: 'abc', now: NOW });
  const b = runWorkflow(accountsWithContacts(), { seed: 'abc', now: NOW });
  assert.deepEqual(a.records, b.records);
});

test('record count; the step after a loop runs once the loop is done', () => {
  const w = wf([acc('a', { count: 5 }), loop('l', { count: 0 }), record('b', 'Lead', 'ld', [], { count: 2 })]);
  assert.deepEqual(runWorkflow(w, { seed: 1 }).stats.bySobject, { Account: 5, Lead: 2 });
});

test('branch compare on loop index', () => {
  const w = wf([loop('l', { count: 10 }, [branch('b', { kind: 'compare', left: 'loop.index', op: 'divisibleBy', right: '2' }, [record('even', 'Account', 'ev', accountFields)], [record('odd', 'Lead', 'od', [])])])]);
  assert.deepEqual(runWorkflow(w, { seed: 1 }).stats.bySobject, { Lead: 5, Account: 5 });
});

test('the step after a branch runs whichever column ran', () => {
  const w = wf([loop('l', { count: 10 }, [branch('b', { probability: 0.5 }, [record('t', 'Task', 'tk', [])], []), record('after', 'Lead', 'ld', [])])]);
  const { stats } = runWorkflow(w, { seed: 3 });
  assert.equal(stats.bySobject.Lead, 10);
  assert.equal(stats.byStep.b.true + stats.byStep.b.false, 10);
  assert.equal(stats.byStep.b.true, stats.bySobject.Task);
});

test('stats.byStep counts runs, records, iterations and branch outcomes', () => {
  const { stats } = runWorkflow(accountsWithContacts(2, 3), { seed: 1, now: NOW });
  assert.deepEqual(stats.byStep.outer, { runs: 1, records: 8, iterations: 2 });
  assert.deepEqual(stats.byStep.inner, { runs: 2, records: 6, iterations: 6 });
  assert.deepEqual(stats.byStep.a, { runs: 2, records: 2 });
  assert.deepEqual(stats.byStep.c, { runs: 6, records: 6 });
});

test('disabled steps (and everything inside) are skipped without using the rng', () => {
  const base = [loop('l', { mode: 'range', min: 1, max: 5 }, [acc()])];
  const off = [{ ...loop('x', { mode: 'range', min: 1, max: 9 }, [record('o', 'Lead', 'ld', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }])]), disabled: true }, ...base];
  const a = runWorkflow(wf(base), { seed: 9, now: NOW });
  const b = runWorkflow(wf(off), { seed: 9, now: NOW });
  assert.deepEqual(b.records, a.records);
  assert.equal(b.stats.byStep.x, undefined);
});

// ---------- validation ----------

test('validation: Loop{acc} then a Contact with Lookup random → acc is valid (last)', () => {
  const w = wf([loop('l', { count: 10 }, [acc()]), record('c', 'Contact', 'con', [lookup('acc', 'random')], { count: 50 })]);
  const { errors, warnings } = validateWorkflow(w);
  assert.deepEqual(errors, []);
  assert.equal(warnings.filter((x) => x.nodeId === 'c').length, 0);
  const { records } = runWorkflow(w, { seed: 1 });
  assert.ok(records.filter((r) => r.sobject === 'Contact').every((r) => /^acc#\d+$/.test(r.fields.AccountId.$ref)));
});

test('validation: a parent below the step is an error with a fix hint (also self-reference)', () => {
  const below = wf([record('c', 'Contact', 'con', contactFields('acc')), acc()]);
  const e = errorsOf(below).find((x) => x.nodeId === 'c');
  assert.equal(e.field, 'fields.AccountId');
  assert.match(e.message, /nằm sau bước này.*Kéo bước "acc" lên phía trên/);
  const self = wf([record('c', 'Contact', 'con', [lookup('con')])]);
  assert.match(errorsOf(self)[0].message, /bước "con" nằm sau bước này/);
});

test('validation: a parent in the other branch column is an error', () => {
  const w = wf([branch('b', {}, [acc()], [record('c', 'Contact', 'con', [lookup('acc')])])]);
  const e = errorsOf(w).find((x) => x.nodeId === 'c');
  assert.equal(e.field, 'fields.AccountId');
  assert.match(e.message, /nhánh còn lại/);
});

// Wording changed in 0005 ("Thông báo lỗi và cảnh báo"): the warning names the cause (branch / loop that may run 0 times).
test('validation: maybe-defined source is a warning; masterdetail wording', () => {
  const inBranch = wf([branch('b', {}, [acc()], []), record('c', 'Contact', 'con', [lookup('acc')])]);
  assert.deepEqual(errorsOf(inBranch), []);
  const wb = warningsOf(inBranch).find((x) => x.nodeId === 'c');
  assert.equal(wb.code, 'maybe');
  assert.match(wb.message, /^Field "AccountId": "acc" chỉ được tạo trên một số nhánh trước khi tới đây, nên có thể chưa có \(field này trống/);
  const zeroLoop = wf([loop('l', { mode: 'range', min: 0, max: 3, alias: 'loopAcc' }, [acc()]), record('c', 'Contact', 'con', [lookup('acc', 'current', 'masterdetail')])]);
  const w = warningsOf(zeroLoop).find((x) => x.nodeId === 'c');
  assert.equal(w.field, 'fields.AccountId');
  assert.equal(w.message, 'Field "AccountId": vòng lặp "loopAcc" có thể chạy 0 lần nên "acc" có thể chưa có bản ghi. Master-Detail sẽ báo lỗi khi chạy; đặt "Ít nhất" ≥ 1.');
  // Templates get the same warning.
  const tpl = wf([branch('b', {}, [acc()], []), record('c', 'Contact', 'con', [{ name: 'Title', type: 'template', options: { template: '{{acc.Name}}' } }])]);
  assert.deepEqual(errorsOf(tpl), []);
  assert.match(warningsOf(tpl).find((x) => x.nodeId === 'c').message, /^Field "Title": "acc" chỉ được tạo trên một số nhánh.*\(giá trị trống, hoặc là bản ghi của lần lặp trước\)/);
  // Both columns create it → after the branch it is still only "maybe" (aliases are unique), but
  // a parent before the branch is always fine.
  const before = wf([acc(), branch('b', {}, [record('c', 'Contact', 'con', [lookup('acc')])], [])]);
  assert.deepEqual(validateWorkflow(before), { errors: [], warnings: [] });
});

test('validation: disabled steps are not checked; references to them are errors', () => {
  const w = wf([{ ...acc(), disabled: true }, { ...record('bad', '', 'bad', [{ name: '1x', type: 'nope' }]), disabled: true }, record('c', 'Contact', 'con', [lookup('acc')])]);
  const { errors } = validateWorkflow(w);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].nodeId, 'c');
  assert.match(errors[0].message, /đang tắt.*Ctrl\+\//);
  // Aliases stay unique across disabled steps.
  const dup = wf([{ ...acc('a1'), disabled: true }, acc('a2')]);
  assert.match(errorsOf(dup)[0].message, /Alias "acc" đã được dùng ở bước khác/);
});

test('validation: unknown alias and missing parent', () => {
  const w = wf([record('c', 'Contact', 'con', [lookup('zzz'), { name: 'X', type: 'lookup', options: {} }])]);
  const msgs = errorsOf(w).map((x) => x.message).join('\n');
  assert.match(msgs, /không có bước Record nào có alias "zzz"/);
  assert.match(msgs, /chưa chọn bản ghi cha/);
});

test('validation: structure errors (ids, types, slots) carry nodeId and field', () => {
  const w = wf([
    { type: 'record', config: {} },
    acc('dup'),
    record('dup', 'Lead', 'ld'),
    { id: 'x', type: 'teleport' },
    { ...record('r', 'Lead', 'ld2'), slots: { body: [] } },
    { id: 'l', type: 'loop', config: {}, slots: { body: [], sideways: [] } },
    { id: 'b', type: 'branch', config: {}, slots: { true: 'nope' } },
  ]);
  const errors = errorsOf(w);
  const find = (re) => errors.find((e) => re.test(e.message));
  assert.ok(find(/Có bước không có id/));
  assert.equal(find(/Trùng id bước "dup"/).nodeId, 'dup');
  assert.equal(find(/Loại bước "teleport"/).nodeId, 'x');
  assert.deepEqual([find(/không chứa bước con/).nodeId, find(/không chứa bước con/).field], ['r', 'slots']);
  assert.deepEqual([find(/không có nhánh "sideways"/).nodeId, find(/không có nhánh "sideways"/).field], ['l', 'slots.sideways']);
  assert.equal(find(/"slots.true" phải là một danh sách/).field, 'slots.true');
});

test('validation: version and steps', () => {
  assert.match(errorsOf({ version: 3, steps: [] })[0].message, /version 3.*Version hiện tại là 2/);
  assert.match(errorsOf({ version: 2 })[0].message, /Thiếu danh sách "steps"/);
  assert.match(errorsOf(null)[0].message, /object JSON/);
});

test('validation: more than 32 levels of nesting is an error', () => {
  const nest = (n) => (n === 0 ? [acc()] : [loop(`l${n}`, { count: 1, alias: `v${n}` }, nest(n - 1))]);
  assert.deepEqual(errorsOf(wf(nest(10))), []);
  const deep = errorsOf(wf(nest(40)));
  assert.equal(deep.length, 1);
  assert.match(deep[0].message, /lồng nhau quá 32 cấp/);
});

test('validation: empty slots are warnings on slots.<key>, not errors', () => {
  const w = wf([loop('l'), branch('b')]);
  const { errors, warnings } = validateWorkflow(w);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.find((x) => x.nodeId === 'l').field, 'slots.body');
  assert.match(warnings.find((x) => x.nodeId === 'l').message, /Vòng lặp chưa có bước nào/);
  assert.deepEqual(warnings.find((x) => x.nodeId === 'b').field, 'slots.true');
  assert.ok(runWorkflow(w, { seed: 1 }).records.length === 0);
});

test('validation: duplicate aliases and loop var clashing with a record alias', () => {
  const w = wf([acc('a'), record('b', 'Account', 'acc', accountFields), loop('l', { alias: 'acc' }, [record('c', 'Lead', 'ld')])]);
  const msgs = errorsOf(w).map((e) => `${e.nodeId}:${e.field}:${e.message}`).join('\n');
  assert.match(msgs, /b:alias:Alias "acc" đã được dùng/);
  assert.match(msgs, /l:alias:Tên biến lặp "acc" trùng alias/);
});

test('maxRecords guard raises a WorkflowError tied to the step', () => {
  const w = wf([acc('a', { count: 50 })]);
  assert.throws(
    () => runWorkflow(w, { maxRecords: 10 }),
    (e) => e instanceof WorkflowError && e.issues[0].nodeId === 'a',
  );
});

test('version 1 input still runs, with a conversion warning', () => {
  const v1 = {
    version: 1,
    nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'record', config: { sobject: 'Account', alias: 'acc', count: 2, fields: accountFields } }, { id: 'z', type: 'record', config: { sobject: 'Lead', alias: 'z' } }],
    edges: [{ from: 'start', to: 'a' }],
  };
  const r = runWorkflow(v1, { seed: 1 });
  assert.equal(r.records.length, 2);
  assert.match(r.warnings[0].message, /version 1 đã được tự chuyển sang version 2/);
  assert.equal(r.warnings[0].nodeId, undefined);
  assert.ok(r.warnings.some((w) => w.nodeId === 'z' && /đang tắt/.test(w.message)));
  assert.match(errorsOf({ version: 1, nodes: [] })[0].message, /Thiếu danh sách "edges"/);
});

// ---------- variable references (design 0005) ----------

const tplField = (name, template) => ({ name, type: 'template', options: { template } });
const issueOf = (list, field) => list.find((x) => x.field === field);

test('validation: unknown variable and misspelt field are errors with a suggestion', () => {
  const w = wf([acc(), record('c', 'Contact', 'con', [tplField('Title', '{{acc.Nmae}} {{acco.Name}}')])]);
  const errors = errorsOf(w).filter((x) => x.nodeId === 'c');
  const member = errors.find((x) => x.code === 'unknownMember');
  assert.equal(member.field, 'fields.Title');
  assert.equal(member.path, 'acc.Nmae');
  assert.equal(member.message, 'Field "Title": bước "acc" (Account) không có field "Nmae". Ý bạn là "Name"? Thêm field đó vào bước "acc" hoặc chọn field khác bằng {x}.');
  assert.deepEqual(member.suggestion, { option: 'template', from: 'acc.Nmae', to: 'acc.Name' });
  const name = errors.find((x) => x.code === 'unknownName');
  assert.equal(name.message, 'Field "Title": không có biến "acco" (không phải alias của bước Record nào, cũng không phải tên biến lặp). Ý bạn là "acc"? Bấm {x} để chọn biến có sẵn.');
  assert.deepEqual(name.suggestion, { option: 'template', from: 'acco.Name', to: 'acc.Name' });
  // Broken references block the run (they used to produce '').
  assert.throws(() => runWorkflow(w, { seed: 1 }), (e) => e instanceof WorkflowError && e.issues.some((i) => i.code === 'unknownMember'));
});

test('validation: loop var outside its body is an error on the right field', () => {
  const w = wf([
    loop('l', { count: 2 }, [acc()]),
    record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text' }, tplField('Title', 'x {{loop.index}}')]),
    branch('b', { kind: 'compare', left: '{{loop.index}}', op: 'eq', right: '1' }, [record('t', 'Task', 'tk', [])]),
  ]);
  const errors = errorsOf(w);
  const t = errors.find((x) => x.nodeId === 'c');
  assert.deepEqual([t.field, t.code, t.path], ['fields.Title', 'outsideLoop', 'loop.index']);
  assert.equal(t.message, 'Field "Title": {{loop.index}} chỉ dùng được bên trong vòng lặp "loop". Kéo bước này vào trong vòng lặp "loop", hoặc bỏ biến này.');
  const b = errors.find((x) => x.nodeId === 'b');
  assert.deepEqual([b.field, b.code], ['left', 'outsideLoop']);
  assert.equal(b.message, 'loop.index chỉ dùng được bên trong vòng lặp "loop". Kéo bước này vào trong vòng lặp "loop", hoặc bỏ biến này.');
});

test('validation: this.* below the current field is an error', () => {
  const w = wf([record('c', 'Contact', 'con', [tplField('Title', '{{this.Email}}'), { name: 'Email', type: 'email' }])]);
  const e = issueOf(errorsOf(w), 'fields.Title');
  assert.equal(e.code, 'thisBelow');
  assert.equal(e.message, 'Field "Title": {{this.Email}} chỉ thấy field phía trên. Kéo field "Email" lên trên "Title" (nút ↑).');
  const self = wf([record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text' }, tplField('Title', '{{this.Title}} {{con.LastName}} {{this.LastNam}}')])]);
  const msgs = errorsOf(self).map((x) => x.message);
  assert.ok(msgs.includes('Field "Title": template không thể dùng chính field "Title".'));
  assert.ok(msgs.includes('Field "Title": đang ở trong bước "con", hãy dùng {{this.LastName}} thay cho {{con.LastName}} (con.* ở đây là bản ghi trước đó của chính bước này).'));
  assert.ok(msgs.includes('Field "Title": bước này không có field "LastNam". Ý bạn là "LastName"?'));
});

test('validation: other broken references (whole record, Id, other branch, after, this in a branch, unclosed)', () => {
  const w = wf([
    acc(),
    branch('b', { kind: 'compare', left: 'this.Name', op: 'eq', right: '1' }, [record('t', 'Task', 'task', [{ name: 'Subject', type: 'text' }])], [record('c', 'Contact', 'con', [tplField('Title', '{{acc}} {{acc.Id}} {{task.Subject}} {{opp.Name}} {{acc.Name')])]),
    record('o', 'Opportunity', 'opp', [{ name: 'Name', type: 'text' }]),
  ]);
  const { errors, warnings } = validateWorkflow(w);
  const byCode = Object.fromEntries(errors.map((x) => [x.code, x]));
  assert.equal(byCode.wholeRecord.message, 'Field "Title": {{acc}} là cả bản ghi; hãy chọn một field, ví dụ {{acc.Name}}.');
  assert.match(byCode.noIdYet.message, /^Field "Title": "acc" là bản ghi được sinh ra nên chưa có Id trước khi insert\./);
  assert.equal(byCode.otherBranch.message, 'Field "Title": bước "task" nằm ở nhánh còn lại của Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "task" ra trước Rẽ nhánh, hoặc chọn biến khác.');
  assert.equal(byCode.after.message, 'Field "Title": bước "opp" chạy sau bước này nên chưa có giá trị khi chạy tới đây. Kéo bước "opp" lên phía trên, hoặc chọn biến khác.');
  assert.deepEqual([byCode.thisOutsideRecord.nodeId, byCode.thisOutsideRecord.field], ['b', 'left']);
  assert.equal(byCode.thisOutsideRecord.message, '"this" chỉ dùng trong template của bước Record. Ở đây hãy chọn alias của bước, ví dụ acc.Industry.');
  const unclosed = warnings.find((x) => x.code === 'unclosed');
  assert.equal(unclosed.message, 'Field "Title": có "{{" chưa đóng bằng "}}" nên sẽ được giữ nguyên là chữ.');
  assert.equal(unclosed.field, 'fields.Title');
});

test('validation: a reference to a turned-off step is an error; references inside it are not checked', () => {
  const w = wf([{ ...acc(), disabled: true }, { ...record('x', 'Lead', 'ld', [tplField('T', '{{nope.Name}}')]), disabled: true }, record('c', 'Contact', 'con', [tplField('Title', '{{acc.Name}}')])]);
  const errors = errorsOf(w);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Field "Title": bước "acc" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn biến khác.');
});

test('validation: a branch left accepts {{loop.index}} inside the loop', () => {
  const w = wf([loop('l', { count: 4 }, [branch('b', { kind: 'compare', left: '{{ loop.index }}', op: 'divisibleBy', right: '2' }, [record('e', 'Account', 'ev', accountFields)])])]);
  assert.deepEqual(validateWorkflow(w), { errors: [], warnings: [] });
  assert.equal(runWorkflow(w, { seed: 1 }).stats.bySobject.Account, 2);
});

test('template: {{this.$n}} and {{acc.$n}} follow alias#n; the default is {{this.$n}}', () => {
  const w = wf([
    acc('a', { count: 2 }),
    record('c', 'Contact', 'con', [{ name: 'N', type: 'template', options: {} }, tplField('P', 'C{{this.$n}} of A{{acc.$n}}')], { count: 3 }),
  ]);
  assert.deepEqual(validateWorkflow(w).errors, []);
  const contacts = runWorkflow(w, { seed: 1 }).records.filter((r) => r.sobject === 'Contact');
  assert.deepEqual(contacts.map((r) => r.fields.N), ['1', '2', '3']);
  assert.deepEqual(contacts.map((r) => r.fields.P), ['C1 of A2', 'C2 of A2', 'C3 of A2']);
});

test('validation: a Lookup imported with referenceTo warns when the parent step is another sObject', () => {
  const w = wf([acc(), record('l', 'Lead', 'ld', [{ name: 'Name', type: 'text' }]), record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'ld', referenceTo: ['Account'] } }])]);
  const { errors, warnings } = validateWorkflow(w);
  assert.deepEqual(errors, []);
  const x = warnings.find((i) => i.code === 'wrongSobject');
  assert.equal(x.message, 'Field "AccountId": bước "ld" là Lead, nhưng field này trỏ tới Account. Chọn bản ghi cha là Account.');
  assert.equal(x.field, 'fields.AccountId');
  const ok = wf([acc(), record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'acc', referenceTo: ['Account'] } }])]);
  assert.deepEqual(validateWorkflow(ok), { errors: [], warnings: [] });
});
