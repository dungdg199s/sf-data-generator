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

test('validation: a parent that may not have run is a warning (lookup) with master-detail wording', () => {
  const inBranch = wf([branch('b', {}, [acc()], []), record('c', 'Contact', 'con', [lookup('acc')])]);
  assert.deepEqual(errorsOf(inBranch), []);
  assert.match(warningsOf(inBranch).find((x) => x.nodeId === 'c').message, /có lúc field này sẽ trống/);
  const zeroLoop = wf([loop('l', { mode: 'range', min: 0, max: 3 }, [acc()]), record('c', 'Contact', 'con', [lookup('acc', 'current', 'masterdetail')])]);
  const w = warningsOf(zeroLoop).find((x) => x.nodeId === 'c');
  assert.equal(w.field, 'fields.AccountId');
  assert.match(w.message, /lần chạy sẽ báo lỗi/);
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
