import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  walkSteps, findStep, insertStep, removeStep, moveStep, wrapStep, cloneSteps, renameAlias, setStepAlias, isAliasName, malformedSteps,
  defaultInsertTarget, neighbourTarget, allSteps, collectAliases, collectIds, renameField,
} from '../shared/workflow-tree.js';
import { scopeCatalog } from '../server/workflow/schema.js';

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

test('renameAlias never moves references to an empty or invalid name', () => {
  const wf = tree([r('a', 'acc'), r('c', 'con', [{ name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])]);
  for (const bad of ['', undefined, '1x', 'a-b', 'this']) renameAlias(wf.steps, 'acc', bad);
  assert.equal(findStep(wf, 'c').step.config.fields[0].options.ref, 'acc');
  assert.ok(isAliasName('acc_2') && !isAliasName('') && !isAliasName('this'));
});

test('setStepAlias: clearing the field or passing through another alias while typing keeps the references', () => {
  const lk = (ref) => [{ name: 'AccountId', type: 'lookup', options: { ref } }];
  const wf = tree([r('a', 'acc'), r('o', 'acc2'), r('c', 'con', [...lk('acc'), { name: 'Other', type: 'lookup', options: { ref: 'acc2' } }])]);
  const memo = new Map();
  const refs = () => findStep(wf, 'c').step.config.fields.map((f) => f.options.ref).join(',');
  // Select all + delete, then type "acc2x": "", "a", "ac", "acc", "acc2" (taken), "acc2x".
  for (const v of ['', 'a', 'ac', 'acc', 'acc2', 'acc2x']) {
    setStepAlias(wf, 'a', v, { memo, slotKeys });
    if (v === '') assert.equal(refs(), 'acc,acc2', 'empty: references stay on the last good name');
    if (v === 'acc2') assert.equal(refs(), 'acc,acc2', 'never merged into the other alias');
  }
  assert.equal(findStep(wf, 'a').step.config.alias, 'acc2x');
  assert.equal(refs(), 'acc2x,acc2', 'references follow once the name is good again');
  // Invalid characters mid-typing: references wait on the last good name.
  setStepAlias(wf, 'a', 'acc-', { memo, slotKeys });
  assert.equal(refs(), 'acc2x,acc2');
  setStepAlias(wf, 'a', 'account', { memo, slotKeys });
  assert.equal(refs(), 'account,acc2');
});

test('setStepAlias: loop variables rename inside the body only, and not into a shadowing name', () => {
  const tpl = (id, t) => ({ id, type: 'record', config: { alias: id, fields: [{ name: 'T', type: 'template', options: { template: t } }] } });
  const wf = tree([loop('outer', [loop('inner', [tpl('b', '{{j.index}}')], { alias: 'j' })], { alias: 'i' }), tpl('z', '{{j.index}}')]);
  const memo = new Map();
  const t = (id) => findStep(wf, id).step.config.fields[0].options.template;
  setStepAlias(wf, 'inner', 'i', { memo, slotKeys }); // would shadow the outer loop: wait
  assert.equal(t('b'), '{{j.index}}');
  setStepAlias(wf, 'inner', 'k', { memo, slotKeys });
  assert.equal(t('b'), '{{k.index}}');
  assert.equal(t('z'), '{{j.index}}', 'outside the loop body nothing changes');
  setStepAlias(wf, 'inner', '', { memo, slotKeys }); // empty = "loop", a valid name
  assert.equal(t('b'), '{{loop.index}}');
  assert.equal(findStep(wf, 'inner').step.config.alias, '');
});

test('malformedSteps names the first step that is not an object, or a bad slots value', () => {
  assert.equal(malformedSteps(tree([r('a'), loop('l', [r('b')])])), null);
  assert.match(malformedSteps(tree([r('a'), null])), /steps\[1\] không phải một bước/);
  assert.match(malformedSteps(tree([loop('l', ['x'])])), /steps\[0\]\.slots\.body\[0\]/);
  assert.match(malformedSteps(tree([{ id: 'l', type: 'loop', slots: { body: 3 } }])), /"slots.body" của bước "l"/);
  assert.match(malformedSteps(tree([{ id: 'l', type: 'loop', slots: [] }])), /"slots" của bước "l"/);
  assert.match(malformedSteps({ version: 2 }), /steps/);
});

// ---------- reference-aware renames (design 0005) ----------

const catalog = scopeCatalog();
const T = (name, template) => ({ name, type: 'template', options: { template } });
const fieldsOf = (wf, id) => findStep(wf, id).step.config.fields;

test('renameAlias with the catalogue: templates, {{ }} in a branch left, Lookup ref; counts references', () => {
  const br = { id: 'br', type: 'branch', config: { kind: 'compare', left: '{{ acc.Industry }}' }, slots: { true: [], false: [] } };
  const wf = tree([r('a', 'acc'), r('c', 'con', [T('T', '{{acc.Name}} {{ acc.Name }} {{accX.Name}} {{acc}}'), { name: 'P', type: 'lookup', options: { ref: 'acc' } }]), br]);
  const n = renameAlias(wf.steps, 'acc', 'account', { catalog });
  assert.equal(n, 5);
  assert.equal(fieldsOf(wf, 'c')[0].options.template, '{{account.Name}} {{ account.Name }} {{accX.Name}} {{account}}');
  assert.equal(fieldsOf(wf, 'c')[1].options.ref, 'account');
  assert.equal(br.config.left, '{{ account.Industry }}');
});

test('setStepAlias with the catalogue renames only references to that loop (two loops named "loop")', () => {
  // Nested loops with the same name (old files): the inner loop owns {{loop.*}} inside its body.
  const wf = tree([loop('outer', [r('a', 'a', [T('T', '{{loop.index}}')]), loop('inner', [r('b', 'b', [T('T', '{{loop.index}}')])]), r('c', 'c', [T('T', '{{loop.count}}')])])]);
  setStepAlias(wf, 'outer', 'i', { memo: new Map(), slotKeys, catalog });
  assert.equal(fieldsOf(wf, 'a')[0].options.template, '{{i.index}}');
  assert.equal(fieldsOf(wf, 'c')[0].options.template, '{{i.count}}');
  assert.equal(fieldsOf(wf, 'b')[0].options.template, '{{loop.index}}', 'the inner loop keeps its references');
  // Without the catalogue the whole body follows (old behaviour).
  const old = structuredClone(wf);
  findStep(old, 'outer').step.config.alias = 'loop';
  setStepAlias(old, 'outer', 'k', { memo: new Map(), slotKeys });
  assert.equal(fieldsOf(old, 'b')[0].options.template, '{{k.index}}');
});

test('renameField updates {{alias.Old}} everywhere, {{this.Old}} in the step and branch left paths', () => {
  const br = { id: 'br', type: 'branch', config: { kind: 'compare', left: 'acc.Industry', op: 'eq', right: 'x' }, slots: { true: [], false: [] } };
  const wf = tree([
    r('a', 'acc', [{ name: 'Industry', type: 'picklist', options: { values: ['A'] } }, T('Copy', '{{this.Industry}}!')]),
    r('o', 'other', [{ name: 'Industry', type: 'text' }]),
    r('c', 'con', [T('Title', '{{acc.Industry}} / {{other.Industry}} / {{acc.Name}}'), T('Other', '{{this.Industry}}')]),
    br,
  ]);
  fieldsOf(wf, 'a')[0].name = 'Industry__c'; // the inspector has already applied the new name
  const res = renameField(wf, 'a', 'Industry', 'Industry__c', { catalog });
  assert.equal(res.count, 3);
  assert.deepEqual(res.places.map((p) => `${p.nodeId}:${p.field}`).sort(), ['a:fields.Copy', 'br:left', 'c:fields.Title']);
  assert.equal(fieldsOf(wf, 'a')[1].options.template, '{{this.Industry__c}}!');
  assert.equal(fieldsOf(wf, 'c')[0].options.template, '{{acc.Industry__c}} / {{other.Industry}} / {{acc.Name}}');
  assert.equal(fieldsOf(wf, 'c')[1].options.template, '{{this.Industry}}', "another step's this.* is not touched");
  assert.equal(br.config.left, 'acc.Industry__c');
  assert.deepEqual(res.names.sort(), ['acc', 'this']);
  assert.deepEqual(renameField(wf, 'a', 'Nope', 'X', { catalog }), { count: 0, places: [], names: [] });
});

test('setStepAlias renames a loop variable in a branch left hidden by showIf (review fix)', () => {
  const br = { id: 'B', type: 'branch', config: { kind: 'chance', probability: 0.5, left: 'loop.index' }, slots: { true: [], false: [] } };
  const wf = tree([loop('L', [br, r('c', 'c', [T('T', '{{loop.index}}')])])]);
  setStepAlias(wf, 'L', 'it', { memo: new Map(), slotKeys, catalog });
  assert.equal(br.config.left, 'it.index', 'switching back to "So sánh giá trị" must not find a broken reference');
  assert.equal(fieldsOf(wf, 'c')[0].options.template, '{{it.index}}');
});

test('setStepAlias: the first alias of a record moves the references made through its id (review fix)', () => {
  const wf = tree([r('r1', ''), r('c', 'con', [T('T', '{{r1.Name}}'), { name: 'P', type: 'lookup', options: { ref: 'r1' } }])]);
  setStepAlias(wf, 'r1', 'acc', { memo: new Map(), slotKeys, catalog });
  assert.equal(fieldsOf(wf, 'c')[0].options.template, '{{acc.Name}}');
  assert.equal(fieldsOf(wf, 'c')[1].options.ref, 'acc');
});

test('Query / Chọn bản ghi aliases (0006): one namespace with records; renames follow from, filterValue, Lookup and templates; copies get new names', () => {
  const catalog = scopeCatalog();
  const q = { id: 'q', type: 'query', config: { sobject: 'Account', alias: 'accs' } };
  const p = { id: 'p', type: 'pick', config: { from: 'accs', alias: 'acc', filter: 'compare', filterField: 'Id', filterValue: '{{acc0.Id}}' } };
  const c = r('c', 'con', [{ name: 'AccountId', type: 'lookup', options: { mode: 'random', ref: 'accs' } }, { name: 'T', type: 'template', options: { template: '{{acc.Name}} {{accs.$count}}' } }]);
  const wf = tree([{ id: 'q0', type: 'query', config: { alias: 'acc0s' } }, { id: 'p0', type: 'pick', config: { from: 'acc0s', alias: 'acc0' } }, q, p, c]);
  assert.deepEqual([...collectAliases(wf)].sort(), ['acc', 'acc0', 'acc0s', 'accs', 'con']);
  assert.equal(setStepAlias(wf, 'q', 'accounts', { catalog }), true);
  assert.equal(p.config.from, 'accounts');
  assert.equal(c.config.fields[0].options.ref, 'accounts');
  assert.equal(c.config.fields[1].options.template, '{{acc.Name}} {{accounts.$count}}');
  setStepAlias(wf, 'p0', 'parent', { catalog });
  assert.equal(p.config.filterValue, '{{parent.Id}}');
  // Not into another step's alias (a record's).
  assert.equal(setStepAlias(wf, 'p', 'con', { catalog }), false);
  assert.equal(c.config.fields[1].options.template, '{{acc.Name}} {{accounts.$count}}');
  setStepAlias(wf, 'p', 'acc', { catalog }); // back to the free name (the field is mid-typing)
  // Ctrl+D on a Query + Chọn bản ghi pair: both get new aliases, the copy's `from` follows.
  const { steps: [q2, p2] } = cloneSteps([q, p], { ids: collectIds(wf), aliases: collectAliases(wf), catalog });
  assert.deepEqual([q2.config.alias, p2.config.alias, p2.config.from], ['accounts2', 'acc2', 'accounts2']);
});
