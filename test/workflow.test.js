import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../server/workflow/executor.js';
import { validateWorkflow, WorkflowError } from '../server/workflow/schema.js';
import { wf, record, loop, branch, query, pick, rows, NOW } from './helpers.js';
import { copy as copyType } from '../server/generators/misc.js';

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

// ---------- review fixes (0005 "Sửa sau review") ----------

test('validation: a turned-off loop\'s variable used outside it is outsideLoop, not "turn it back on"', () => {
  const w = wf([{ ...loop('L', { count: 2 }, [acc()]), disabled: true }, record('c', 'Contact', 'con', [tplField('T', '{{loop.index}}')])]);
  const e = errorsOf(w).find((x) => x.nodeId === 'c');
  assert.equal(e.code, 'outsideLoop');
  assert.doesNotMatch(e.message, /Bật lại/);
});

test('validation: loop.index outside any loop is outsideLoop with how to fix; inside another loop it suggests that loop', () => {
  const none = wf([acc(), branch('b', { kind: 'compare', left: 'loop.index', op: 'eq', right: '1' }, [record('t', 'Task', 'tk', [])])]);
  const e = errorsOf(none).find((x) => x.nodeId === 'b');
  assert.equal(e.code, 'outsideLoop');
  assert.equal(e.message, 'loop.index chỉ dùng được bên trong một vòng lặp, nhưng bước này không nằm trong vòng lặp nào. Bọc bước này trong Lặp (menu ⋯ → "Bọc trong Lặp"), hoặc chọn biến khác bằng {x}.');
  const other = wf([loop('l', { count: 2, alias: 'i' }, [branch('b', { kind: 'compare', left: 'loop.index', op: 'eq', right: '1' }, [record('t', 'Task', 'tk', [])])])]);
  assert.deepEqual(errorsOf(other).find((x) => x.nodeId === 'b').suggestion, { option: 'left', from: 'loop.index', to: 'i.index' });
});

test('validation: Master-Detail hint names the loop option that is in use', () => {
  const md = (cfg) => wf([loop('l', { alias: 'x', ...cfg }, [acc()]), record('c', 'Contact', 'con', [lookup('acc', 'current', 'masterdetail')])]);
  assert.match(warningsOf(md({ count: 0 })).find((x) => x.nodeId === 'c').message, /đặt "Số lần lặp" ≥ 1\.$/);
  assert.match(warningsOf(md({ mode: 'range', min: 0, max: 2 })).find((x) => x.nodeId === 'c').message, /đặt "Ít nhất" ≥ 1\.$/);
});

test('validation: a missing sub-member names the field\'s members', () => {
  const w = wf([record('a', 'Account', 'acc', [{ name: 'Geo__c', type: 'geolocation' }]), record('c', 'Contact', 'con', [tplField('T', '{{acc.Geo__c.latitude}} {{acc.Geo__c.lat}}')])]);
  const errors = errorsOf(w);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Field "T": field "Geo__c" của bước "acc" chỉ có latitude, longitude; không có "lat".');
});

// ---------- Query and Chọn bản ghi (design 0006) ----------

const ACCS = [
  { Id: '001000000000001AAA', Name: 'Acme', Industry: 'Banking' },
  { Id: '001000000000002AAA', Name: 'Globex', Industry: 'Retail' },
  { Id: '001000000000003AAA', Name: 'Initech', Industry: 'Banking' },
];
const CONS = [
  { Id: '003A', AccountId: '001000000000001AAA', LastName: 'An' },
  { Id: '003B', AccountId: '001000000000002AAA', LastName: 'Bình' },
  { Id: '003C', AccountId: '001000000000001AAA', LastName: 'Chi' },
];

test('query pool feeds lookups with real Ids and rows are not output records', () => {
  const w = wf([
    query('q', 'accs', { fields: ['Id', 'Name', 'Industry'] }),
    record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, lookup('accs', 'random'), tplField('Title', '{{accs.$count}} accounts')], { count: 6 }),
  ]);
  assert.deepEqual(validateWorkflow(w).errors, []);
  const r = runWorkflow(w, { seed: 4, now: NOW, queryResults: { q: rows(ACCS) } });
  assert.deepEqual(r.stats.bySobject, { Contact: 6 });
  assert.ok(r.records.every((x) => ACCS.some((a) => a.Id === x.fields.AccountId)), 'Lookup gives the real Id string');
  assert.ok(r.records.every((x) => x.fields.Title === '3 accounts'));
  assert.deepEqual(r.stats.byStep.q, { runs: 1, records: 0, rows: 3 });
  // A Query does not draw from the rng: removing it (and its Lookup) leaves the other values as they were.
  const plain = runWorkflow(wf([record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, lookup('acc', 'fixed')], { count: 6 })].map((s) => ({ ...s, config: { ...s.config, fields: [s.config.fields[0], { name: 'AccountId', type: 'lookup', options: { mode: 'fixed', ids: ACCS.map((a) => a.Id) } }] } }))), { seed: 4, now: NOW });
  assert.deepEqual(r.records.map((x) => [x.fields.LastName, x.fields.AccountId]), plain.records.map((x) => [x.fields.LastName, x.fields.AccountId]));
  // The executor never reads the org: without pre-fetched rows the step fails with its id.
  assert.throws(() => runWorkflow(w, { seed: 1 }), (e) => e instanceof WorkflowError && e.issues[0].nodeId === 'q' && /chưa có dữ liệu/.test(e.issues[0].message));
});

test('pick random, unique and sequential are reproducible with a seed', () => {
  const make = (mode, n = 6) => wf([query('q', 'accs'), loop('l', { count: n }, [pick('p', 'acc', 'accs', { mode }), record('c', 'Contact', 'con', [tplField('Title', '{{acc.Name}}'), lookup('acc')])])]);
  const names = (mode, seed, n) => runWorkflow(make(mode, n), { seed, now: NOW, queryResults: { q: rows(ACCS) } }).records.map((x) => x.fields.Title);
  for (const mode of ['random', 'unique', 'sequential']) {
    assert.deepEqual(validateWorkflow(make(mode)).errors, [], mode);
    assert.deepEqual(names(mode, 7, 6), names(mode, 7, 6), `${mode} is reproducible`);
  }
  assert.deepEqual(names('sequential', 1, 5), ['Acme', 'Globex', 'Initech', 'Acme', 'Globex']);
  const unique = names('unique', 3, 3);
  assert.deepEqual([...unique].sort(), ['Acme', 'Globex', 'Initech'], 'unique uses every row once');
  // The picked record is the pool row itself: the Lookup gives its real Id, {{acc.Id}} works.
  const r = runWorkflow(make('random', 4), { seed: 2, now: NOW, queryResults: { q: rows(ACCS) } });
  for (const x of r.records) assert.equal(ACCS.find((a) => a.Name === x.fields.Title).Id, x.fields.AccountId);
  assert.deepEqual(r.stats.byStep.p, { runs: 4, records: 0, picked: 4 });
  assert.equal(r.samples.p.Name, r.records[0].fields.Title);
});

test('pick filter with {{acc.Id}} selects children of the current parent', () => {
  const w = wf([
    query('q', 'accs'),
    query('qc', 'cons', { sobject: 'Contact', fields: ['Id', 'AccountId', 'LastName'] }),
    loop('l', { count: 8 }, [
      pick('p', 'acc', 'accs', { mode: 'sequential' }),
      pick('pc', 'con', 'cons', { filter: 'compare', filterField: 'AccountId', filterOp: 'eq', filterValue: '{{acc.Id}}' }),
      record('o', 'Opportunity', 'opp', [tplField('Name', '{{acc.Name}} / {{con.LastName}}'), { name: 'ContactId__c', type: 'lookup', options: { ref: 'con' } }]),
    ]),
  ]);
  assert.deepEqual(validateWorkflow(w).errors, []);
  const r = runWorkflow(w, { seed: 5, now: NOW, queryResults: { q: rows(ACCS), qc: rows(CONS, 'Contact') } });
  for (const x of r.records) {
    const [accName, conName] = x.fields.Name.split(' / ');
    const con = CONS.find((c) => c.LastName === conName);
    assert.equal(ACCS.find((a) => a.Name === accName).Id, con.AccountId, x.fields.Name);
    assert.equal(x.fields.ContactId__c, con.Id);
  }
  // Initech has no contact: its iterations are skipped (8 sequential picks → Initech 2 times).
  assert.equal(r.records.length, 6);
  assert.equal(r.stats.byStep.pc.skipped, 2);
});

test('pick onEmpty skip warns once, error fails with nodeId', () => {
  const w = (onEmpty) => wf([
    query('q', 'accs'),
    loop('l', { count: 5 }, [
      pick('p', 'acc', 'accs', { filter: 'compare', filterField: 'Industry', filterValue: 'Banking', mode: 'unique', onEmpty }),
      record('c', 'Contact', 'con', [lookup('acc')]),
    ]),
    record('after', 'Task', 'task', []),
  ]);
  const r = runWorkflow(w('skip'), { seed: 1, queryResults: { q: rows(ACCS) } });
  assert.equal(r.stats.bySobject.Contact, 2, 'two Banking accounts, then the rest of each iteration is skipped');
  assert.equal(r.stats.bySobject.Task, 1, 'the step after the loop still runs');
  const warns = r.warnings.filter((x) => x.code === 'pickSkipped');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].nodeId, 'p');
  assert.equal(warns[0].message, 'Bước Chọn bản ghi "acc": 3/5 lần không có bản ghi phù hợp nên đã bỏ qua các bước phía sau. Đổi điều kiện lọc, tăng LIMIT của Query, hoặc chọn "Báo lỗi và dừng" nếu đây là lỗi.');
  assert.throws(() => runWorkflow(w('error'), { seed: 1, queryResults: { q: rows(ACCS) } }), (e) => e instanceof WorkflowError
    && e.issues[0].nodeId === 'p'
    && e.issues[0].message === 'Bước Chọn bản ghi "acc": không còn bản ghi nào trong "accs" thỏa điều kiện (lần thứ 3). Tăng LIMIT của Query, đổi điều kiện lọc, hoặc chọn cách chọn "Ngẫu nhiên (có thể lặp lại)".');
  // At the top level a skip ends the run (no later steps).
  const top = wf([query('q', 'accs'), pick('p', 'acc', 'accs'), record('c', 'Contact', 'con', [lookup('acc')])]);
  const empty = runWorkflow(top, { seed: 1, queryResults: { q: rows([]) } });
  assert.equal(empty.records.length, 0);
  assert.equal(empty.warnings.filter((x) => x.code === 'pickSkipped').length, 1);
});

test('pick from a record pool keeps $ref', () => {
  const w = wf([
    acc('a', { count: 4 }),
    loop('l', { count: 6 }, [pick('p', 'one', 'acc'), record('c', 'Contact', 'con', [lookup('one'), tplField('Title', 'of {{one.Name}}')])]),
  ]);
  assert.deepEqual(validateWorkflow(w).errors, []);
  const r = runWorkflow(w, { seed: 9, now: NOW });
  const accounts = r.records.filter((x) => x.sobject === 'Account');
  for (const c of r.records.filter((x) => x.sobject === 'Contact')) {
    const parent = accounts.find((x) => x.ref === c.fields.AccountId.$ref);
    assert.ok(parent, 'the Lookup is a $ref to a generated Account');
    assert.equal(c.fields.Title, `of ${parent.fields.Name}`);
  }
});

test('validation: query config errors carry nodeId and field', () => {
  const byField = (w) => Object.fromEntries(errorsOf(w).map((e) => [`${e.nodeId}:${e.field}`, e.message]));
  const builder = byField(wf([query('q', 'accs', { sobject: 'Acc ount', fields: ['Id', 'Owner Name'], where: 'AccountId = {{acc.Id}}', orderBy: 'Id', limit: 5000 })]));
  assert.equal(builder['q:sobject'], 'Chưa nhập sObject hợp lệ (API name).');
  assert.equal(builder['q:fields'], 'Field "Owner Name" không hợp lệ. Dùng API name; field quan hệ viết Owner.Name.');
  assert.equal(builder['q:where'], 'Bước Query không dùng được {{…}}: query chỉ chạy một lần trước khi sinh dữ liệu. Muốn lọc theo bản ghi khác (ví dụ {{acc.Id}}), dùng bộ lọc ở bước Chọn bản ghi.');
  assert.equal(builder['q:limit'], 'Số bản ghi tối đa phải là số nguyên từ 1 đến 2000.');
  const soql = byField(wf([query('q', 'accs', { mode: 'soql', soql: 'UPDATE Account SET Name = 1' })]));
  assert.equal(soql['q:soql'], 'SOQL phải bắt đầu bằng SELECT. Bước Query chỉ đọc dữ liệu.');
  const warned = warningsOf(wf([query('q', 'accs', { mode: 'soql', soql: 'SELECT Name FROM Account' }), pick('p', 'acc', 'accs')])).filter((x) => x.nodeId === 'q').map((x) => x.code);
  assert.deepEqual(warned, ['noOrderBy', 'noId']);
  assert.match(errorsOf(wf([query('q', '')]))[0].message, /^Đặt alias để bước khác dùng được pool này \(ví dụ accs\)\.$/);
  // More than 20 Query steps: an error on the 21st.
  const many = wf(Array.from({ length: 21 }, (_, i) => query(`q${i}`, `p${i}`)));
  const tooMany = errorsOf(many);
  assert.equal(tooMany.length, 1);
  assert.equal(tooMany[0].nodeId, 'q20');
  assert.match(tooMany[0].message, /quá 20 bước Query/);
});

test('validation: pick needs an upstream pool', () => {
  const none = errorsOf(wf([pick('p', 'acc', '')]));
  assert.deepEqual([none[0].field, none[0].message], ['from', 'Chưa chọn pool. Chọn alias của bước Query hoặc Record ở phía trên.']);
  const below = errorsOf(wf([pick('p', 'acc', 'accs'), query('q', 'accs')])).find((x) => x.nodeId === 'p');
  assert.equal(below.field, 'from');
  assert.match(below.message, /^Pool "accs" phải nằm phía trước bước này trong workflow\./);
  const unknown = errorsOf(wf([query('q', 'accs'), pick('p', 'acc', 'acs')])).find((x) => x.nodeId === 'p');
  assert.match(unknown.message, /^Không có bước nào có alias "acs"\. Ý bạn là "accs"\?/);
  const filter = errorsOf(wf([query('q', 'accs'), pick('p', 'acc', 'accs', { filter: 'compare' })]));
  assert.deepEqual(filter.map((e) => [e.field, e.message]), [['filterField', 'Chưa nhập field để lọc, ví dụ AccountId hoặc Account.Type.']]);
  // A loop variable is not a pool.
  assert.ok(errorsOf(wf([loop('l', { count: 1 }, [pick('p', 'acc', 'loop')])])).some((e) => e.nodeId === 'p' && e.field === 'from'));
});

test('validation: template using a field the query does not select is an error (0007)', () => {
  const w = wf([query('q', 'accs', { fields: ['Id', 'Name'] }), pick('p', 'acc', 'accs'), record('c', 'Contact', 'con', [tplField('Title', '{{acc.Industry}} {{acc.Name}} {{acc.Id}}')])]);
  const errors = errorsOf(w);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'fields.Title');
  assert.equal(errors[0].message, 'Field "Title": Template dùng {{acc.Industry}} nhưng Query "accs" không lấy field Industry. Thêm Industry vào "Field cần lấy" của bước Query.');
  // {{accs.Name}} straight on the pool: no current record.
  const direct = errorsOf(wf([query('q', 'accs'), record('c', 'Contact', 'con', [tplField('Title', '{{accs.Name}}')])]));
  assert.equal(direct[0].code, 'noCurrent');
  assert.equal(direct[0].message, 'Field "Title": {{accs.Name}}: "accs" là pool nhiều bản ghi nên không biết lấy bản ghi nào. Thêm bước Chọn bản ghi từ "accs" rồi dùng {{acc.Name}}; {{accs.$count}} thì dùng được.');
});

test('validation: Lookup "current" into a Query pool is an error; a Query nobody uses and a Query in a loop warn', () => {
  const cur = errorsOf(wf([query('q', 'accs'), record('c', 'Contact', 'con', [lookup('accs')])]));
  assert.equal(cur[0].field, 'fields.AccountId');
  assert.equal(cur[0].message, 'Field "AccountId": Query "accs" là một pool nhiều bản ghi, không có "bản ghi hiện tại". Chọn "Ngẫu nhiên trong pool", hoặc thêm bước Chọn bản ghi rồi trỏ Lookup vào alias của nó.');
  const warns = warningsOf(wf([loop('l', { count: 2 }, [query('q', 'accs')])])).filter((x) => x.nodeId === 'q');
  assert.deepEqual(warns.map((x) => x.code), ['queryInLoop', 'poolUnused']);
  assert.equal(warns[1].message, 'Chưa có bước nào dùng pool "accs". Thêm bước Chọn bản ghi, Lặp qua từng bản ghi (menu ⋯), hoặc chọn "accs" ở một field Lookup.'); // 0010 review: names the each-loop too
});

test('validation: aliases are unique across record, query and pick', () => {
  const w = wf([acc('a'), query('q', 'acc'), pick('p', 'acc', 'acc'), loop('l', { alias: 'accs2' }, [query('q2', 'accs2')])]);
  const msgs = errorsOf(w).map((e) => `${e.nodeId}:${e.field}:${e.message}`).join('\n');
  assert.match(msgs, /q:alias:Alias "acc" đã được dùng ở bước khác/);
  assert.match(msgs, /p:alias:Alias "acc" đã được dùng ở bước khác/);
  assert.match(msgs, /l:alias:Tên biến lặp "accs2" trùng alias của một bước Query \(đọc org\)/);
});

test('field type "Lấy từ biến" keeps the value type', () => {
  const w = wf([
    query('q', 'pbes', { sobject: 'PricebookEntry', fields: ['Id', 'UnitPrice'] }),
    pick('p', 'pbe', 'pbes'),
    record('o', 'OpportunityLineItem', 'oli', [{ name: 'UnitPrice', type: 'copy', options: { path: 'pbe.UnitPrice' } }, { name: 'Text', type: 'template', options: { template: '{{pbe.UnitPrice}}' } }, { name: 'N', type: 'copy', options: {} }]),
  ]);
  assert.deepEqual(validateWorkflow(w).errors, []);
  const r = runWorkflow(w, { seed: 1, queryResults: { q: rows([{ Id: '01u1', UnitPrice: 12.5 }], 'PricebookEntry') } });
  assert.deepEqual(r.records[0].fields, { UnitPrice: 12.5, Text: '12.5', N: 1 });
  const bad = errorsOf(wf([record('o', 'Lead', 'ld', [{ name: 'X', type: 'copy', options: { path: 'nope.Y' } }])]));
  assert.equal(bad[0].code, 'unknownName');
});

test('a v2 loop without "count" runs 0 times, which is also the catalogue default the inspector shows', async () => {
  const { nodeTypeMap } = await import('../server/workflow/nodes.js');
  const count = nodeTypeMap.get('loop').options.find((o) => o.key === 'count');
  const max = nodeTypeMap.get('loop').options.find((o) => o.key === 'max');
  const w = wf([{ id: 'l', type: 'loop', config: {}, slots: { body: [acc()] } }, { id: 'r', type: 'loop', config: { mode: 'range', min: 1 }, slots: { body: [record('x', 'Lead', 'ld', [])] } }]);
  const { stats } = runWorkflow(w, { seed: 1 });
  assert.equal(stats.byStep.l.iterations, count.default);
  assert.equal(stats.byStep.r.iterations, max.default, 'range without max runs min..1');
  assert.deepEqual([count.default, count.initial, max.default, max.initial], [0, 3, 1, 5]);
});

// ---------- review fixes (0006 "Sửa sau review") ----------

test('Query field names ignore case: template, hand-written SOQL and the Chọn bản ghi filter', () => {
  const rowsSf = { q: rows([{ Id: '0011', Name: 'Acme', Industry: 'Banking' }, { Id: '0012', Name: 'Globex', Industry: 'Retail' }]) };
  const make = (q, tpl, pickExtra = {}) => wf([{ id: 'q', type: 'query', config: { alias: 'accs', ...q } }, pick('p', 'acc', 'accs', pickExtra), record('c', 'Contact', 'con', [tplField('Title', tpl), lookup('acc')])]);
  for (const w of [
    make({ sobject: 'Account', fields: ['Id', 'name'] }, '{{acc.name}}'),
    make({ mode: 'soql', soql: 'SELECT id, name FROM Account ORDER BY Id' }, '{{acc.Name}}'),
    make({ sobject: 'Account', fields: ['Id', 'Name', 'industry'] }, '{{acc.Name}}', { filter: 'compare', filterField: 'INDUSTRY', filterValue: 'Retail', onEmpty: 'error' }),
  ]) {
    assert.deepEqual(validateWorkflow(w).errors, []);
    const r = runWorkflow(w, { seed: 2, queryResults: rowsSf });
    assert.ok(['Acme', 'Globex'].includes(r.records[0].fields.Title));
    assert.match(r.records[0].fields.AccountId, /^001[12]$/, 'Id found whatever its spelling');
  }
  const filtered = runWorkflow(make({ sobject: 'Account', fields: ['Id', 'Name', 'industry'] }, '{{acc.Name}}', { filter: 'compare', filterField: 'INDUSTRY', filterValue: 'Retail' }), { seed: 2, queryResults: rowsSf });
  assert.equal(filtered.records[0].fields.Title, 'Globex');
  // Generated records stay case-sensitive.
  assert.equal(errorsOf(wf([acc(), record('c', 'Contact', 'con', [tplField('T', '{{acc.name}}')])]))[0].code, 'unknownMember');
});

test('"Lấy từ biến" refuses an object: validation says wholeRecord, the generator throws; wording is not "Template"', () => {
  const make = (path) => wf([
    query('q', 'pbes', { sobject: 'PricebookEntry', fields: ['Id', 'UnitPrice', 'Product2.Name'] }),
    pick('p', 'pbe', 'pbes'),
    record('o', 'OpportunityLineItem', 'oli', [{ name: 'X', type: 'copy', options: { path } }]),
  ]);
  const obj = errorsOf(make('pbe.Product2'))[0];
  assert.equal(obj.code, 'wholeRecord');
  assert.equal(obj.message, 'Field "X": pbe.Product2 là cả một đối tượng (Name), không phải một giá trị; hãy chọn một field con, ví dụ pbe.Product2.Name.');
  assert.deepEqual(errorsOf(make('pbe.Product2.Name')), []);
  assert.equal(errorsOf(make('pbe.Nope'))[0].message, 'Field "X": Biến pbe.Nope cần field Nope nhưng Query "pbes" không lấy field này. Thêm Nope vào "Field cần lấy" của bước Query.');
  // At run time (e.g. through the API without validation of the value's shape) an object is refused too.
  const geo = wf([record('a', 'Account', 'acc', [{ name: 'Loc__c', type: 'geolocation' }]), record('o', 'Lead', 'ld', [{ name: 'X', type: 'copy', options: { path: 'acc.Loc__c.latitude' } }])]);
  assert.equal(typeof runWorkflow(geo, { seed: 1 }).records[1].fields.X, 'number');
  assert.throws(() => copyType.generate({ path: 'acc.Loc__c' }, { scope: { current: { acc: { fields: { Loc__c: { latitude: 1, longitude: 2 } } } }, all: {}, vars: {} }, record: {}, n: 1, fieldName: 'X' }), /là cả một đối tượng/);
});

test('Master-Detail into an empty Query pool names the Query', () => {
  const w = wf([query('q', 'accs'), record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'masterdetail', options: { mode: 'random', ref: 'accs' } }])]);
  assert.throws(() => runWorkflow(w, { seed: 1, queryResults: { q: rows([]) } }), (e) => e.issues[0].nodeId === 'c'
    && e.issues[0].message === 'Field AccountId: Query "accs" không trả về bản ghi nào. Kiểm tra "Điều kiện (WHERE)" của bước Query hoặc chọn org khác.');
});

// ---------- design 0010: Lặp "Mỗi bản ghi trong pool" ----------

const each = (id, from, itemAlias, body = [], extra = {}) => loop(id, { mode: 'each', from, itemAlias, ...extra }, body);
const lk = (name, ref, mode = 'current') => ({ name, type: 'lookup', options: { mode, ref } });
const issuesAt = (list, nodeId, field) => list.filter((i) => i.nodeId === nodeId && i.field === field).map((i) => i.message);
const accRows = (n) => rows(Array.from({ length: n }, (_, i) => ({ Id: `001${String(i + 1).padStart(15, '0')}`, Name: `Org ${i + 1}` })));

test('validation: each loop needs an upstream pool (nodeId + field from)', () => {
  const body = [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: {} }])];
  const at = (w) => issuesAt(errorsOf(w), 'l', 'from');
  assert.deepEqual(at(wf([each('l', '', 'acc', body)])), ['Chưa chọn pool để lặp. Chọn alias của một bước Query, Record hoặc Chọn bản ghi ở phía trên.']);
  assert.deepEqual(at(wf([each('l', 'accs', 'acc', body)])), ['Không có bước nào có alias "accs". Chọn pool khác trong danh sách hoặc thêm bước Query/Record có alias này ở phía trên.']);
  assert.deepEqual(at(wf([each('l', 'accs', 'acc', body), query('q', 'accs')])), ['Pool "accs" nằm sau bước Lặp này nên chưa có bản ghi khi chạy tới đây. Kéo bước "accs" lên phía trên hoặc chọn pool khác.']);
  assert.deepEqual(at(wf([branch('b', {}, [query('q', 'accs')], [each('l', 'accs', 'acc', body)])])), ['Pool "accs" nằm ở nhánh còn lại của bước Rẽ nhánh phía trên nên không chạy cùng lượt với bước này. Đưa "accs" ra trước bước Rẽ nhánh hoặc chọn pool khác.']);
  assert.deepEqual(at(wf([{ ...query('q', 'accs'), disabled: true }, each('l', 'accs', 'acc', body)])), ['Bước "accs" đang tắt. Bật lại bước đó (Ctrl+/) hoặc chọn pool khác.']);
  // The record of another each-loop is not a pool; neither for a Chọn bản ghi.
  const nested = wf([query('q', 'accs'), each('l0', 'accs', 'acc', [each('l', 'acc', 'a2', body, { alias: 'k' }), pick('p', 'pk', 'acc')])]);
  assert.deepEqual(at(nested), ['"acc" là bản ghi đang lặp của bước Lặp phía trên, không phải pool. Chọn pool gốc "accs".']);
  assert.deepEqual(issuesAt(errorsOf(nested), 'p', 'from'), ['"acc" là bản ghi đang lặp, không phải pool. Chọn pool gốc "accs".']);
  // A pool that may not exist is a warning.
  const maybe = wf([branch('b', {}, [query('q', 'accs')]), each('l', 'accs', 'acc', body)]);
  assert.deepEqual(issuesAt(errorsOf(maybe), 'l', 'from'), []);
  assert.deepEqual(issuesAt(warningsOf(maybe), 'l', 'from'), ['Pool "accs" nằm trong một nhánh rẽ hoặc vòng lặp có thể không chạy, nên có lúc vòng lặp này không chạy lần nào.']);
  // Empty body: the existing warning; a clean each-loop has no other issue.
  assert.deepEqual(validateWorkflow(wf([query('q', 'accs'), each('l', 'accs', 'acc', body)])), { errors: [], warnings: [] });
  assert.deepEqual(issuesAt(warningsOf(wf([query('q', 'accs'), each('l', 'accs', 'acc')])), 'l', 'slots.body'), ['Vòng lặp chưa có bước nào. Bấm "+ Thêm bước vào vòng lặp".']);
});

test('validation: each item alias is unique and differs from loop variables', () => {
  const body = [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: {} }])];
  const at = (w) => issuesAt(errorsOf(w), 'l', 'itemAlias');
  assert.deepEqual(at(wf([query('q', 'accs'), each('l', 'accs', '', body)])), ['Đặt tên cho bản ghi đang lặp (ví dụ acc) để các bước bên trong dùng {{acc.Name}}.']);
  assert.deepEqual(at(wf([query('q', 'accs'), each('l', 'accs', '1a', body)])), ['Alias "1a" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").']);
  assert.deepEqual(at(wf([query('q', 'accs'), each('l', 'accs', 'this', body)])), ['Alias "this" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").']);
  // The second owner in reading order gets the error (here the Record inside the body).
  assert.deepEqual(issuesAt(errorsOf(wf([query('q', 'accs'), each('l', 'accs', 'con', body)])), 'c', 'alias'), ['Alias "con" đã được dùng ở bước khác. Đổi alias của một trong hai bước.']);
  assert.deepEqual(at(wf([query('q', 'accs'), each('l', 'accs', 'accs', body)])), ['Alias "accs" đã được dùng ở bước khác. Đổi alias của một trong hai bước.']);
  // Same name as a loop variable (its own, or another loop's): once, on itemAlias.
  const own = errorsOf(wf([query('q', 'accs'), each('l', 'accs', 'loop', body)]));
  assert.deepEqual(own.map((i) => `${i.nodeId}.${i.field}: ${i.message}`), ['l.itemAlias: Tên bản ghi đang lặp "loop" trùng tên biến lặp. Đổi một trong hai tên.']);
  assert.deepEqual(at(wf([query('q', 'accs'), loop('o', { count: 1, alias: 'i' }, [each('l', 'accs', 'i', body)])])), ['Tên bản ghi đang lặp "i" trùng tên biến lặp. Đổi một trong hai tên.']);
  // A turned-off each-loop still owns its name (turning it back on cannot create a clash), but a
  // missing name is not checked.
  assert.deepEqual(issuesAt(errorsOf(wf([query('q', 'accs'), { ...each('l', 'accs', 'con', body), disabled: true }, record('c2', 'Contact', 'con', [])])), 'c2', 'alias'), ['Alias "con" đã được dùng ở bước khác. Đổi alias của một trong hai bước.']);
  assert.deepEqual(errorsOf(wf([query('q', 'accs'), { ...each('l', 'accs', '', body), disabled: true }])), []);
  // Fixed / range: a leftover itemAlias is not in the namespace.
  assert.deepEqual(errorsOf(wf([query('q', 'accs'), loop('l', { count: 1, itemAlias: 'accs', from: 'zzz' }, body)])), []);
});

test('validation: item alias used outside its loop is an error on fields.<Name>', () => {
  const w = wf([
    query('q', 'accs'),
    each('l', 'accs', 'acc', [record('in', 'Contact', 'con', [lk('AccountId', 'acc'), tplField('Title', '{{acc.Name}}')])]),
    record('out', 'Contact', 'con2', [lk('AccountId', 'acc'), tplField('Title', '{{acc.Name}}')]),
  ]);
  const errs = errorsOf(w);
  assert.deepEqual(issuesAt(errs, 'in', 'fields.AccountId').concat(issuesAt(errs, 'in', 'fields.Title')), []);
  assert.deepEqual(issuesAt(errs, 'out', 'fields.AccountId'), ['Field "AccountId": "acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp hoặc chọn bản ghi cha khác.']);
  assert.deepEqual(issuesAt(errs, 'out', 'fields.Title'), ['Field "Title": {{acc.Name}}: "acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp.']);
  assert.ok(errs.filter((i) => i.nodeId === 'out').every((i) => i.code === 'outsideLoop'));
  // A branch `left` too (no field prefix).
  const left = errorsOf(wf([query('q', 'accs'), each('l', 'accs', 'acc', [record('in', 'Contact', 'con', [])]), branch('b', { kind: 'compare', left: 'acc.Name', op: 'eq', right: 'x' }, [record('t', 'Task', 't', [])])]));
  assert.deepEqual(issuesAt(left, 'b', 'left'), ['acc.Name: "acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó. Kéo bước này vào trong vòng lặp.']);
});

test('validation: lookup random on an item alias is an error', () => {
  const w = wf([query('q', 'accs'), each('l', 'accs', 'acc', [record('in', 'Contact', 'con', [lk('AccountId', 'acc', 'random')])])]);
  const errs = errorsOf(w);
  assert.deepEqual(issuesAt(errs, 'in', 'fields.AccountId'), ['Field "AccountId": "acc" là bản ghi đang lặp, không phải pool. Chọn "Bản ghi hiện tại của alias", hoặc chọn pool "accs" nếu muốn ngẫu nhiên.']);
  assert.equal(errs[0].code, 'randomOfItem');
  // Outside the loop the reference is reported once (outsideLoop), not twice.
  const out = errorsOf(wf([query('q', 'accs'), each('l', 'accs', 'acc', [record('in', 'Contact', 'con', [])]), record('x', 'Contact', 'x', [lk('AccountId', 'acc', 'random')])]));
  assert.deepEqual(out.map((i) => i.code), ['outsideLoop']);
});

test('validation: count/min/max are ignored in each mode', () => {
  const body = [record('c', 'Contact', 'con', [])];
  assert.deepEqual(errorsOf(wf([query('q', 'accs'), each('l', 'accs', 'acc', body, { count: -4, min: 9, max: 1 })])), []);
  assert.deepEqual(errorsOf(wf([query('q', 'accs'), loop('l', { mode: 'fixed', count: -4, from: '', itemAlias: '' }, body)])).map((i) => i.field), ['count']);
  assert.deepEqual(errorsOf(wf([loop('l', { mode: 'nope' }, body)])).map((i) => `${i.field}: ${i.message}`), ['mode: Chế độ lặp "nope" không hợp lệ.']);
});

test('each loop runs the body once per record of a record pool, in order', () => {
  const w = wf([
    record('a', 'Account', 'acc', accountFields, { count: 3 }),
    each('l', 'acc', 'a', [record('c', 'Contact', 'con', [lk('AccountId', 'a'), tplField('Title', '{{loop.index}}/{{loop.count}} {{a.Name}} #{{a.$n}}')])]),
  ]);
  const { records, stats } = runWorkflow(w, { seed: 3, now: NOW });
  const accs = records.filter((r) => r.sobject === 'Account');
  const cons = records.filter((r) => r.sobject === 'Contact');
  assert.deepEqual(cons.map((c) => c.fields.AccountId), [{ $ref: 'acc#1' }, { $ref: 'acc#2' }, { $ref: 'acc#3' }]);
  assert.deepEqual(cons.map((c) => c.fields.Title), accs.map((x, i) => `${i + 1}/3 ${x.fields.Name} #${i + 1}`));
  assert.deepEqual(stats.byStep.l, { runs: 1, records: 3, iterations: 3 });
  // Every record made so far, across loop runs (same meaning as Lookup "Ngẫu nhiên trong pool").
  const twice = runWorkflow(wf([loop('o', { count: 2, alias: 'o' }, [record('a', 'Account', 'acc', accountFields, { count: 2 }), each('l', 'acc', 'a', [record('c', 'Contact', 'con', [lk('AccountId', 'a')])])])]), { seed: 1, now: NOW });
  assert.deepEqual(twice.records.filter((r) => r.sobject === 'Contact').map((c) => c.fields.AccountId.$ref), ['acc#1', 'acc#2', 'acc#1', 'acc#2', 'acc#3', 'acc#4']);
  assert.equal(twice.stats.byStep.l.iterations, 6);
});

test('each loop over query rows gives real Ids', () => {
  const w = wf([
    query('q', 'accs', { fields: ['Id', 'Name'] }),
    each('l', 'accs', 'acc', [record('c', 'Contact', 'con', [lk('AccountId', 'acc'), tplField('Title', '{{acc.name}} {{acc.Id}}')], { count: 2 })]),
  ]);
  const { records, stats } = runWorkflow(w, { seed: 1, now: NOW, queryResults: { q: accRows(3) } });
  assert.equal(records.length, 6);
  assert.deepEqual(records.map((r) => r.fields.AccountId), [1, 1, 2, 2, 3, 3].map((i) => `001${String(i).padStart(15, '0')}`));
  assert.equal(records[2].fields.Title, `Org 2 001${'2'.padStart(15, '0')}`);
  assert.equal(stats.byStep.l.iterations, 3);
});

test('each loop over a pick pool and nested each loops', () => {
  // The records a Chọn bản ghi picked (with repeats), in pick order.
  const picks = runWorkflow(wf([
    query('q', 'accs'),
    loop('k', { count: 4 }, [pick('p', 'pk', 'accs', { mode: 'sequential' })]),
    each('l', 'pk', 'it', [record('c', 'Contact', 'con', [lk('AccountId', 'it')])]),
  ]), { seed: 1, now: NOW, queryResults: { q: accRows(3) } });
  assert.deepEqual(picks.records.map((r) => r.fields.AccountId.slice(-1)), ['1', '2', '3', '1']);
  // Nested: every pair (Account × User), inner variable loop2 next to the outer loop.
  const nested = runWorkflow(wf([
    query('q', 'accs'),
    query('u', 'users', { sobject: 'User' }),
    each('l', 'accs', 'acc', [each('l2', 'users', 'user', [record('t', 'Task', 'task', [lk('WhatId', 'acc'), lk('OwnerId', 'user'), tplField('Subject', '{{loop.index}}.{{loop2.index}}/{{loop2.count}}')])], { alias: 'loop2' })]),
  ]), { seed: 1, now: NOW, queryResults: { q: accRows(2), u: rows([{ Id: '005A', Name: 'U1' }, { Id: '005B', Name: 'U2' }, { Id: '005C', Name: 'U3' }], 'User') } });
  assert.deepEqual(nested.records.map((r) => `${r.fields.WhatId.slice(-1)}-${r.fields.OwnerId} ${r.fields.Subject}`), [
    '1-005A 1.1/3', '1-005B 1.2/3', '1-005C 1.3/3', '2-005A 2.1/3', '2-005B 2.2/3', '2-005C 2.3/3',
  ]);
  assert.deepEqual([nested.stats.byStep.l.iterations, nested.stats.byStep.l2.iterations, nested.stats.byStep.l2.runs], [2, 6, 2]);
});

test('each loop draws nothing from the rng', () => {
  const tail = record('z', 'Lead', 'lead', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'N', type: 'number', options: { min: 1, max: 1e9 } }], { count: 5 });
  const base = wf([record('a', 'Account', 'acc', accountFields, { count: 2 }), tail]);
  const withEach = wf([record('a', 'Account', 'acc', accountFields, { count: 2 }), each('l', 'acc', 'a'), each('l2', 'acc', 'b', [], { alias: 'k' }), tail]);
  const leads = (w) => runWorkflow(w, { seed: 11, now: NOW }).records.filter((r) => r.sobject === 'Lead').map((r) => r.fields);
  assert.deepEqual(leads(withEach), leads(base));
  // An empty pool (Query with no rows) draws nothing either.
  const q0 = (w) => runWorkflow(w, { seed: 11, now: NOW, queryResults: { q: rows([]) } }).records.map((r) => r.fields);
  assert.deepEqual(q0(wf([query('q', 'accs'), each('l', 'accs', 'acc', [record('c', 'Contact', 'con', [])]), tail])), q0(wf([query('q', 'accs'), tail])));
});

test('each loop over an empty pool runs 0 times and warns once on from', () => {
  const w = wf([
    query('q', 'accs'),
    loop('o', { count: 3 }, [each('l', 'accs', 'acc', [record('c', 'Contact', 'con', [lk('AccountId', 'acc')])], { alias: 'k' })]),
  ]);
  const r = runWorkflow(w, { seed: 1, now: NOW, queryResults: { q: rows([]) } });
  assert.equal(r.records.length, 0);
  assert.deepEqual(r.stats.byStep.l, { runs: 3, records: 0, iterations: 0 });
  const warns = r.warnings.filter((x) => x.code === 'eachEmpty');
  assert.deepEqual(warns, [{
    message: 'Bước Lặp "acc": pool "accs" không có bản ghi nào nên các bước bên trong không chạy. Kiểm tra bước "accs" (WHERE của Query hoặc số bản ghi).',
    nodeId: 'l', field: 'from', code: 'eachEmpty',
  }]);
  // A pool that never ran (in a branch not taken): 0 iterations too.
  const never = runWorkflow(wf([branch('b', { kind: 'chance', probability: 0 }, [record('a', 'Account', 'acc', [])]), each('l', 'acc', 'a', [record('c', 'Contact', 'con', [])])]), { seed: 1, now: NOW });
  assert.deepEqual([never.records.length, never.stats.byStep.l.iterations, never.warnings.some((x) => x.code === 'eachEmpty')], [0, 0, true]);
});

test('each loop snapshots the pool when it starts', () => {
  // A Chọn bản ghi inside the body adds to its own pool; a second loop over that pool only sees
  // what was there when it started. And records made in the body of a loop over "acc" are not visited.
  const w = wf([
    record('a', 'Account', 'acc', accountFields, { count: 2 }),
    each('l', 'acc', 'x', [record('a2', 'Account', 'acc2', accountFields), pick('p', 'pk', 'acc')]),
    each('l2', 'pk', 'y', [pick('p2', 'pk2', 'acc'), record('c', 'Contact', 'con', [lk('AccountId', 'y')])], { alias: 'k' }),
  ]);
  const r = runWorkflow(w, { seed: 4, now: NOW });
  assert.equal(r.stats.byStep.l.iterations, 2);
  assert.equal(r.stats.byStep.l2.iterations, 2);
  // Record into the pool of the loop itself (same alias as `from`) is refused by validation
  // (pool aliases are unique), so the snapshot only matters for picks and nested loops.
  const grow = wf([record('a', 'Account', 'acc', accountFields, { count: 2 }), pick('p0', 'pk', 'acc'), each('l', 'pk', 'x', [pick('p', 'pk2', 'acc')])]);
  assert.equal(runWorkflow(grow, { seed: 1, now: NOW }).stats.byStep.l.iterations, 1);
});

test('each loop over more than maxCountPerNode records fails on from', () => {
  const w = wf([
    loop('o', { count: 2 }, [record('a', 'Account', 'acc', [], { count: 50001 })]),
    each('l', 'acc', 'a', [record('c', 'Contact', 'con', [])]),
  ], { settings: { maxRecords: 200000 } });
  assert.throws(() => runWorkflow(w, { seed: 1, now: NOW }), (e) => {
    assert.ok(e instanceof WorkflowError);
    assert.deepEqual([e.issues[0].nodeId, e.issues[0].field], ['l', 'from']);
    assert.match(e.issues[0].message, /^Pool "acc" có 100\.002 bản ghi, quá giới hạn 100\.000 lần lặp của một bước Lặp\. Thu hẹp pool \(WHERE\/LIMIT của Query\) hoặc giảm số bản ghi\.$/);
    return true;
  });
});

test('0010 review: alias-less Record ids join the namespace; first error on from; own record as pool', () => {
  const body = [record('c', 'Contact', 'con', [])];
  // N1: a Record without alias is called by its id; an itemAlias / pick alias / loop variable equal to it is an error.
  const noAlias = (extra) => wf([query('q', 'accs'), record('r1', 'Account', '', []), ...extra]);
  assert.deepEqual(issuesAt(errorsOf(noAlias([each('l', 'accs', 'r1', body)])), 'r1', 'alias'), ['Bước này chưa có alias nên được gọi bằng id "r1", trùng tên bản ghi đang lặp của một bước Lặp. Đặt alias cho bước này (ví dụ r1_rec) hoặc đổi tên kia.']);
  assert.deepEqual(issuesAt(errorsOf(noAlias([pick('p', 'r1', 'accs')])), 'r1', 'alias'), ['Bước này chưa có alias nên được gọi bằng id "r1", trùng alias của một bước Chọn bản ghi. Đặt alias cho bước này (ví dụ r1_rec) hoặc đổi tên kia.']);
  assert.deepEqual(issuesAt(errorsOf(noAlias([loop('o', { count: 1, alias: 'r1' }, body)])), 'r1', 'alias'), ['Bước này chưa có alias nên được gọi bằng id "r1", trùng tên một biến lặp. Đặt alias cho bước này (ví dụ r1_rec) hoặc đổi tên kia.']);
  assert.deepEqual(errorsOf(noAlias([each('l', 'accs', 'acc', body)])), []);
  // N3: no pool and no name: only `from` is reported.
  assert.deepEqual(errorsOf(wf([query('q', 'accs'), each('l', '', '', body)])).map((i) => i.field), ['from']);
  // N4: `from` = its own record name: an unknown pool, not "Chọn pool gốc".
  assert.deepEqual(issuesAt(errorsOf(wf([query('q', 'accs'), each('l', 'acc', 'acc', body)])), 'l', 'from'), ['Không có bước nào có alias "acc". Ý bạn là "accs"? Chọn pool khác trong danh sách hoặc thêm bước Query/Record có alias này ở phía trên.']);
});

test('0010 review: a field path is never suggested onto a pool without a current record', () => {
  const [e] = errorsOf(wf([query('q', 'accs'), pick('p', 'pk', 'accs'), record('c', 'Contact', 'con', [tplField('T', '{{acc.Name}}')])]));
  assert.equal(e.code, 'unknownName');
  assert.equal(e.suggestion, undefined, `suggested ${JSON.stringify(e.suggestion)}`);
  assert.doesNotMatch(e.message, /Ý bạn là "accs"/);
  // A pool built-in still gets the hint.
  const [c] = errorsOf(wf([query('q', 'accs'), pick('p', 'pk', 'accs'), record('c', 'Contact', 'con', [tplField('T', '{{acc.$count}}')])]));
  assert.equal(c.suggestion?.to, 'accs.$count');
});

// Design 0012 G: a Record on an sObject without a createable Name (Task, Contact, Case…).
test('a Task record with a Name field warns with a renameField fix', () => {
  const w = wf([
    record('t', 'Task', 'task', [{ name: 'Name', type: 'text', options: { mode: 'name' } }]),
    record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text' }, { name: 'Description', type: 'template', options: { template: '{{task.Name}}' } }]),
  ]);
  const { errors, warnings } = validateWorkflow(w);
  assert.deepEqual(errors, []);
  const [warn] = warnings.filter((x) => x.code === 'noNameField');
  assert.deepEqual(warn, {
    message: 'Task không ghi được field Name nên insert sẽ lỗi. Đổi thành Subject hoặc xóa field này.',
    nodeId: 't',
    field: 'fields.Name',
    code: 'noNameField',
    fix: { kind: 'renameField', stepId: 't', from: 'Name', to: 'Subject' },
  });
  // Contact / Lead: LastName; case of the sObject and field name is ignored.
  const con = warningsOf(wf([record('c', 'contact', 'con', [{ name: 'name', type: 'text' }])])).find((x) => x.code === 'noNameField');
  assert.match(con.message, /^contact không ghi được field Name nên insert sẽ lỗi\. Đổi thành LastName/);
  assert.deepEqual(con.fix, { kind: 'renameField', stepId: 'c', from: 'name', to: 'LastName' });
  // The target already exists: no rename fix, the message says to delete the field.
  const both = warningsOf(wf([record('c', 'Contact', 'con', [{ name: 'Name', type: 'text' }, { name: 'LastName', type: 'text' }])])).find((x) => x.code === 'noNameField');
  assert.equal(both.fix, undefined);
  assert.match(both.message, /Xóa field này \(bước đã có field LastName\)\.$/);
  // Disabled steps are not checked.
  assert.deepEqual(warningsOf(wf([{ ...record('t', 'Task', 'task', [{ name: 'Name', type: 'text' }]), disabled: true }])), []);
});

test('no noNameField warning for Account, Opportunity or a custom sObject', () => {
  for (const sobject of ['Account', 'Opportunity', 'Invoice__c', 'Foo']) {
    const w = wf([record('r', sobject, 'r1', [{ name: 'Name', type: 'text' }])]);
    assert.deepEqual(validateWorkflow(w), { errors: [], warnings: [] }, sobject);
  }
});

// Design 0012 F1: "Thêm <Field> vào SELECT" — the fix names the Query the rows come from.
test('unknownMember of a Query source carries an addSelectField fix', () => {
  const fixOf = (w) => errorsOf(w).find((e) => e.code === 'unknownMember')?.fix;
  const contact = (tpl) => record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text' }, tplField('Title', tpl)]);
  // Through a Chọn bản ghi.
  const viaPick = wf([query('q', 'accs', { fields: ['Id', 'Name'] }), pick('p', 'acc', 'accs'), contact('{{acc.Industry}}')]);
  const issue = errorsOf(viaPick).find((e) => e.code === 'unknownMember');
  assert.equal(issue.field, 'fields.Title');
  assert.deepEqual(issue.fix, { kind: 'addSelectField', stepId: 'q', field: 'Industry' });
  // Through the record a Lặp `each` loops over (0010), and a pick from a pick.
  assert.deepEqual(fixOf(wf([query('q', 'accs'), loop('l', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [contact('{{acc.Industry}}')])])), { kind: 'addSelectField', stepId: 'q', field: 'Industry' });
  assert.deepEqual(fixOf(wf([query('q', 'accs'), pick('p', 'acc', 'accs'), pick('p2', 'acc2', 'acc'), contact('{{acc2.Industry}}')])), { kind: 'addSelectField', stepId: 'q', field: 'Industry' });
  // A path option (branch `left`) gets it too; a relationship sub-field is added as a path.
  const left = errorsOf(wf([query('q', 'accs'), pick('p', 'acc', 'accs'), branch('b', { kind: 'compare', left: 'acc.Type', op: 'eq', right: 'x' }, [contact('x')])])).find((e) => e.code === 'unknownMember');
  assert.deepEqual([left.nodeId, left.field, left.fix], ['b', 'left', { kind: 'addSelectField', stepId: 'q', field: 'Type' }]);
  const owner = errorsOf(wf([query('q', 'accs', { fields: ['Id', 'Owner.Name'] }), pick('p', 'acc', 'accs'), contact('{{acc.Owner.Email}}')])).find((e) => e.code === 'unknownMember');
  assert.deepEqual(owner.fix, { kind: 'addSelectField', stepId: 'q', field: 'Owner.Email' });
  assert.match(owner.message, /không lấy field Owner\.Email\. Thêm Owner\.Email vào/);
  // The whole member path, also when the Query lacks the relationship itself or a deeper level
  // (review: cutting at the first missing level gave "SELECT Id, Name, Owner").
  for (const [fields, path] of [[['Id', 'Name'], 'Owner.Email'], [['Id', 'Owner.Name'], 'Owner.Manager.Email'], [['Id', 'Name'], 'Owner.Manager.Email']]) {
    const e = errorsOf(wf([query('q', 'accs', { fields }), pick('p', 'acc', 'accs'), contact(`{{acc.${path}}}`)])).find((x) => x.code === 'unknownMember');
    assert.deepEqual(e.fix, { kind: 'addSelectField', stepId: 'q', field: path }, `${fields} + ${path}`);
    assert.ok(e.message.includes(`không lấy field ${path}. Thêm ${path} vào`), e.message);
  }
  // A path below a plain field (Name.Foo): nothing to add to the SELECT.
  const plain = errorsOf(wf([query('q', 'accs'), pick('p', 'acc', 'accs'), contact('{{acc.Name.Foo}}')])).find((x) => x.code === 'unknownMember');
  assert.ok(plain && plain.fix === undefined, JSON.stringify(plain));
  // Hand-written SOQL: a fix only when the SELECT list can be edited.
  assert.deepEqual(fixOf(wf([query('q', 'accs', { mode: 'soql', soql: 'SELECT Id, Name FROM Account ORDER BY Id' }), pick('p', 'acc', 'accs'), contact('{{acc.Industry}}')])), { kind: 'addSelectField', stepId: 'q', field: 'Industry' });
  const sub = wf([query('q', 'accs', { mode: 'soql', soql: 'SELECT Id, Name, (SELECT Id FROM Contacts) FROM Account ORDER BY Id' }), pick('p', 'acc', 'accs'), contact('{{acc.Industry}}')]);
  assert.equal(errorsOf(sub).find((e) => e.code === 'unknownMember').fix, undefined);
  // A generated Record pool: no SELECT to fix.
  assert.equal(fixOf(wf([record('a', 'Account', 'acc', [{ name: 'Name', type: 'text' }]), contact('{{acc.Industry}}')])), undefined);
});
