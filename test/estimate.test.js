// Record-count estimate before running (design 0012 H): shared/estimate.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSteps } from '../shared/estimate.js';
import { NODE_TYPES, LIMITS } from '../server/workflow/nodes.js';
import { runWorkflow } from '../server/workflow/executor.js';
import { SAMPLES } from '../client/js/samples.js';
import { wf, record, loop, branch, query, pick, NOW } from './helpers.js';

const CATALOG = { nodeTypes: NODE_TYPES, limits: LIMITS };
const est = (w, opts) => estimateSteps(w, CATALOG, opts);

test('nested fixed loops multiply exactly (3 × 4 = 12) and match the run', () => {
  const w = wf([loop('l1', { count: 3 }, [loop('l2', { count: 4, alias: 'loop2' }, [record('r', 'Account', 'acc', [], { count: 1 })])])]);
  const { byStep, total } = est(w);
  assert.deepEqual(byStep.r, { records: 12, min: 12, max: 12, exact: true });
  assert.equal(byStep.l2.iterations, 12);
  assert.equal(byStep.l1.records, 12);
  assert.deepEqual(total, { records: 12, min: 12, max: 12, exact: true });
  assert.equal(runWorkflow(w, { seed: 1, now: NOW }).stats.byStep.r.records, 12);
});

test('a range loop gives the mean, the range, and is not exact', () => {
  const { byStep } = est(wf([loop('l', { mode: 'range', min: 1, max: 4 }, [record('r', 'Contact', 'con', [], { count: 2 })])]));
  assert.deepEqual(byStep.r, { records: 5, min: 2, max: 8, exact: false });
  // min = max is a fixed count.
  assert.equal(est(wf([loop('l', { mode: 'range', min: 3, max: 3 }, [record('r', 'Contact', 'con')])])).byStep.r.exact, true);
});

test('a chance branch splits by probability (0.3); compare is 50 %', () => {
  const w = wf([loop('l', { count: 10 }, [branch('b', { kind: 'chance', probability: 0.3 }, [record('y', 'Account', 'a')], [record('n', 'Lead', 'ld')])])]);
  const { byStep, total } = est(w);
  assert.equal(byStep.y.records, 3);
  assert.equal(byStep.n.records, 7);
  assert.deepEqual([byStep.y.min, byStep.y.max, byStep.y.exact], [0, 10, false]);
  assert.equal(total.records, 10);
  const cmp = est(wf([branch('b', { kind: 'compare', left: 'x', op: 'eq', right: '1' }, [record('y', 'Account', 'a', [], { count: 4 })])]));
  assert.deepEqual(cmp.byStep.y, { records: 2, min: 0, max: 4, exact: false });
  // Probability 1: always the true branch, exact.
  assert.equal(est(wf([branch('b', { probability: 1 }, [record('y', 'Account', 'a')])])).byStep.y.exact, true);
});

test('a Lặp each runs once per record of a Record pool above (exact) and of a Query (rows read, else LIMIT)', () => {
  const w = wf([
    loop('l0', { count: 2 }, [record('a', 'Account', 'accs', [], { count: 3 })]),
    loop('e', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [record('c', 'Contact', 'con', [], { count: 2 })]),
  ]);
  const { byStep } = est(w);
  assert.equal(byStep.e.iterations, 6);
  assert.deepEqual(byStep.c, { records: 12, min: 12, max: 12, exact: true });
  assert.equal(runWorkflow(w, { seed: 1, now: NOW }).stats.byStep.c.records, 12);

  const q = wf([query('q', 'qs', { limit: 50 }), loop('e', { mode: 'each', from: 'qs', itemAlias: 'q1' }, [record('c', 'Contact', 'con')])]);
  assert.deepEqual(est(q).byStep.c, { records: 50, min: 0, max: 50, exact: false });
  assert.deepEqual(est(q, { queryCounts: { q: 7 } }).byStep.c, { records: 7, min: 7, max: 7, exact: true });
  // SOQL: its LIMIT.
  const soql = wf([query('q', 'qs', { mode: 'soql', soql: 'SELECT Id FROM Account ORDER BY Id LIMIT 30' }), loop('e', { mode: 'each', from: 'qs', itemAlias: 'q1' }, [record('c', 'Contact', 'con')])]);
  assert.equal(est(soql).byStep.c.records, 30);
  // A pick pool holds one record per pick.
  const p = wf([query('q', 'qs'), loop('l', { count: 4 }, [pick('p', 'acc', 'qs')]), loop('e', { mode: 'each', from: 'acc', itemAlias: 'x' }, [record('c', 'Contact', 'con')])]);
  assert.deepEqual(est(p).byStep.c, { records: 4, min: 4, max: 4, exact: true });
  // A pool that grows inside a loop repeating the Lặp each: not exact.
  const grow = wf([loop('l', { count: 3 }, [record('a', 'Account', 'accs', [], { count: 2 }), loop('e', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [record('c', 'Contact', 'con')])])]);
  assert.equal(est(grow).byStep.c.exact, false);
});

test('turned-off steps (and their children) are skipped; Query and pick generate nothing', () => {
  const off = loop('l', { count: 5 }, [record('in', 'Account', 'a')]);
  off.disabled = true;
  const { byStep, total } = est(wf([off, record('r', 'Lead', 'ld', [], { count: 2 }), query('q', 'qs'), pick('p', 'x', 'qs')]));
  assert.equal(byStep.l, undefined);
  assert.equal(byStep.in, undefined);
  assert.equal(byStep.q.records, 0);
  assert.equal(byStep.p.records, 0);
  assert.equal(total.records, 2);
});

test('large estimates keep their size (over maxRecordsHard)', () => {
  const { total } = est(wf([loop('l1', { count: 1000 }, [loop('l2', { count: 1000, alias: 'loop2' }, [record('r', 'Account', 'acc')])])]));
  assert.equal(total.records, 1_000_000);
  assert.ok(total.records > LIMITS.maxRecordsHard);
});

test('the "Account + Contact" sample: 5 Accounts, ≈ 12.5 Contacts', () => {
  const { byStep, total } = est(SAMPLES.find((s) => s.label === 'Account + Contact').workflow);
  assert.deepEqual(byStep.acc, { records: 5, min: 5, max: 5, exact: true });
  assert.deepEqual(byStep.con, { records: 12.5, min: 5, max: 20, exact: false });
  assert.equal(total.records, 17.5);
});

test('missing options take the catalogue defaults; empty workflow is zero', () => {
  // Record count default 1; Lặp mode default fixed, count default 0.
  const { byStep } = est(wf([record('r', 'Account', 'acc'), loop('l', {}, [record('c', 'Contact', 'con')])]));
  assert.equal(byStep.r.records, 1);
  assert.equal(byStep.c.records, 0);
  assert.deepEqual(est(wf([])).total, { records: 0, min: 0, max: 0, exact: true });
  assert.deepEqual(est(null).total, { records: 0, min: 0, max: 0, exact: true });
});
