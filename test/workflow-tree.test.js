import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  walkSteps, findStep, insertStep, removeStep, moveStep, wrapStep, cloneSteps, renameAlias, setStepAlias, isAliasName, malformedSteps,
  defaultInsertTarget, neighbourTarget, allSteps, collectAliases, collectIds, renameField, aliasTypes, stepNames,
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
  assert.deepEqual([...collectAliases(wf, catalog)].sort(), ['acc', 'acc0', 'acc0s', 'accs', 'con']);
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
  const { steps: [q2, p2] } = cloneSteps([q, p], { ids: collectIds(wf), aliases: collectAliases(wf, catalog), catalog });
  assert.deepEqual([q2.config.alias, p2.config.alias, p2.config.from], ['accounts2', 'acc2', 'accounts2']);
});

test('alias types come from the catalogue exposes, not a hard-coded list (0006 review)', () => {
  assert.deepEqual([...aliasTypes(scopeCatalog())].sort(), ['pick', 'query', 'record']);
  // A future step type exposing a record named by `alias` joins the namespace without code changes.
  const extra = { type: 'lookupRow', slots: [], exposes: { kind: 'record', name: { key: 'alias' } }, options: [] };
  const catalog = { nodeTypes: [...scopeCatalog().nodeTypes, extra], fieldTypes: scopeCatalog().fieldTypes };
  const wf = tree([r('a', 'acc'), { id: 'x', type: 'lookupRow', config: { alias: 'row' } }, loop('l', [], { alias: 'i' })]);
  assert.deepEqual([...collectAliases(wf, catalog)].sort(), ['acc', 'row']);
  assert.deepEqual([...collectAliases(wf)], ['acc'], 'without a catalogue (v1 migration): records only');
  assert.equal(setStepAlias(wf, 'a', 'row', { catalog }), false, 'another type\'s alias is taken');
  const { steps: [copy] } = cloneSteps([findStep(wf, 'x').step], { aliases: collectAliases(wf, catalog), catalog });
  assert.equal(copy.config.alias, 'row2');
});

// ---------- design 0010: Lặp "Mỗi bản ghi trong pool" ----------

const query = (id, alias) => ({ id, type: 'query', config: { sobject: 'Account', alias, fields: ['Id', 'Name'] } });
const each = (id, from, itemAlias, body = [], extra = {}) => loop(id, body, { mode: 'each', from, itemAlias, ...extra });
const tplF = (name, template) => ({ name, type: 'template', options: { template } });
const lkF = (name, ref) => ({ name, type: 'lookup', options: { mode: 'current', ref } });

test('the record of an each loop joins the alias namespace (0010)', () => {
  const catalog = scopeCatalog();
  const make = () => tree([query('q', 'accs'), each('l', 'accs', 'acc', [r('c', 'con', [lkF('AccountId', 'acc')])]), loop('f', [], { alias: 'i', count: 1, itemAlias: 'stale' })]);
  const wf = make();
  assert.deepEqual(stepNames(findStep(wf, 'l').step, catalog), [{ key: 'itemAlias', value: 'acc' }]);
  assert.deepEqual([...collectAliases(wf, catalog)].sort(), ['acc', 'accs', 'con'], 'a fixed loop\'s leftover itemAlias does not count');
  // References never move into a taken name: a record alias, another loop's variable, its own.
  const ref = (w) => findStep(w, 'c').step.config.fields[0].options.ref;
  for (const [name, why] of [['con', 'a record alias'], ['accs', 'a pool alias'], ['i', 'another loop variable'], ['loop', 'its own loop variable']]) {
    const w = make();
    assert.equal(setStepAlias(w, 'l', name, { catalog, key: 'itemAlias', slotKeys }), false, why);
    assert.equal(ref(w), 'acc', why);
  }
  const w = make();
  assert.equal(setStepAlias(w, 'c', 'acc', { catalog, slotKeys }), false, 'a record cannot take the record name');
  const w2 = make();
  assert.equal(setStepAlias(w2, 'l', 'acc', { catalog, slotKeys }), false, 'nor its loop variable');
  const w3 = make();
  assert.equal(setStepAlias(w3, 'l', 'a', { catalog, key: 'itemAlias', slotKeys }), true);
  assert.equal(ref(w3), 'a');
});

test('renameAlias updates loop from', () => {
  const catalog = scopeCatalog();
  const wf = tree([query('q', 'accs'), each('l', 'accs', 'acc', [r('c', 'con', [tplF('T', '{{accs.$count}}')])]), loop('f', [], { count: 1, mode: 'fixed', from: 'accs' })]);
  assert.equal(setStepAlias(wf, 'q', 'accounts', { catalog, slotKeys }), true);
  assert.equal(findStep(wf, 'l').step.config.from, 'accounts');
  assert.equal(findStep(wf, 'f').step.config.from, 'accounts', 'a hidden `from` (fixed mode) follows too, so switching back loses nothing');
  assert.equal(findStep(wf, 'c').step.config.fields[0].options.template, '{{accounts.$count}}');
  // Without a catalogue (legacy options) the each loop's `from` still follows.
  const plain = tree([r('a', 'acc'), each('l', 'acc', 'x')]);
  renameAlias(plain.steps, 'acc', 'account');
  assert.equal(plain.steps[1].config.from, 'account');
});

test('setStepAlias on itemAlias renames references inside the body only', () => {
  const catalog = scopeCatalog();
  const inner = r('c', 'con', [lkF('AccountId', 'acc'), tplF('T', '{{acc.Name}} {{loop.index}}')]);
  // `acc` outside the body is an error the rename must not "fix" into another meaning.
  const outside = r('o', 'out', [tplF('T', '{{acc.Name}}')]);
  const wf = tree([query('q', 'accs'), each('l', 'accs', 'acc', [inner, loop('deep', [r('d', 'dd', [lkF('X', 'acc')])], { alias: 'k', count: 1 })]), outside]);
  const memo = new Map();
  // Mid-typing ('' then 'a-') references wait on the last good name.
  assert.equal(setStepAlias(wf, 'l', '', { catalog, key: 'itemAlias', slotKeys, memo }), false);
  assert.equal(setStepAlias(wf, 'l', 'a-', { catalog, key: 'itemAlias', slotKeys, memo }), false);
  assert.equal(inner.config.fields[0].options.ref, 'acc');
  assert.equal(setStepAlias(wf, 'l', 'account', { catalog, key: 'itemAlias', slotKeys, memo }), true);
  assert.equal(findStep(wf, 'l').step.config.itemAlias, 'account');
  assert.equal(inner.config.fields[0].options.ref, 'account');
  assert.equal(inner.config.fields[1].options.template, '{{account.Name}} {{loop.index}}');
  assert.equal(findStep(wf, 'd').step.config.fields[0].options.ref, 'account', 'nested frames inside the body too');
  assert.equal(outside.config.fields[0].options.template, '{{acc.Name}}');
  assert.equal(findStep(wf, 'l').step.config.alias, 'loop', 'the loop variable is untouched');
  // The alias memo of the loop variable is separate from the record's.
  assert.equal(setStepAlias(wf, 'l', 'i', { catalog, slotKeys, memo }), true);
  assert.equal(inner.config.fields[1].options.template, '{{account.Name}} {{i.index}}');
});

test('cloneSteps gives a copied each loop a new item alias', () => {
  const catalog = scopeCatalog();
  const wf = tree([query('q', 'accs'), each('l', 'accs', 'acc', [r('c', 'con', [lkF('AccountId', 'acc'), tplF('T', '{{acc.Name}}')])])]);
  const { steps: [copy], renamed } = cloneSteps([findStep(wf, 'l').step], { ids: collectIds(wf), aliases: collectAliases(wf, catalog), catalog });
  assert.deepEqual([copy.config.from, copy.config.itemAlias], ['accs', 'acc2']);
  const c2 = copy.slots.body[0];
  assert.deepEqual([c2.config.alias, c2.config.fields[0].options.ref, c2.config.fields[1].options.template], ['con2', 'acc2', '{{acc2.Name}}']);
  assert.deepEqual(renamed[0].names, [{ key: 'itemAlias', from: 'acc', to: 'acc2' }]);
  // Copying the pool together with the loop: the copy loops over the copied pool.
  const both = cloneSteps(wf.steps, { ids: collectIds(wf), aliases: collectAliases(wf, catalog), catalog }).steps;
  assert.deepEqual([both[0].config.alias, both[1].config.from, both[1].config.itemAlias], ['accs2', 'accs2', 'acc2']);
});

test('renameField follows references through the record of an each loop and a Chọn bản ghi (0010 review)', () => {
  const catalog = scopeCatalog();
  const nameF = { name: 'Name', type: 'text', options: { mode: 'company' } };
  const wf = tree([
    r('acc', 'acc', [nameF]),
    each('e', 'acc', 'a', [r('c', 'con', [tplF('T', '{{a.Name}} {{acc.Name}}')]), branch('b', [r('t', 't', [tplF('S', '{{a.Name}}')])])]),
    { id: 'p', type: 'pick', config: { from: 'acc', alias: 'pk' } },
    { id: 'p2', type: 'pick', config: { from: 'pk', alias: 'pk2' } },
    r('d', 'd', [tplF('T', '{{pk.Name}} {{pk2.Name}}')]),
  ]);
  findStep(wf, 'b').step.config = { kind: 'compare', left: 'a.Name', op: 'eq', right: 'x' };
  const res = renameField(wf, 'acc', 'Name', 'AccName', { catalog });
  assert.equal(findStep(wf, 'c').step.config.fields[0].options.template, '{{a.AccName}} {{acc.AccName}}');
  assert.equal(findStep(wf, 'b').step.config.left, 'a.AccName');
  assert.equal(findStep(wf, 't').step.config.fields[0].options.template, '{{a.AccName}}');
  assert.equal(findStep(wf, 'd').step.config.fields[0].options.template, '{{pk.AccName}} {{pk2.AccName}}', 'a pick, and a pick of a pick');
  // The toast counts every reference changed.
  assert.equal(res.count, 6);
  assert.deepEqual(res.names.sort(), ['a', 'acc', 'pk', 'pk2']);
});

// ---------- design 0012 B: groups of steps, paste ----------

import {
  normalizeSelection, rangeBetween, wrapSteps, removeSteps, moveBlock, neighbourTargetBlock, pasteSteps, countSteps, loopVarsAround,
} from '../shared/workflow-tree.js';

test('rangeBetween lifts both ends to the nearest common sequence', () => {
  const wf = tree([r('a'), loop('loopCon', [r('con'), r('task')]), r('opp'), r('z')]);
  assert.deepEqual(rangeBetween(wf, 'con', 'task', slotKeys), ['con', 'task'], 'same sequence');
  assert.deepEqual(rangeBetween(wf, 'con', 'opp', slotKeys), ['loopCon', 'opp'], 'anchor in a loop, end at the root');
  assert.deepEqual(rangeBetween(wf, 'z', 'con', slotKeys), ['loopCon', 'opp', 'z'], 'backwards');
  assert.deepEqual(rangeBetween(wf, 'loopCon', 'task', slotKeys), ['loopCon'], 'a step and its own child');
  const br = tree([branch('b', [r('t')], [r('f')])]);
  assert.deepEqual(rangeBetween(br, 't', 'f', slotKeys), ['b'], 'two columns of one branch: the branch');
  assert.deepEqual(rangeBetween(wf, 'gone', 'opp', slotKeys), ['opp']);
});

test('normalizeSelection: reading order, steps inside a selected frame dropped, contiguous or not', () => {
  const wf = tree([r('a'), loop('l', [r('b'), r('c')]), r('d'), r('e')]);
  const sel = normalizeSelection(wf, ['d', 'b', 'l', 'gone'], slotKeys);
  assert.deepEqual(sel.ids, ['l', 'd']);
  assert.equal(sel.contiguous, true);
  assert.deepEqual([sel.parentId, sel.slot, sel.start, sel.end], [null, null, 1, 2]);
  assert.equal(normalizeSelection(wf, ['a', 'd'], slotKeys).contiguous, false, 'a gap');
  assert.equal(normalizeSelection(wf, ['a', 'b'], slotKeys).contiguous, false, 'two sequences');
  assert.deepEqual(normalizeSelection(wf, ['c', 'b'], slotKeys), { ...normalizeSelection(wf, ['b', 'c'], slotKeys) });
  assert.deepEqual(normalizeSelection(wf, [], slotKeys).ids, []);
});

test('wrapSteps keeps the order of the block; refuses a selection that is not one block', () => {
  const wf = tree([r('a'), r('b'), r('c'), r('d')]);
  assert.equal(wrapSteps(wf, ['a', 'c'], { id: 'L', type: 'loop', config: {} }, { slotKeys }), null);
  assert.equal(shape(wf.steps), 'a,b,c,d');
  wrapSteps(wf, ['c', 'b'], { id: 'L', type: 'loop', config: {} }, { slotKeys });
  assert.equal(shape(wf.steps), 'a,L{b,c},d');
  wrapSteps(wf, ['L', 'd'], { id: 'B', type: 'branch', config: {} }, { slotKeys });
  assert.equal(shape(wf.steps), 'a,B{L{b,c},d|}');
});

test('removeSteps removes scattered steps with what is inside them', () => {
  const wf = tree([r('a'), loop('l', [r('b'), r('c')]), r('d')]);
  const removed = removeSteps(wf, ['d', 'b', 'l'], { slotKeys });
  assert.deepEqual(removed.map((s) => s.id), ['l', 'd']);
  assert.equal(shape(wf.steps), 'a');
});

test('moveBlock / neighbourTargetBlock: a block walks in and out of frames, jumping over collapsed ones', () => {
  const wf = tree([r('a'), r('x'), r('y'), loop('l', [r('b')]), r('c')]);
  const step = (dir, collapsed) => {
    const t = neighbourTargetBlock(wf, ['x', 'y'], dir, collapsed, slotKeys);
    if (t) assert.equal(moveBlock(wf, ['x', 'y'], t, slotKeys), true);
    return t ? shape(wf.steps) : null;
  };
  assert.equal(step(+1), 'a,l{x,y,b},c', 'enters the open loop at the top');
  assert.equal(step(+1), 'a,l{b,x,y},c');
  assert.equal(step(+1), 'a,l{b},x,y,c', 'leaves the loop right after it');
  assert.equal(step(+1), 'a,l{b},c,x,y');
  assert.equal(step(+1), null, 'already last');
  assert.equal(step(-1), 'a,l{b},x,y,c');
  assert.equal(step(-1, new Set(['l'])), 'a,x,y,l{b},c', 'collapsed containers are jumped over');
  assert.equal(step(-1), 'x,y,a,l{b},c');
  assert.equal(step(-1), null, 'already first');
  // Drag and drop of a block: before-move coordinates; into itself and in place are refused.
  assert.equal(moveBlock(wf, ['x', 'y'], { parentId: null, slot: null, index: 4 }, slotKeys), true);
  assert.equal(shape(wf.steps), 'a,l{b},x,y,c');
  assert.equal(moveBlock(wf, ['x', 'y'], { parentId: null, slot: null, index: 3 }, slotKeys), false, 'already there');
  assert.equal(moveBlock(wf, ['l', 'x'], { parentId: 'l', slot: 'body', index: 0 }, slotKeys), false, 'into itself');
  assert.equal(moveBlock(wf, ['a', 'x'], { parentId: null, slot: null, index: 5 }, slotKeys), false, 'not one block');
  assert.equal(neighbourTargetBlock(wf, ['a', 'x'], 1, new Set(), slotKeys), null);
});

test('pasteSteps keeps free aliases, renames taken ones (inner references follow), ids always new', () => {
  const catalog = scopeCatalog();
  const lookup = (ref) => ({ name: 'AccountId', type: 'lookup', options: { mode: 'random', ref } });
  const tpl = (t) => ({ name: 'Title', type: 'template', options: { template: t } });
  const copied = [r('acc', 'acc'), loop('loopCon', [r('con', 'con', [lookup('acc'), tpl('{{acc.Name}} {{users.Name}}')])], { count: 2 })];

  // Into an empty workflow: names kept.
  const empty = tree([]);
  const res = pasteSteps(empty, { parentId: null, slot: null, index: 0 }, copied, { catalog, slotKeys });
  assert.deepEqual(res.ids, ['acc_2', 'loopCon_2']);
  assert.deepEqual(res.renamed, []);
  assert.deepEqual(res.missing, ['users']);
  assert.equal(findStep(empty, 'con_2').step.config.fields[0].options.ref, 'acc');

  // Into the workflow it came from: taken names get the next free one, references inside follow.
  const same = tree(structuredClone(copied));
  const res2 = pasteSteps(same, { parentId: null, slot: null, index: 2 }, copied, { catalog, slotKeys });
  assert.deepEqual(res2.ids, ['acc_2', 'loopCon_2']);
  assert.deepEqual(res2.renamed, [{ from: 'acc', to: 'acc2' }, { from: 'con', to: 'con2' }]);
  const con2 = findStep(same, 'con_2').step;
  assert.deepEqual([con2.config.alias, con2.config.fields[0].options.ref, con2.config.fields[1].options.template], ['con2', 'acc2', '{{acc2.Name}} {{users.Name}}']);
  assert.equal(findStep(same, 'con').step.config.fields[0].options.ref, 'acc', 'the original is untouched');
  assert.equal(collectIds(same).size, 6);
});

test('pasteSteps renames a loop variable that would shadow an enclosing loop; its body follows', () => {
  const catalog = scopeCatalog();
  const tpl = (t) => ({ name: 'T', type: 'template', options: { template: t } });
  const copied = [loop('inner', [r('c', 'c', [tpl('{{loop.index}}')])], { count: 2 })];
  const wf = tree([loop('outer', [], { count: 3 })]);
  const res = pasteSteps(wf, { parentId: 'outer', slot: 'body', index: 0 }, copied, { catalog, slotKeys });
  const pasted = findStep(wf, res.ids[0]).step;
  assert.equal(pasted.config.alias, 'loop2');
  assert.equal(pasted.slots.body[0].config.fields[0].options.template, '{{loop2.index}}');
  assert.deepEqual(res.renamed, [{ from: 'loop', to: 'loop2' }]);
  // At the root nothing is shadowed: the name stays.
  const root = tree([loop('outer', [], { count: 3 })]);
  const res2 = pasteSteps(root, { parentId: null, slot: null, index: 1 }, copied, { catalog, slotKeys });
  assert.equal(findStep(root, res2.ids[0]).step.config.alias, 'loop');
  assert.deepEqual(res2.renamed, []);
});

test('countSteps counts nested steps', () => {
  assert.equal(countSteps([r('a'), loop('l', [r('b'), branch('br', [r('t')], [])])]), 5);
  assert.equal(countSteps([]), 0);
});

test('pasteSteps: renames never chain (acc → acc2 while acc2 is also pasted) (0012 review)', () => {
  const catalog = scopeCatalog();
  const lookup = (ref) => ({ name: 'AccountId', type: 'lookup', options: { mode: 'random', ref } });
  const copied = [r('a1', 'acc'), r('a2', 'acc2'), r('c1', 'c1', [lookup('acc')]), r('c2', 'c2', [lookup('acc2')])];
  const wf = tree([r('x', 'acc')]);
  const res = pasteSteps(wf, { parentId: null, slot: null, index: 1 }, copied, { catalog, slotKeys });
  const [p1, p2, c1, c2] = res.ids.map((id) => findStep(wf, id).step);
  assert.notEqual(p1.config.alias, p2.config.alias);
  assert.equal(c1.config.fields[0].options.ref, p1.config.alias, 'c1 still points at the copy of acc');
  assert.equal(c2.config.fields[0].options.ref, p2.config.alias, 'c2 still points at the copy of acc2');
  assert.deepEqual([p1.config.alias, p2.config.alias], ['acc3', 'acc2'], 'acc2 is free here, so it is kept');
  // Ctrl+D of the same four steps in one workflow: no chain either.
  const same = tree(structuredClone(copied));
  const { steps } = cloneSteps(same.steps, { ids: collectIds(same), aliases: collectAliases(same, catalog), catalog });
  assert.deepEqual(steps.map((s) => s.config.alias), ['acc3', 'acc4', 'c3', 'c4']);
  assert.deepEqual(steps.slice(2).map((s) => s.config.fields[0].options.ref), ['acc3', 'acc4']);
});

test('pasteSteps renames a record alias that equals a loop variable around the target', () => {
  const catalog = scopeCatalog();
  const tpl = (t) => ({ name: 'T', type: 'template', options: { template: t } });
  const wf = tree([loop('outer', [], { count: 3, alias: 'row' })]);
  const res = pasteSteps(wf, { parentId: 'outer', slot: 'body', index: 0 }, [r('a', 'row'), r('b', 'b', [tpl('{{row.Name}}')])], { catalog, slotKeys });
  const [a, b] = res.ids.map((id) => findStep(wf, id).step);
  assert.equal(a.config.alias, 'row2');
  assert.equal(b.config.fields[0].options.template, '{{row2.Name}}');
  assert.deepEqual(res.renamed, [{ from: 'row', to: 'row2' }]);
});

test('pasteSteps: a rename never lands on a loop variable inside the copy (0012 review 2)', () => {
  const catalog = scopeCatalog();
  const tpl = (t) => ({ name: 'T', type: 'template', options: { template: t } });
  const copied = [r('a', 'item'), loop('l', [r('c', 'c', [tpl('{{item.Name}} #{{item2}}')])], { count: 2, alias: 'item2' })];
  const wf = tree([r('x', 'item')]);
  const res = pasteSteps(wf, { parentId: null, slot: null, index: 1 }, copied, { catalog, slotKeys });
  const [a, l] = res.ids.map((id) => findStep(wf, id).step);
  assert.equal(a.config.alias, 'item3');
  assert.equal(l.config.alias, 'item2', 'the loop variable is not taken here: it stays');
  assert.equal(l.slots.body[0].config.fields[0].options.template, '{{item3.Name}} #{{item2}}');
  assert.deepEqual(res.renamed, [{ from: 'item', to: 'item3' }]);
});

test('Ctrl+D inside a loop: the copy does not take the name of the enclosing loop variable (0012 review 2)', () => {
  const catalog = scopeCatalog();
  const tpl = (t) => ({ name: 'T', type: 'template', options: { template: t } });
  const wf = tree([loop('l', [r('a', 'row'), r('b', 'b', [tpl('{{row2.index}}')])], { count: 2, alias: 'row2' })]);
  const at = findStep(wf, 'a', slotKeys);
  // As client/js/ops.js duplicateStep: the record aliases plus the loop variables around the step.
  const aliases = new Set([...collectAliases(wf, catalog), ...loopVarsAround(wf, { parentId: at.parentId }, slotKeys)]);
  const { steps: [copy] } = cloneSteps([at.step], { ids: collectIds(wf), aliases, catalog });
  assert.equal(copy.config.alias, 'row3');
});
