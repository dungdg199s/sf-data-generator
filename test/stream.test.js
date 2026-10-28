// Design 0004: the executor streams records from a synchronous generator. These tests pin the
// data to the collect-everything executor it replaced (golden hashes recorded before the change)
// and check the streaming contract: order, determinism, early stop, count-only pools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWorkflow, createRun } from '../server/workflow/executor.js';
import { WorkflowError, scopeCatalog } from '../server/workflow/schema.js';
import { poolUsage } from '../shared/scope.js';
import { wf, record, loop, branch, pick, NOW } from './helpers.js';
import { GOLDEN_CASES, GOLDEN_SEEDS, GOLDEN_NOW } from './fixtures/golden-cases.js';
import { goldenInputs, hash, goldenKey } from './fixtures/golden-record.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/golden-hashes.json', import.meta.url), 'utf8'));

test('golden: samples and nested cases give the same records as before streaming', async () => {
  assert.equal(Object.keys(GOLDEN).length, GOLDEN_CASES.length * GOLDEN_SEEDS.length);
  for (const c of GOLDEN_CASES) {
    for (const seed of GOLDEN_SEEDS) {
      const key = goldenKey(c, seed);
      const r = runWorkflow(c.workflow, { seed, now: GOLDEN_NOW, queryResults: await goldenInputs(c) });
      assert.equal(r.records.length, GOLDEN[key].count, key);
      assert.equal(hash(r.records), GOLDEN[key].records, key);
      assert.equal(hash(r.stats.byStep), GOLDEN[key].byStep, key);
    }
  }
});

// ---------- executor as a generator ----------


const nested = GOLDEN_CASES.find((c) => c.name.startsWith('random lookups')).workflow;
const collect = (it) => {
  const out = [];
  let s;
  while (!(s = it.next()).done) out.push(s.value);
  return { records: out, end: s.value };
};

test('records() yields the same sequence as runWorkflow, parents before children', () => {
  const run = createRun(nested, { seed: 42, now: NOW });
  const { records, end } = collect(run.records());
  const all = runWorkflow(nested, { seed: 42, now: NOW });
  assert.deepEqual(records, all.records);
  assert.deepEqual(end.stats.byStep, all.stats.byStep);
  assert.equal(all.now, NOW);
  // Every $ref points at a record yielded earlier.
  const seen = new Set();
  for (const r of records) {
    for (const v of Object.values(r.fields)) if (v?.$ref) assert.ok(seen.has(v.$ref), `${r.ref} → ${v.$ref} before its parent`);
    seen.add(r.ref);
  }
});

test('records() twice with the same seed and now is identical; stopping early leaves no state behind', () => {
  const run = createRun(nested, { seed: 7, now: NOW });
  const first = collect(run.records()).records;
  const partial = run.records();
  for (let i = 0; i < 5; i++) partial.next();
  partial.return();
  assert.equal(partial.next().done, true, 'a returned generator stays done');
  assert.deepEqual(collect(run.records()).records, first);
});

test('live counters follow the stream (progress events)', () => {
  const run = createRun(wf([record('a', 'Account', 'acc', [], { count: 3 }), record('c', 'Contact', 'con', [], { count: 2 })]), { seed: 1 });
  const it = run.records();
  it.next();
  it.next();
  assert.deepEqual([it.live.total, it.live.bySobject], [2, { Account: 2 }]);
  collect(it);
  assert.deepEqual([it.live.total, it.live.bySobject], [5, { Account: 3, Contact: 2 }]);
});

test('byStep counts runs, records, loop iterations and branch sides', () => {
  const w = wf([loop('l', { count: 4 }, [branch('b', { kind: 'compare', left: 'loop.index', op: 'lte', right: '1' }, [record('t', 'Account', 't')], [record('f', 'Lead', 'f', [], { count: 2 })])])]);
  const { end } = collect(createRun(w, { seed: 1 }).records());
  assert.deepEqual(end.stats.byStep, {
    l: { runs: 1, records: 7, iterations: 4 },
    b: { runs: 4, records: 7, true: 1, false: 3 },
    t: { runs: 1, records: 1 },
    f: { runs: 3, records: 6 },
  });
});

test('maxRecords error still carries nodeId when streaming (thrown by next(), after the records before it)', () => {
  const run = createRun(wf([record('a', 'Account', 'acc', [], { count: 50 })]), { seed: 1, maxRecords: 10 });
  const it = run.records();
  let n = 0;
  assert.throws(() => { for (;;) { if (it.next().done) break; n++; } }, (e) => e instanceof WorkflowError && e.issues[0].nodeId === 'a');
  assert.equal(n, 10);
});

test('memory: a pool nobody reads whole records of only counts; a Chọn bản ghi `from` keeps records', () => {
  const w = wf([
    record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: {} }], { count: 50 }),
    record('o', 'Opportunity', 'opp', [{ name: 'AccountId', type: 'lookup', options: { mode: 'random', ref: 'acc' } }], { count: 5 }),
    record('k', 'Account', 'kept', [{ name: 'Name', type: 'text', options: {} }], { count: 4 }),
    loop('l', { count: 3 }, [pick('p', 'pk', 'kept'), record('c', 'Contact', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'pk' } }])]),
  ]);
  const run = createRun(w, { seed: 3 });
  assert.deepEqual([...run.keptPools], ['kept']);
  // Ids to keep while inserting: Lookup targets, and the pool behind a picked record.
  assert.deepEqual([...run.referencedAliases].sort(), ['acc', 'kept', 'pk']);
  const it = run.records();
  const { records } = collect(it);
  assert.ok(!Array.isArray(it.pools.acc), 'acc keeps no records');
  assert.deepEqual([it.pools.acc.kind, it.pools.acc.length, it.pools.acc.refAt(49)], ['generated', 50, 'acc#50']);
  assert.ok(!Array.isArray(it.pools.con));
  assert.ok(Array.isArray(it.pools.kept) && it.pools.kept.length === 4 && it.pools.kept[0].fields.Name !== undefined);
  assert.ok(Array.isArray(it.pools.pk) && it.pools.pk.length === 3);
  assert.ok(records.filter((r) => r.sobject === 'Opportunity').every((r) => /^acc#\d+$/.test(r.fields.AccountId.$ref)));
  assert.ok(records.filter((r) => r.sobject === 'Contact').every((r) => /^kept#[1-4]$/.test(r.fields.AccountId.$ref)));
});

test('poolUsage is generic: any step option `kind: ref` accepting pools reads whole records (e.g. a Lặp over each record)', () => {
  const base = scopeCatalog();
  const eachLoop = {
    type: 'loop',
    slots: [{ key: 'body' }],
    flow: { kind: 'loop', body: 'body' },
    exposes: { kind: 'vars', name: { key: 'alias', default: 'loop' }, visibleIn: { inside: 'body' }, members: [] },
    options: [{ key: 'mode', kind: 'select', default: 'fixed' }, { key: 'from', kind: 'ref', default: '', accepts: { pool: true }, showIf: { key: 'mode', in: ['each'] } }],
  };
  const catalog = { ...base, nodeTypes: [...base.nodeTypes.filter((t) => t.type !== 'loop'), eachLoop] };
  const w = wf([record('a', 'Account', 'acc'), record('b', 'Account', 'other'), loop('l', { mode: 'each', from: 'acc' }, []), loop('m', { mode: 'fixed', from: 'other' }, [])]);
  assert.deepEqual([...poolUsage(w, catalog).readers], ['acc'], 'hidden (showIf) options do not count');
  const off = wf([record('a', 'Account', 'acc'), { ...pick('p', 'pa', 'acc'), disabled: true }]);
  assert.deepEqual([...poolUsage(off, base).readers], [], 'turned-off steps do not count');
});
