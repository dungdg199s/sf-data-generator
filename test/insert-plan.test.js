// shared/insert-plan.js (design 0011): which Record steps go through Bulk API 2.0, API call estimates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInsert, planDelete } from '../shared/insert-plan.js';
import { poolUsage } from '../shared/scope.js';
import { scopeCatalog } from '../server/workflow/schema.js';
import { wf, record, loop, pick, query } from './helpers.js';
import { LIMITS } from '../server/workflow/nodes.js';

const accCon = [
  { nodeId: 'acc', alias: 'acc', sobject: 'Account', records: 40000 },
  { nodeId: 'con', alias: 'con', sobject: 'Contact', records: 160000 },
];

test('Account + Contact 200 000: Contact (leaf) goes Bulk, Account (Lookup target) does not; 393 calls', () => {
  const p = planInsert({ steps: accCon, referenced: new Set(['acc']), limits: LIMITS });
  assert.deepEqual(p.steps.map((s) => [s.nodeId, s.mode, s.probe, s.jobs]), [['acc', 'collections', 0, 0], ['con', 'bulk', 200, 16]]);
  assert.deepEqual(p.apiCalls, { collections: 201, bulk: 192, total: 393 });
});

test('below bulkMinRecords, bulk off, and an alias reached through Chọn bản ghi never go Bulk', () => {
  const small = planInsert({ steps: [{ nodeId: 'a', alias: 'a', sobject: 'Account', records: 9999 }], referenced: [], limits: LIMITS });
  assert.equal(small.steps[0].mode, 'collections');
  assert.equal(small.apiCalls.total, 50);
  assert.equal(planInsert({ steps: [{ nodeId: 'a', alias: 'a', sobject: 'Account', records: 10000 }], referenced: [] }).steps[0].mode, 'bulk');
  const off = planInsert({ steps: accCon, referenced: ['acc'], bulk: 'off' });
  assert.ok(off.steps.every((s) => s.mode === 'collections'));
  assert.equal(off.apiCalls.total, 1000);
  // A Lookup to a picked record needs the Ids of the pool behind the pick (poolUsage follows it).
  const w = wf([
    record('a', 'Account', 'acc', [], { count: 20000 }),
    loop('l', { count: 20000 }, [pick('p', 'one', 'acc'), record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'one' } }])]),
  ], { settings: { maxRecords: 200000 } });
  const { referenced } = poolUsage(w, scopeCatalog());
  const p = planInsert({ steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 20000 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 20000 }], referenced });
  assert.deepEqual(p.steps.map((s) => s.mode), ['collections', 'bulk']);
  // A Query pool is never inserted, so it plays no role here; just make sure referenced handles it.
  assert.ok(!poolUsage(wf([query('q', 'accs')]), scopeCatalog()).referenced.has('con'));
});

test('delete plan: Bulk for every step with enough Ids; 242 calls for Contact 160 000 + Account 40 000', () => {
  const p = planDelete({ groups: [{ sobject: 'Contact', count: 160000 }, { sobject: 'Account', count: 40000 }], limits: LIMITS });
  assert.deepEqual(p.groups.map((g) => [g.mode, g.jobs]), [['bulk', 16], ['bulk', 4]]);
  assert.deepEqual(p.apiCalls, { collections: 2, bulk: 240, total: 242 });
  assert.equal(planDelete({ groups: [{ sobject: 'Contact', count: 600 }], bulk: 'off' }).apiCalls.total, 3);
});
