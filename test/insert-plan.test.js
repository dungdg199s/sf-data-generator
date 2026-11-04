// shared/insert-plan.js (design 0011 §1): which Record steps go Bulk, and the API call estimate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInsert, planDelete, BULK_DEFAULTS } from '../shared/insert-plan.js';
import { createRun } from '../server/workflow/executor.js';
import { wf, record, loop, pick, NOW } from './helpers.js';

const accCon = wf([loop('l', { count: 2 }, [
  record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { mode: 'company' } }]),
  loop('m', { count: 4 }, [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])]),
])]);

test('200 000 records of the Account + Contact sample: Account by Collections, Contact by Bulk, 393 calls', () => {
  const { referencedAliases } = createRun(accCon, { seed: 1, now: NOW });
  assert.deepEqual([...referencedAliases], ['acc']);
  const plan = planInsert({
    steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 40000 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 160000 }],
    referenced: referencedAliases,
  });
  assert.deepEqual(plan.steps.map((s) => [s.nodeId, s.mode, s.probe, s.jobs, s.apiCalls]), [['a', 'collections', 0, 0, 200], ['c', 'bulk', 200, 16, 193]]);
  assert.deepEqual(plan.apiCalls, { collections: 201, bulk: 192, total: 393 });
});

test('an alias a Lookup points at through a Chọn bản ghi is never Bulk', () => {
  const w = wf([
    loop('l', { count: 3 }, [record('a', 'Account', 'acc', [{ name: 'Name', type: 'text' }])]),
    loop('m', { count: 3 }, [
      pick('p', 'one', 'acc'),
      record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text' }, { name: 'AccountId', type: 'lookup', options: { ref: 'one' } }]),
    ]),
  ]);
  const { referencedAliases } = createRun(w, { seed: 1, now: NOW });
  assert.ok(referencedAliases.has('acc'));
  const plan = planInsert({ steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 50000 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 50000 }], referenced: referencedAliases });
  assert.deepEqual(plan.steps.map((s) => s.mode), ['collections', 'bulk']);
});

test('under bulkMinRecords, or bulk: off, every step goes by Collections', () => {
  const steps = [{ nodeId: 'c', alias: 'con', sobject: 'Contact', records: 9999 }];
  assert.equal(planInsert({ steps }).steps[0].mode, 'collections');
  assert.equal(planInsert({ steps }).apiCalls.total, 50);
  const big = [{ nodeId: 'c', alias: 'con', sobject: 'Contact', records: 10000 }];
  assert.deepEqual(planInsert({ steps: big }).steps[0], { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 10000, mode: 'bulk', probe: 200, jobs: 1, apiCalls: 13 });
  const off = planInsert({ steps: big, bulk: 'off' });
  assert.equal(off.steps[0].mode, 'collections');
  assert.deepEqual(off.apiCalls, { collections: 50, bulk: 0, total: 50 });
  // limits from /api/meta override the defaults
  assert.equal(planInsert({ steps, limits: { bulkMinRecords: 100 } }).steps[0].mode, 'bulk');
  assert.equal(BULK_DEFAULTS.bulkMinRecords, 10000);
});

test('planDelete: children first, 242 calls for 160 000 Contact + 40 000 Account', () => {
  const plan = planDelete({ steps: [{ nodeId: 'a', sobject: 'Account', remaining: 40000 }, { nodeId: 'c', sobject: 'Contact', remaining: 160000 }, { nodeId: 'x', sobject: 'Lead', remaining: 0 }] });
  assert.deepEqual(plan.steps.map((s) => [s.nodeId, s.mode, s.jobs]), [['c', 'bulk', 16], ['a', 'bulk', 4]]);
  assert.deepEqual(plan.apiCalls, { collections: 2, bulk: 240, total: 242 });
  assert.equal(planDelete({ steps: [{ nodeId: 'a', sobject: 'Account', remaining: 40000 }], bulk: 'off' }).apiCalls.total, 200);
});
