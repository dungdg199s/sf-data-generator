import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../server/workflow/executor.js';
import { validateWorkflow, WorkflowError } from '../server/workflow/schema.js';
import { wf, edge, record, NOW } from './helpers.js';

const accountFields = [{ name: 'Name', type: 'text', options: { mode: 'company' } }];
const contactFields = (ref = 'acc') => [
  { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
  { name: 'AccountId', type: 'lookup', options: { mode: 'current', ref } },
  { name: 'Title', type: 'template', options: { template: '{{acc.Name}} #{{loop.index}}' } },
];

function accountsWithContacts(accounts = 2, contacts = 3) {
  return wf(
    [
      { id: 'outer', type: 'loop', config: { count: accounts, alias: 'outer' } },
      record('a', 'Account', 'acc', accountFields),
      { id: 'inner', type: 'loop', config: { count: contacts } },
      record('c', 'Contact', 'con', contactFields()),
    ],
    [edge('start', 'outer'), edge('outer', 'a', 'body'), edge('a', 'inner'), edge('inner', 'c', 'body')],
  );
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

test('record count and done port', () => {
  const w = wf(
    [record('a', 'Account', 'acc', accountFields, { count: 5 }), { id: 'l', type: 'loop', config: { count: 0 } }, record('b', 'Lead', 'ld', [], { count: 2 })],
    [edge('start', 'a'), edge('a', 'l'), edge('l', 'b', 'done')],
  );
  assert.deepEqual(runWorkflow(w, { seed: 1 }).stats.bySobject, { Account: 5, Lead: 2 });
});

test('branch compare on loop index', () => {
  const w = wf(
    [
      { id: 'l', type: 'loop', config: { count: 10 } },
      { id: 'b', type: 'branch', config: { kind: 'compare', left: 'loop.index', op: 'divisibleBy', right: '2' } },
      record('even', 'Account', 'ev', accountFields),
      record('odd', 'Lead', 'od', []),
    ],
    [edge('start', 'l'), edge('l', 'b', 'body'), edge('b', 'even', 'true'), edge('b', 'odd', 'false')],
  );
  assert.deepEqual(runWorkflow(w, { seed: 1 }).stats.bySobject, { Lead: 5, Account: 5 });
});

test('validation: lookup must point at an upstream record node', () => {
  const w = wf(
    [record('c', 'Contact', 'con', contactFields('acc')), record('a', 'Account', 'acc', accountFields)],
    [edge('start', 'c'), edge('c', 'a')],
  );
  const { errors } = validateWorkflow(w);
  assert.ok(errors.some((e) => e.nodeId === 'c' && e.field === 'fields.AccountId' && /phía trước/.test(e.message)));
});

test('validation: cycles, duplicate aliases, port fan-out', () => {
  const w = wf(
    [record('a', 'Account', 'x', accountFields), record('b', 'Account', 'x', accountFields), record('c', 'Account', 'y', accountFields)],
    [edge('start', 'a'), edge('a', 'b'), edge('a', 'c'), edge('b', 'a')],
  );
  const messages = validateWorkflow(w).errors.map((e) => e.message).join('\n');
  assert.match(messages, /vòng lặp/);
  assert.match(messages, /Alias "x" đã được dùng/);
  assert.match(messages, /chỉ được nối tới một node/);
});

test('validation: unreachable node is a warning, not an error', () => {
  const w = wf([record('a', 'Account', 'acc', accountFields), record('z', 'Lead', 'ld', [])], [edge('start', 'a')]);
  const { errors, warnings } = validateWorkflow(w);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((x) => x.nodeId === 'z'));
});

test('maxRecords guard raises a WorkflowError tied to the node', () => {
  const w = wf([record('a', 'Account', 'acc', accountFields, { count: 50 })], [edge('start', 'a')]);
  assert.throws(
    () => runWorkflow(w, { maxRecords: 10 }),
    (e) => e instanceof WorkflowError && e.issues[0].nodeId === 'a',
  );
});
