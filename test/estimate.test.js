// Design 0012 H: record-count estimate before a run (shared/estimate.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSteps } from '../shared/estimate.js';
import { NODE_TYPES, LIMITS } from '../server/workflow/nodes.js';
import { SAMPLES } from '../client/js/samples.js';
import { runWorkflow } from '../server/workflow/executor.js';
import { wf, record, loop, branch, query, pick, NOW } from './helpers.js';

const catalog = { nodeTypes: NODE_TYPES };
const est = (w, opts) => estimateSteps(w, catalog, { limits: LIMITS, ...opts });
const r = (id, alias = id, extra) => record(id, 'Account', alias, [{ name: 'Name', type: 'text', options: {} }], extra);

test('nested fixed loops multiply exactly (3 × 4 = 12)', () => {
  const { byStep, total } = est(wf([loop('a', { count: 3 }, [loop('b', { count: 4, alias: 'j' }, [r('x')])])]));
  assert.deepEqual(byStep.x, { exp: 12, min: 12, max: 12, exact: true });
  assert.deepEqual(total, { exp: 12, min: 12, max: 12, exact: true });
});

test('a range loop gives the mean and the bounds, not exact; max < min runs min times', () => {
  assert.deepEqual(est(wf([loop('a', { mode: 'range', min: 1, max: 4 }, [r('x', 'x', { count: 2 })])])).byStep.x, { exp: 5, min: 2, max: 8, exact: false });
  assert.deepEqual(est(wf([loop('a', { mode: 'range', min: 3, max: 1 }, [r('x')])])).byStep.x, { exp: 3, min: 3, max: 3, exact: true });
});

test('a chance branch of 0.3 splits the expected value; compare is 50 %', () => {
  const { byStep } = est(wf([loop('a', { count: 10 }, [branch('b', { kind: 'chance', probability: 0.3 }, [r('yes')], [r('no')])])]));
  assert.equal(byStep.yes.exp, 3);
  assert.equal(byStep.no.exp, 7);
  assert.deepEqual([byStep.yes.min, byStep.yes.max, byStep.yes.exact], [0, 10, false]);
  const cmp = est(wf([loop('a', { count: 10 }, [branch('b', { kind: 'compare', left: 'loop.index', op: 'gt', right: '5' }, [r('yes')])])]));
  assert.equal(cmp.byStep.yes.exp, 5);
});

test('Lặp each over a Record pool: the records estimated above', () => {
  const { byStep } = est(wf([r('acc', 'acc', { count: 5 }), loop('l', { mode: 'each', from: 'acc', itemAlias: 'a1' }, [record('c', 'Contact', 'con', [])])]));
  assert.deepEqual(byStep.c, { exp: 5, min: 5, max: 5, exact: true });
});

test('Lặp each over a pool that grows in the same outer loop: the average size seen, not exact', () => {
  // 5 × [acc, each acc → con]: the pool holds 1, 2, … 5 Accounts ⇒ 15 Contacts.
  const w = wf([loop('o', { count: 5, alias: 'o' }, [r('acc'), loop('e', { mode: 'each', from: 'acc', itemAlias: 'a1' }, [record('c', 'Contact', 'con', [])])])]);
  const e = est(w).byStep.c;
  assert.equal(e.exp, 15);
  assert.equal(e.exact, false);
  assert.equal(runWorkflow(w, { seed: 1, now: NOW }).stats.byStep.c.records, 15);
});

test('Lặp each over a Query: rows of the last read, else its LIMIT (inexact); filter and limit', () => {
  const w = (extra = {}) => wf([query('q', 'accs', { limit: 50 }), loop('l', { mode: 'each', from: 'accs', itemAlias: 'acc', ...extra }, [record('c', 'Contact', 'con', [], { count: 2 })])]);
  assert.deepEqual(est(w()).byStep.c, { exp: 100, min: 0, max: 100, exact: false });
  assert.deepEqual(est(w(), { queryCounts: { q: 7 } }).byStep.c, { exp: 14, min: 14, max: 14, exact: true });
  // Design 0013: a filter makes the expected value unknown (at most the pool); a limit caps it.
  const filtered = est(w({ filter: 'compare', filterField: 'Industry', filterValue: 'Banking' }), { queryCounts: { q: 7 } });
  assert.deepEqual(filtered.byStep.c, { exp: null, min: 0, max: 14, exact: false });
  assert.equal(filtered.unknown, true);
  assert.deepEqual(est(w({ limit: 3 }), { queryCounts: { q: 7 } }).byStep.c, { exp: 6, min: 6, max: 6, exact: true });
  // Hand-written SOQL: its LIMIT.
  const soql = wf([query('q', 'accs', { mode: 'soql', soql: 'SELECT Id FROM Account ORDER BY Id LIMIT 30' }), loop('l', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [record('c', 'Contact', 'con', [])])]);
  assert.equal(est(soql).byStep.c.exp, 30);
});

test('0013 loops: values (exact), a number variable (unknown, {{pool.$count}} known), canSkip after a Chọn bản ghi', () => {
  assert.deepEqual(est(wf([loop('l', { mode: 'values', values: ['Hot', 'Warm', 'Cold'] }, [r('x')])])).byStep.x, { exp: 3, min: 3, max: 3, exact: true });
  const v = est(wf([r('acc'), loop('l', { count: '{{acc.NumberOfEmployees}}' }, [r('x')])]));
  assert.deepEqual(v.byStep.x, { exp: null, min: 0, max: null, exact: false });
  assert.equal(v.unknown, true);
  assert.equal(est(wf([query('q', 'accs', { limit: 20 }), loop('l', { count: '{{accs.$count}}' }, [r('x')])]), { queryCounts: { q: 4 } }).byStep.x.exp, 4);
  // A Chọn bản ghi "Bỏ qua" may end the loop body: what follows it there is not certain; after the loop it is.
  const s = est(wf([query('q', 'accs'), loop('l', { count: 3 }, [pick('p', 'acc', 'accs'), r('x')]), r('after')]));
  assert.deepEqual(s.byStep.x, { exp: 3, min: 0, max: 3, exact: false });
  assert.deepEqual(s.byStep.after, { exp: 1, min: 1, max: 1, exact: true });
  const err = est(wf([query('q', 'accs'), loop('l', { count: 3 }, [pick('p', 'acc', 'accs', { onEmpty: 'error' }), r('x')])]));
  assert.equal(err.byStep.x.exact, true);
});

test('turned-off steps are not estimated; a huge workflow goes over maxRecordsHard', () => {
  const { byStep, total } = est(wf([{ ...r('a'), disabled: true }, { ...loop('l', { count: 3 }, [r('b')]), disabled: true }, r('c')]));
  assert.deepEqual(Object.keys(byStep), ['c']);
  assert.equal(total.exp, 1);
  const big = est(wf([loop('a', { count: 1000 }, [loop('b', { count: 1000, alias: 'j' }, [r('x')])])]));
  assert.ok(big.total.exp > LIMITS.maxRecordsHard);
});

test('the "Account + Contact" sample: 5 Account, ≈ 12.5 Contact; estimates of fixed workflows match a run', () => {
  const { byStep, total } = est(SAMPLES[0].workflow);
  assert.deepEqual(byStep.acc, { exp: 5, min: 5, max: 5, exact: true });
  assert.deepEqual(byStep.con, { exp: 12.5, min: 5, max: 20, exact: false });
  assert.equal(total.exp, 17.5);
  const w = wf([loop('a', { count: 3 }, [r('x', 'x', { count: 2 }), loop('b', { mode: 'values', values: ['A', 'B'], alias: 'j' }, [r('y')])])]);
  const e = est(w);
  const run = runWorkflow(w, { seed: 1, now: NOW }).stats.byStep;
  assert.deepEqual([e.byStep.x.exp, e.byStep.y.exp], [run.x.records, run.y.records]);
});
