// Design 0003 step 2: migration v1 → v2. Structured graphs must produce byte-identical
// records (frozen v1 runner vs the tree executor); unstructured ones are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateV1, describeReport, reportIsEmpty } from '../shared/migrate-v1.js';
import { allSteps } from '../shared/workflow-tree.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';
import { STRUCTURED, W, rec, E } from './fixtures/v1-cases.js';

const shape = (steps) => steps.map((s) => `${s.id}${s.disabled ? '(off)' : ''}${s.slots ? `{${Object.values(s.slots).map(shape).join('|')}}` : ''}`).join(',');

test('migration: samples become the expected trees with an empty report', () => {
  const a = migrateV1(V1_SAMPLES[0].workflow);
  assert.equal(a.workflow.version, 2);
  assert.equal(shape(a.workflow.steps), 'loopAcc{acc,loopCon{con}}');
  assert.ok(reportIsEmpty(a.report));
  assert.equal(a.workflow.name, 'Account + Contact');
  assert.equal('nodes' in a.workflow || 'edges' in a.workflow, false);
  assert.equal(JSON.stringify(a.workflow).includes('position'), false);
  const b = migrateV1(V1_SAMPLES[1].workflow);
  assert.equal(shape(b.workflow.steps), 'loop{lead,hot{task|}}');
});

test('migration: merge points become the step after the branch', () => {
  assert.equal(shape(migrateV1(STRUCTURED.mergeAfterBranch).workflow.steps), 'l{b{a|},x},y');
  assert.equal(shape(migrateV1(STRUCTURED.nestedBranchMerge).workflow.steps), 'l{b1{a|b2{c|}},j}');
  assert.equal(shape(migrateV1(STRUCTURED.loopInBranchThenMerge).workflow.steps), 'o{b{l{a}|},x}');
  for (const w of Object.values(STRUCTURED)) assert.ok(reportIsEmpty(migrateV1(w).report));
});

test('migration keeps id, config, name, seed and settings; does not touch the input', () => {
  const w = W([rec('a', 'Account', 'acc', [], { count: 4 })], [E('start', 'a')], { seed: 42, settings: { maxRecords: 10 } });
  const before = JSON.stringify(w);
  const { workflow } = migrateV1(w);
  assert.deepEqual(workflow, { version: 2, name: 'test', seed: 42, settings: { maxRecords: 10 }, steps: [{ id: 'a', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [], count: 4 } }] });
  assert.equal(JSON.stringify(w), before);
});

test('migration: loop body escaping to the done chain duplicates the shared tail (shape 4)', () => {
  const w = W(
    [{ id: 'l', type: 'loop', config: { count: 3 } }, rec('a', 'A', 'a'), rec('c', 'C', 'c', [{ name: 'P', type: 'lookup', options: { ref: 'c' } }]), rec('d', 'D', 'd')],
    [E('start', 'l'), E('l', 'a', 'body'), E('a', 'c'), E('c', 'd'), E('l', 'c', 'done')],
  );
  const { workflow, report } = migrateV1(w);
  assert.equal(shape(workflow.steps), 'l{a,c,d},c_2,d_2');
  assert.deepEqual(report.duplicated, [
    { id: 'c', copyId: 'c_2', alias: 'c', newAlias: 'c2' },
    { id: 'd', copyId: 'd_2', alias: 'd', newAlias: 'd2' },
  ]);
  const c2 = workflow.steps[1];
  assert.equal(c2.config.alias, 'c2');
  assert.equal(c2.config.fields[0].options.ref, 'c2', 'references inside the copy follow the rename');
  assert.match(describeReport(report)[0].message, /nhân thành "c" và "c_2"/);
});

test('migration: cross-branch link and two loops sharing a body are duplicated (shapes 5, 6)', () => {
  const cross = W(
    [{ id: 'b1', type: 'branch', config: {} }, { id: 'b2', type: 'branch', config: {} }, rec('a', 'A', 'a'), rec('b', 'B', 'b'), rec('x', 'X', 'x'), rec('z', 'Z', 'z')],
    [E('start', 'b1'), E('b1', 'a', 'true'), E('a', 'x'), E('b1', 'b', 'false'), E('b', 'b2'), E('b2', 'x', 'true'), E('b2', 'z', 'false')],
  );
  const m = migrateV1(cross);
  assert.equal(shape(m.workflow.steps), 'b1{a,x|b,b2{x_2|z}}');
  assert.deepEqual(m.report.duplicated.map((d) => d.copyId), ['x_2']);

  const shared = W(
    [{ id: 'l1', type: 'loop', config: { count: 2 } }, { id: 'l2', type: 'loop', config: { count: 2 } }, rec('a', 'A', 'a')],
    [E('start', 'l1'), E('l1', 'a', 'body'), E('l1', 'l2', 'done'), E('l2', 'a', 'body')],
  );
  assert.equal(shape(migrateV1(shared).workflow.steps), 'l1{a},l2{a_2}');
});

test('migration: unreachable nodes go to the end, disabled (shape 7)', () => {
  const w = W([rec('a', 'A', 'a'), rec('o1', 'O', 'o1'), rec('o2', 'O', 'o2'), { id: 'lp', type: 'loop', config: {} }, rec('in', 'I', 'in')],
    [E('start', 'a'), E('o1', 'o2'), E('lp', 'in', 'body')]);
  const { workflow, report } = migrateV1(w);
  assert.equal(shape(workflow.steps), 'a,o1(off),o2(off),lp(off){in}');
  assert.deepEqual(report.disabled, ['o1', 'o2', 'lp']);
  assert.match(describeReport(report).find((i) => i.nodeId === 'lp').message, /đang tắt/);
});

test('migration: cycles, fan-out and dangling edges are repaired and reported (shape 8)', () => {
  const w = W([rec('a', 'A', 'a'), rec('b', 'B', 'b'), rec('x', 'X', 'x'), rec('y', 'Y', 'y')], [
    E('start', 'a'), E('a', 'b'), E('b', 'a'), // cycle
    { from: 'b', fromPort: 'next', to: 'zz' }, // missing target
    { id: 'br' },
  ]);
  w.nodes.push({ id: 'br', type: 'branch', config: {} });
  w.edges.push(E('x', 'y'), E('br', 'x', 'true'), E('br', 'y', 'true')); // fan-out: last edge (→ y) wins
  const { workflow, report } = migrateV1(w);
  assert.deepEqual(report.droppedEdges.map((e) => `${e.from}>${e.to}:${e.reason}`).sort(), ['b>a:cycle', 'b>zz:missing', 'br>x:fanout', 'undefined>undefined:missing']);
  assert.equal(shape(workflow.steps), 'a,b,x(off),y(off),br(off){y_2|}');
});

test('migration: duplication is capped and the rest is reported as truncated', () => {
  // A chain of loops whose bodies all escape to their done-chain doubles the tree at each level.
  const nodes = [];
  const edges = [E('start', 'l0')];
  const N = 14;
  for (let i = 0; i < N; i++) {
    nodes.push({ id: `l${i}`, type: 'loop', config: { count: 1 } }, rec(`c${i}`, 'C', `c${i}`));
    edges.push(E(`l${i}`, `c${i}`, 'body'), E(`l${i}`, `c${i}`, 'done'));
    if (i + 1 < N) edges.push(E(`c${i}`, `l${i + 1}`));
  }
  const { workflow, report } = migrateV1(W(nodes, edges));
  const total = allSteps(workflow).length;
  assert.ok(total <= 2 * (2 * N + 1) + 50, `tree has ${total} steps`);
  assert.ok(report.truncated.length > 0);
  assert.match(describeReport(report).at(-1).message, /ngừng nhân bản/);
});

test('migration: a v2 workflow is returned unchanged; garbage does not throw', () => {
  const v2 = { version: 2, steps: [] };
  assert.equal(migrateV1(v2).workflow, v2);
  assert.ok(reportIsEmpty(migrateV1(v2).report));
  assert.deepEqual(migrateV1({ version: 1 }).workflow.steps, []);
  assert.deepEqual(migrateV1({ version: 1, nodes: [null, { id: 'a', type: 'record' }], edges: [null] }).workflow.steps.map((s) => s.disabled), [true]);
});
