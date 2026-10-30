// "Bọc trong Lặp qua từng bản ghi" (design 0012 C): pool choice, Lookups to re-point, and the
// guarded [Đổi] (shared/each-wrap.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eachWrapPlan, applyEachRewire } from '../shared/each-wrap.js';
import { wrapStep, findStep } from '../shared/workflow-tree.js';
import { scopeCatalog } from '../server/workflow/schema.js';
import { slotKeys } from '../server/workflow/nodes.js';
import { SAMPLES } from '../client/js/samples.js';
import { wf, record, query } from './helpers.js';

const CAT = scopeCatalog();
const lookup = (name, ref, mode = 'current') => ({ name, type: 'lookup', options: { mode, ref } });
const plan = (w, id) => eachWrapPlan(w, CAT, id, { slotKeys });

/** Wraps `id` like ops.wrapInEach does. */
function wrap(w, id, p, loopId = 'L', itemAlias = 'acc') {
  wrapStep(w, id, { id: loopId, type: 'loop', config: { mode: 'each', from: p.from, itemAlias, alias: 'loop2' }, slots: { body: [] } }, { slotKeys });
}

test('a reference to a Chọn bản ghi counts for its pool: con (→ acc picked from accs) loops over accs', () => {
  const w = structuredClone(SAMPLES.find((s) => s.label === 'Contact cho Account có sẵn').workflow);
  const p = plan(w, 'con');
  assert.equal(p.from, 'accs');
  assert.deepEqual(p.rewire, [{ stepId: 'con', alias: 'con', fieldIndex: 4, fieldName: 'AccountId', ref: 'acc' }]);
});

test('the most referenced usable pool wins; ties and no reference: the nearest; none usable: null', () => {
  const w = wf([
    query('q1', 'accs'),
    query('q2', 'opps', { sobject: 'Opportunity' }),
    record('c', 'Contact', 'con', [lookup('AccountId', 'accs', 'random'), { name: 'D', type: 'template', options: { template: '{{accs.Name}}' } }, lookup('X__c', 'opps', 'random')]),
    record('t', 'Task', 'task', []),
  ]);
  const p = plan(w, 'c');
  assert.equal(p.from, 'accs');
  assert.deepEqual(p.rewire.map((r) => r.fieldName), ['AccountId']);
  assert.equal(plan(w, 't').from, 'con', 'no reference: the nearest pool above');
  assert.equal(plan(wf([record('c', 'Contact', 'con', [])]), 'c'), null);
  // A Lookup on the chosen pool in "current" mode is not proposed (it does not read a random record).
  assert.deepEqual(plan(wf([query('q1', 'accs'), record('c', 'Contact', 'con', [lookup('AccountId', 'accs')])]), 'c').rewire, []);
});

test('[Đổi] re-points the Lookups while the loop is there with the same record name', () => {
  const w = wf([query('q1', 'accs'), record('c', 'Contact', 'con', [lookup('AccountId', 'accs', 'random')])]);
  const p = plan(w, 'c');
  wrap(w, 'c', p);
  assert.equal(applyEachRewire(w, p.rewire, { loopId: 'L', itemAlias: 'acc', slotKeys }), 1);
  assert.deepEqual(findStep(w, 'c', slotKeys).step.config.fields[0].options, { mode: 'current', ref: 'acc' });
});

test('[Đổi] changes nothing once the wrap was undone, the record renamed, or the step moved out', () => {
  const base = wf([query('q1', 'accs'), record('c', 'Contact', 'con', [lookup('AccountId', 'accs', 'random')])]);
  const p = plan(base, 'c');
  const opts = { loopId: 'L', itemAlias: 'acc', slotKeys };
  const before = JSON.stringify(base);
  // Undone: no loop.
  assert.equal(applyEachRewire(base, p.rewire, opts), null);
  assert.equal(JSON.stringify(base), before);
  // Record renamed / no longer each.
  const renamed = structuredClone(base);
  wrap(renamed, 'c', p, 'L', 'a2');
  assert.equal(applyEachRewire(renamed, p.rewire, opts), null);
  const fixed = structuredClone(base);
  wrap(fixed, 'c', p);
  findStep(fixed, 'L', slotKeys).step.config.mode = 'fixed';
  assert.equal(applyEachRewire(fixed, p.rewire, opts), null);
  // The step moved out of the loop: the loop is there, the Lookup is not inside it.
  const moved = structuredClone(base);
  wrap(moved, 'c', p);
  const loopStep = findStep(moved, 'L', slotKeys).step;
  moved.steps.push(loopStep.slots.body.pop());
  assert.equal(applyEachRewire(moved, p.rewire, opts), 0);
  assert.equal(moved.steps.at(-1).config.fields[0].options.ref, 'accs');
  // The Lookup was edited meanwhile.
  const edited = structuredClone(base);
  wrap(edited, 'c', p);
  findStep(edited, 'c', slotKeys).step.config.fields[0].options.ref = 'other';
  assert.equal(applyEachRewire(edited, p.rewire, opts), 0);
});
