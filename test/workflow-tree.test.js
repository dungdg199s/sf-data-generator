import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  walkSteps, findStep, insertStep, removeStep, moveStep, wrapStep, cloneSteps, renameAlias,
  defaultInsertTarget, neighbourTarget, allSteps, collectAliases, collectIds,
} from '../shared/workflow-tree.js';

const SLOTS = { record: [], loop: ['body'], branch: ['true', 'false'] };
const slotKeys = (type) => SLOTS[type] ?? [];

const r = (id, alias = id, fields = []) => ({ id, type: 'record', config: { sobject: 'Account', alias, fields } });
const loop = (id, body = [], config = {}) => ({ id, type: 'loop', config: { alias: 'loop', ...config }, slots: { body } });
const branch = (id, yes = [], no = []) => ({ id, type: 'branch', config: {}, slots: { true: yes, false: no } });
const tree = (steps) => ({ version: 2, steps });
const ids = (wf) => allSteps(wf, slotKeys).map((s) => s.id).join(' ');
const shape = (steps) => steps.map((s) => (s.slots ? `${s.id}{${slotKeys(s.type).map((k) => shape(s.slots[k] ?? [])).join('|')}}` : s.id)).join(',');

test('walkSteps visits in reading order with depth; true before false', () => {
  const wf = tree([r('a'), loop('l', [r('b'), branch('br', [r('t')], [r('f')])]), r('z')]);
  const seen = [];
  walkSteps(wf.steps, (s, info) => { seen.push(`${s.id}:${info.depth}`); }, slotKeys);
  assert.deepEqual(seen, ['a:0', 'l:0', 'b:1', 'br:1', 't:2', 'f:2', 'z:0']);
});

test('findStep returns parent, slot, index and ancestors', () => {
  const wf = tree([loop('l', [branch('br', [], [r('f')])])]);
  const at = findStep(wf, 'f', slotKeys);
  assert.equal(at.parentId, 'br');
  assert.equal(at.slot, 'false');
  assert.equal(at.index, 0);
  assert.equal(at.depth, 2);
  assert.deepEqual(at.ancestors.map((s) => s.id), ['l', 'br']);
  assert.equal(findStep(wf, 'nope', slotKeys), null);
});

test('insertStep into root, a loop body and a missing slot', () => {
  const wf = tree([r('a'), { id: 'l', type: 'loop', config: {} }]);
  insertStep(wf, { parentId: null, slot: null, index: 1 }, r('b'));
  insertStep(wf, { parentId: 'l', slot: 'body', index: 0 }, r('c'));
  assert.equal(shape(wf.steps), 'a,b,l{c}');
});

test('removeStep closes the gap; keepChildren unwraps a container', () => {
  const wf = tree([r('a'), loop('l', [r('b'), r('c')]), r('d')]);
  removeStep(wf, 'a', { slotKeys });
  assert.equal(shape(wf.steps), 'l{b,c},d');
  removeStep(wf, 'l', { keepChildren: true, slotKeys });
  assert.equal(shape(wf.steps), 'b,c,d');
  const wf2 = tree([branch('br', [r('t')], [])]);
  removeStep(wf2, 'br', { keepChildren: true, slotKeys });
  assert.equal(shape(wf2.steps), 't');
});

test('moveStep uses before-move coordinates and refuses moving into itself', () => {
  const wf = tree([r('a'), r('b'), loop('l', [r('c')])]);
  assert.ok(moveStep(wf, 'a', { parentId: null, slot: null, index: 2 }, slotKeys));
  assert.equal(shape(wf.steps), 'b,a,l{c}');
  assert.ok(moveStep(wf, 'b', { parentId: 'l', slot: 'body', index: 1 }, slotKeys));
  assert.equal(shape(wf.steps), 'a,l{c,b}');
  assert.equal(moveStep(wf, 'l', { parentId: 'l', slot: 'body', index: 0 }, slotKeys), false);
  assert.equal(moveStep(wf, 'a', { parentId: null, slot: null, index: 1 }, slotKeys), false, 'same place is a no-op');
});

test('wrapStep puts the step in the first slot of the container', () => {
  const wf = tree([r('a'), r('b')]);
  wrapStep(wf, 'b', { id: 'br', type: 'branch', config: {} }, { slotKeys });
  assert.equal(shape(wf.steps), 'a,br{b|}');
  wrapStep(wf, 'br', { id: 'l', type: 'loop', config: {} }, { slotKeys });
  assert.equal(shape(wf.steps), 'a,l{br{b|}}');
});

test('cloneSteps renames ids and inner aliases; inner references follow, outer ones do not', () => {
  const lookup = (ref) => ({ name: 'AccountId', type: 'lookup', options: { mode: 'current', ref } });
  const tpl = (t) => ({ name: 'Title', type: 'template', options: { template: t } });
  const wf = tree([r('top', 'top'), loop('l', [r('acc', 'acc'), r('con', 'con', [lookup('acc'), tpl('{{ acc.Name }} {{top.Name}}'), { name: 'X', type: 'lookup', options: { ref: 'top' } }])])]);
  const { steps, renamed } = cloneSteps([findStep(wf, 'l').step], { ids: collectIds(wf), aliases: collectAliases(wf) });
  const [copy] = steps;
  assert.equal(copy.id, 'l_2');
  const [acc2, con2] = copy.slots.body;
  assert.equal(acc2.config.alias, 'acc2');
  assert.equal(con2.config.alias, 'con2');
  assert.equal(con2.config.fields[0].options.ref, 'acc2');
  assert.equal(con2.config.fields[1].options.template, '{{ acc2.Name }} {{top.Name}}');
  assert.equal(con2.config.fields[2].options.ref, 'top');
  assert.deepEqual(renamed.map((x) => x.copyId), ['l_2', 'acc_2', 'con_2']);
  // The original is untouched.
  assert.equal(findStep(wf, 'con').step.config.fields[0].options.ref, 'acc');
});

test('renameAlias escapes regex characters and can be limited to a loop body', () => {
  const tpl = (id, t) => ({ id, type: 'record', config: { alias: id, fields: [{ name: 'T', type: 'template', options: { template: t } }] } });
  const wf = tree([loop('outer', [tpl('a', '{{loop.index}}')]), loop('inner', [tpl('b', '{{loop.index}}')])]);
  renameAlias(findStep(wf, 'inner').step.slots.body, 'loop', 'j');
  assert.equal(findStep(wf, 'a').step.config.fields[0].options.template, '{{loop.index}}');
  assert.equal(findStep(wf, 'b').step.config.fields[0].options.template, '{{j.index}}');
  assert.doesNotThrow(() => renameAlias(wf.steps, 'acc(x', 'y'));
  const br = { id: 'br', type: 'branch', config: { left: 'acc.Industry' }, slots: { true: [], false: [] } };
  renameAlias([br], 'acc', 'account');
  assert.equal(br.config.left, 'account.Industry');
});

test('defaultInsertTarget: end of root, first empty slot, or right after the step', () => {
  const wf = tree([r('a'), loop('l', []), branch('br', [r('t')], []), loop('full', [r('x')])]);
  assert.deepEqual(defaultInsertTarget(wf, null, slotKeys), { parentId: null, slot: null, index: 4 });
  assert.deepEqual(defaultInsertTarget(wf, 'missing', slotKeys), { parentId: null, slot: null, index: 4 });
  assert.deepEqual(defaultInsertTarget(wf, 'a', slotKeys), { parentId: null, slot: null, index: 1 });
  assert.deepEqual(defaultInsertTarget(wf, 'l', slotKeys), { parentId: 'l', slot: 'body', index: 0 });
  assert.deepEqual(defaultInsertTarget(wf, 'br', slotKeys), { parentId: 'br', slot: 'false', index: 0 });
  assert.deepEqual(defaultInsertTarget(wf, 'full', slotKeys), { parentId: null, slot: null, index: 4 });
  assert.deepEqual(defaultInsertTarget(wf, 't', slotKeys), { parentId: 'br', slot: 'true', index: 1 });
  const fresh = tree([branch('b2')]);
  assert.deepEqual(defaultInsertTarget(fresh, 'b2', slotKeys), { parentId: 'b2', slot: 'true', index: 0 });
});

test('neighbourTarget walks insertion points in reading order, in and out of containers', () => {
  const wf = tree([r('a'), r('x'), loop('l', [r('b')]), r('c')]);
  const step = (dir, collapsed) => {
    const t = neighbourTarget(wf, 'x', dir, collapsed, slotKeys);
    if (t) moveStep(wf, 'x', t, slotKeys);
    return t ? shape(wf.steps) : null;
  };
  assert.equal(step(+1), 'a,l{x,b},c', 'enters the open loop at the top');
  assert.equal(step(+1), 'a,l{b,x},c');
  assert.equal(step(+1), 'a,l{b},x,c', 'leaves the loop right after it');
  assert.equal(step(+1), 'a,l{b},c,x');
  assert.equal(step(+1), null, 'already last');
  assert.equal(step(-1), 'a,l{b},x,c');
  assert.equal(step(-1), 'a,l{b,x},c', 'enters the loop from below');
  assert.equal(step(-1), 'a,l{x,b},c');
  assert.equal(step(-1), 'a,x,l{b},c');
  assert.equal(step(+1, new Set(['l'])), 'a,l{b},x,c', 'collapsed containers are jumped over');
  assert.equal(step(-1), 'a,l{b,x},c');
});

test('neighbourTarget goes through both branch columns, true first', () => {
  const wf = tree([branch('br', [r('t')], []), r('x')]);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const t = neighbourTarget(wf, 'x', -1, new Set(), slotKeys);
    if (!t) break;
    moveStep(wf, 'x', t, slotKeys);
    seq.push(shape(wf.steps));
  }
  assert.deepEqual(seq, ['br{t|x}', 'br{t,x|}', 'br{x,t|}', 'x,br{t|}']);
});
