// Design 0005: analyzeScope (shared/scope.js), the single scope analysis used by validation,
// the Lookup "Bản ghi cha" dropdown, the variable picker and rename propagation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScope, refChoices, refsTo, loopMinIterations, tokenize, stripPath, hasUnclosed, closest, referenceOptions, optionShown, pathsIn, numberVarPath, isVar, numericSampleFields } from '../shared/scope.js';
import { scopeCatalog, validateWorkflow } from '../server/workflow/schema.js';
import { NODE_TYPES } from '../server/workflow/nodes.js';
import { describeGenerators } from '../server/generators/index.js';
import { wf, record, loop, branch, query, pick } from './helpers.js';

const catalog = scopeCatalog();
const r = (id, alias = id, fields = []) => record(id, 'Account', alias, fields);
const tpl = (name, template) => ({ name, type: 'template', options: { template } });
const scopeOf = (w) => analyzeScope(w, catalog);
const nameOf = (scope, id) => scope.sources[id].name;
/** "name:certainty" for visible, "name:-reason" for hidden, at `id`. */
const view = (scope, id) => [
  ...scope.at[id].visible.map((v) => `${nameOf(scope, v.source)}:${v.certainty}`),
  ...scope.at[id].hidden.map((v) => `${nameOf(scope, v.source)}:-${v.reason}`),
];
const stateOf = (scope, id, source) => view(scope, id).find((x) => x.startsWith(`${nameOf(scope, source)}:`))?.split(':')[1];

test('scope: upstream record and enclosing loop vars are visible in the loop body, nearest first', () => {
  const w = wf([loop('loopAcc', { count: 5, alias: 'i' }, [r('acc', 'acc'), loop('loopCon', { mode: 'range', min: 1, max: 4 }, [r('con', 'con')])])]);
  const scope = scopeOf(w);
  // The run variables (0013 G) always come last.
  assert.deepEqual(scope.at.con.visible.map((v) => v.source), ['loopCon', 'acc', 'loopAcc', '$run']);
  assert.ok(scope.at.con.visible.every((v) => v.certainty === 'always'));
  assert.deepEqual(view(scope, 'acc'), ['i:always', 'run:always', 'acc:-after', 'loop:-outsideLoop', 'con:-after']);
  assert.equal(scope.at.acc.hidden[0].note, 'là chính bước này');
  assert.equal(scope.at.acc.hidden.find((h) => h.source === 'loopCon').note, 'chỉ có bên trong vòng lặp "loop"');
  assert.equal(scope.partial, false);
  // Sources carry what the picker shows: members with value types, builtins, loop examples.
  const acc = scope.sources.acc;
  assert.equal(acc.kind, 'record');
  assert.equal(acc.sobject, 'Account');
  assert.deepEqual(acc.members.map((m) => m.key), ['$n']);
  assert.equal(acc.members[0].example, '1, 2, 3…');
  assert.equal(scope.sources.loopCon.label, 'Vòng lặp 1–4 lần');
  assert.deepEqual(scope.sources.loopCon.members.map((m) => `${m.key}=${m.example}`), ['index=1…4', 'index0=0…3', 'count=1–4']);
  assert.deepEqual(scope.sources.loopAcc.members.map((m) => m.example), ['1…5', '0…4', '5']);
});

test('scope: record created in one branch is maybe after the branch; the other branch sees it as otherBranch', () => {
  const w = wf([branch('b', {}, [r('yes'), r('useYes')], [r('no')]), r('after')]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'useYes', 'yes'), 'always');
  assert.equal(stateOf(scope, 'no', 'yes'), '-otherBranch');
  assert.equal(stateOf(scope, 'after', 'yes'), 'maybe');
  assert.equal(scope.at.after.visible.find((v) => v.source === 'yes').note, 'chỉ được tạo ở một số nhánh phía trên');
});

test('scope: record created in a finished loop body is last; maybe when the loop can run 0 times', () => {
  const w = wf([
    loop('l', { count: 2 }, [r('inLoop')]),
    loop('z', { mode: 'range', min: 0, max: 2, alias: 'zl' }, [r('zeroLoop')]),
    loop('f', { count: 0, alias: 'fl' }, [r('never')]),
    r('use'),
  ]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'use', 'inLoop'), 'last');
  assert.equal(stateOf(scope, 'use', 'zeroLoop'), 'maybe');
  assert.equal(stateOf(scope, 'use', 'never'), 'maybe');
  assert.equal(scope.at.use.visible.find((v) => v.source === 'zeroLoop').note, 'vòng lặp "zl" có thể chạy 0 lần');
  assert.equal(scope.at.use.visible.find((v) => v.source === 'inLoop').note, 'bản ghi cuối');
});

test('scope: loop var after the loop is hidden as outsideLoop', () => {
  const w = wf([loop('l', { count: 2, alias: 'i' }, [r('a')]), r('b', 'b', [tpl('T', '{{i.index}}')])]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'b', 'l'), '-outsideLoop');
  const ref = scope.refs.find((x) => x.nodeId === 'b');
  assert.deepEqual([ref.source, ref.code, ref.field, ref.option, ref.path], ['l', 'outsideLoop', 'fields.T', 'template', 'i.index']);
});

test('scope: nested loops with the same alias, inner shadows outer', () => {
  const w = wf([loop('outer', { count: 2 }, [loop('inner', { count: 3 }, [r('a', 'a', [tpl('T', '{{loop.index}}')])]), r('b', 'b', [tpl('T', '{{loop.count}}')])])]);
  const scope = scopeOf(w);
  assert.deepEqual(view(scope, 'a').filter((x) => x.startsWith('loop:')), ['loop:always', 'loop:-shadowed']);
  assert.equal(scope.at.a.visible[0].source, 'inner');
  assert.equal(scope.at.a.hidden.find((h) => h.source === 'outer').reason, 'shadowed');
  const [ra, rb] = ['a', 'b'].map((id) => scope.refs.find((x) => x.nodeId === id));
  assert.equal(ra.source, 'inner');
  assert.equal(rb.source, 'outer');
  assert.equal(ra.code ?? null, null);
  assert.deepEqual(refsTo(scope, 'inner').map((x) => x.nodeId), ['a']);
});

test('scope: disabled step is hidden as disabled and its own references are flagged disabled', () => {
  const w = wf([{ ...r('off', 'off', [tpl('T', '{{nope.X}}')]), disabled: true }, { ...loop('dl', { count: 2, alias: 'dv' }, [r('inside', 'inside', [tpl('T', '{{dv.index}}')])]), disabled: true }, r('use', 'use', [tpl('T', '{{off.$n}}')])]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'use', 'off'), '-disabled');
  assert.equal(stateOf(scope, 'use', 'inside'), '-disabled');
  // A loop variable used outside its loop is outsideLoop, even when the loop is turned off (review fix).
  assert.equal(stateOf(scope, 'use', 'dl'), '-outsideLoop');
  assert.equal(scope.at.off.disabled, true);
  assert.equal(scope.refs.find((x) => x.nodeId === 'use').code, 'disabled');
  assert.ok(scope.refs.filter((x) => x.nodeId !== 'use').every((x) => x.disabled));
  // Inside a turned-off loop the variable still resolves (rename keeps working there).
  assert.equal(scope.refs.find((x) => x.nodeId === 'inside').source, 'dl');
});

test('scope: this.* sees fields above, $n, and reports below / self / unknown', () => {
  const fields = [{ name: 'FirstName', type: 'text' }, tpl('Title', '{{this.FirstName}} {{this.$n}} {{this.Email}} {{this.Title}} {{this.Frstname}}'), { name: 'Email', type: 'email' }];
  const scope = scopeOf(wf([r('c', 'con', fields)]));
  const codes = scope.refs.map((x) => `${x.path}:${x.code ?? 'ok'}`);
  assert.deepEqual(codes, ['this.FirstName:ok', 'this.$n:ok', 'this.Email:thisBelow', 'this.Title:thisSelf', 'this.Frstname:thisUnknown']);
  assert.equal(scope.refs[4].suggestion.to, 'this.FirstName');
});

test('scope: query and pick sources expose select fields and fromSource members (contract for 0006)', () => {
  // 0006 is not built yet: a catalogue with the declared exposes of Query / Chọn bản ghi.
  const query = {
    type: 'query', slots: [], flow: { kind: 'sequence' }, options: [{ key: 'alias', kind: 'string' }, { key: 'sobject', kind: 'string' }],
    exposes: { kind: 'record', name: { key: 'alias' }, label: { key: 'sobject' }, visibleIn: 'downstream', members: 'select', current: 'none', pool: true, origin: 'org', lookupParent: true, builtins: [{ key: '$count', valueType: 'number', label: 'Số bản ghi đọc được' }] },
  };
  const pick = {
    type: 'pick', slots: [], flow: { kind: 'sequence' }, options: [{ key: 'alias', kind: 'string' }, { key: 'from', kind: 'ref', accepts: { pool: true } }],
    exposes: { kind: 'record', name: { key: 'alias' }, label: { fromSource: 'from' }, visibleIn: 'downstream', members: { fromSource: 'from' }, current: 'picked', pool: true, origin: { fromSource: 'from' }, lookupParent: true },
  };
  const cat = { nodeTypes: [...NODE_TYPES, query, pick], fieldTypes: describeGenerators() };
  const w = wf([
    { id: 'q', type: 'query', config: { alias: 'accs', sobject: 'Account', fields: ['Name', 'Owner.Name'] } },
    { id: 'p', type: 'pick', config: { alias: 'a', from: 'accs' } },
    r('c', 'con', [tpl('T', '{{accs.Name}} {{accs.$count}} {{a.Name}} {{a.Owner.Name}} {{a.Id}} {{a.Industry}}')]),
  ]);
  const scope = analyzeScope(w, cat);
  assert.deepEqual(scope.sources.q.members.map((m) => m.key), ['Id', 'Name', 'Owner', '$count']);
  assert.deepEqual(scope.sources.q.members[2].members.map((m) => m.key), ['Name']);
  assert.equal(scope.sources.q.current, 'none');
  assert.equal(scope.sources.p.label, 'Account');
  assert.equal(scope.sources.p.origin, 'org');
  assert.deepEqual(scope.sources.p.members.map((m) => m.key), ['Id', 'Name', 'Owner']);
  const codes = scope.refs.map((x) => `${x.path}:${x.code ?? 'ok'}`);
  assert.deepEqual(codes, ['accs:ok', 'accs.Name:noCurrent', 'accs.$count:ok', 'a.Name:ok', 'a.Owner.Name:ok', 'a.Id:ok', 'a.Industry:unknownMember']);
  // pick.from only lists pools; Lookup lists lookup parents.
  assert.deepEqual(refChoices(scope, 'c', { pool: true }).filter((x) => x.usable).map((x) => x.name), ['a', 'accs']);
});

test('scope: refChoices lists usable parents nearest first, then the rest with a reason', () => {
  const w = wf([r('a'), loop('l', { count: 1 }, [r('b')]), r('here', 'here', [{ name: 'P', type: 'lookup', options: { ref: 'b' } }]), r('c')]);
  const scope = scopeOf(w);
  const choices = refChoices(scope, 'here');
  assert.deepEqual(choices.map((c) => `${c.name}:${c.usable ? c.certainty : `-${c.reason}`}:${c.note}`), ['b:last:bản ghi cuối', 'a:always:', 'c:-after:chạy sau bước này']);
  assert.deepEqual(scope.refs.map((x) => `${x.field}:${x.mode}:${x.source}:${x.certainty}`), ['fields.P:ref:b:last']);
  // A mode 'fixed' Lookup has no ref to check (the option is hidden): listed with `hidden`, so renames follow it.
  const fixed = scopeOf(wf([r('x', 'x', [{ name: 'P', type: 'lookup', options: { mode: 'fixed', ref: 'zzz', ids: ['001'] } }])]));
  assert.deepEqual(fixed.refs.map((x) => `${x.path}:${x.hidden}`), ['zzz:true']);
  assert.deepEqual(validateWorkflow(wf([r('x', 'x', [{ name: 'P', type: 'lookup', options: { mode: 'fixed', ref: 'zzz', ids: ['001'] } }])])).errors, []);
});

test('scope: helpers — loopMinIterations, tokenize, stripPath, hasUnclosed, closest', () => {
  assert.equal(loopMinIterations({ count: 3 }), 3);
  assert.equal(loopMinIterations({ count: 0 }), 0);
  assert.equal(loopMinIterations({}), 0);
  assert.equal(loopMinIterations({ mode: 'range', min: 0, max: 4 }), 0);
  assert.equal(loopMinIterations({ mode: 'range', max: 4 }), 1);
  assert.deepEqual(tokenize('{{acc.Industry}} contact #{{ loop.index }}').map((p) => p.kind === 'token' ? `[${p.path}]` : p.text), ['[acc.Industry]', ' contact #', '[loop.index]']);
  assert.equal(stripPath(' {{ loop.index }} '), 'loop.index');
  assert.equal(stripPath('acc.Name'), 'acc.Name');
  assert.equal(hasUnclosed('a {{acc.Name'), true);
  assert.equal(hasUnclosed('{{acc.Name}} b'), false);
  assert.equal(closest('acco', ['acc', 'con']), 'acc');
  assert.equal(closest('name', ['Name', 'Nam']), 'Name');
  assert.equal(closest('i', ['z']), null);
});

test('scope: analysis stays linear — a 1000-step workflow is analysed well under a second (review fix)', () => {
  // Quadratic versions took ~1.5 s here (each step copied the visible set and listed every hidden source).
  const steps = [];
  for (let l = 0; l < 50; l++) {
    const body = [];
    for (let k = 0; k < 19; k++) {
      const fields = [];
      for (let f = 0; f < 10; f++) fields.push(f % 2 ? { name: `F${f}`, type: 'text' } : tpl(`F${f}`, `{{l${l}.index}} {{r${l}_${Math.max(0, k - 1)}.F1}} {{this.F1}}`));
      body.push(r(`r${l}_${k}`, `r${l}_${k}`, fields));
    }
    steps.push(loop(`L${l}`, { count: 2, alias: `l${l}` }, body));
  }
  const w = wf(steps);
  analyzeScope(w, catalog); // warm-up
  const t0 = performance.now();
  const scope = analyzeScope(w, catalog);
  const ms = performance.now() - t0;
  assert.equal(Object.keys(scope.at).length, 1000);
  assert.ok(scope.refs.length >= 14000);
  assert.ok(ms < 1000, `analyzeScope took ${ms.toFixed(0)} ms for 1000 steps`);
  // Lazy per-step lists still work on a big workflow.
  assert.equal(scope.at.r49_18.visible[0].source, 'r49_17');
});

test('scope (0006, real catalogue): SOQL members, open FIELDS(), pools for pick.from and Lookup labels', () => {
  const w = wf([
    { id: 'q', type: 'query', config: { mode: 'soql', alias: 'pbes', soql: 'SELECT Id, UnitPrice, Product2.Name FROM PricebookEntry ORDER BY Id' } },
    { id: 'o', type: 'query', config: { mode: 'soql', alias: 'opens', soql: 'SELECT FIELDS(STANDARD) FROM Account LIMIT 200' } },
    { id: 'p', type: 'pick', config: { from: 'pbes', alias: 'pbe' } },
    { id: 'p2', type: 'pick', config: { from: 'opens', alias: 'open1' } },
    r('c', 'con', [tpl('T', '{{pbe.Product2.Name}} {{pbe.Nope}} {{open1.Whatever}}')]),
  ]);
  const scope = analyzeScope(w, catalog);
  assert.deepEqual([scope.sources.q.sobject, scope.sources.q.label], ['PricebookEntry', 'PricebookEntry']);
  assert.deepEqual(scope.sources.q.members.map((m) => m.key), ['Id', 'UnitPrice', 'Product2', '$count']);
  assert.equal(scope.sources.o.open, true);
  assert.deepEqual([scope.sources.p.from, scope.sources.p.root, scope.sources.p.origin, scope.sources.p.sobject], ['pbes', 'q', 'org', 'PricebookEntry']);
  assert.deepEqual(scope.refs.filter((x) => x.nodeId === 'c').map((x) => `${x.path}:${x.code ?? 'ok'}`), ['pbe.Product2.Name:ok', 'pbe.Nope:unknownMember', 'open1.Whatever:openMember']);
  const pools = refChoices(scope, 'c', { pool: true }).filter((x) => x.usable);
  assert.deepEqual(pools.map((x) => `${x.name}:${x.nodeType}${x.from ? `<${x.from}` : ''}`), ['open1:pick<opens', 'pbe:pick<pbes', 'opens:query', 'pbes:query']);
  // A pool used by nothing but the picks is fine; a loop variable is not a pool.
  assert.ok(!refChoices(wf([loop('l', { count: 1 }, [{ id: 'x', type: 'pick', config: { from: '', alias: 'a' } }])]), 'x', { pool: true }).length);
});

// ---------- design 0010: Lặp "Mỗi bản ghi trong pool" ----------

const q = (id, alias, fields = ['Id', 'Name']) => ({ id, type: 'query', config: { sobject: 'Account', alias, fields } });
const each = (id, from, itemAlias, body = [], extra = {}) => loop(id, { mode: 'each', from, itemAlias, ...extra }, body);

test('scope: loopMinIterations is 0 in each mode', () => {
  assert.equal(loopMinIterations({ mode: 'each', count: 5 }), 0, 'count is ignored in each mode');
  assert.equal(loopMinIterations({ mode: 'fixed', count: 5 }), 5);
  assert.equal(catalog.nodeTypes.find((t) => t.type === 'loop').minIterations({ mode: 'each' }), 0);
});

test('scope: each item alias is visible inside the body with the pool sObject', () => {
  const w = wf([
    q('q', 'accs', ['Id', 'Name', 'Industry']),
    each('l', 'accs', 'acc', [r('con', 'con', [tpl('T', '{{acc.Name}} {{acc.industry}} {{loop.count}}')]), loop('in', { count: 2, alias: 'j' }, [r('deep')])]),
  ]);
  const scope = scopeOf(w);
  const item = scope.sources['l#item'];
  assert.deepEqual([item.nodeId, item.name, item.sobject, item.current, item.pool, item.origin, item.from, item.root], ['l', 'acc', 'Account', 'item', false, 'org', 'accs', 'q']);
  // Pool fields, without the pool-level built-in $count.
  assert.deepEqual(item.members.map((m) => m.key), ['Id', 'Name', 'Industry']);
  assert.equal(stateOf(scope, 'con', 'l#item'), 'always');
  assert.equal(stateOf(scope, 'deep', 'l#item'), 'always', 'also in a frame nested in the body');
  assert.deepEqual(scope.refs.filter((x) => x.nodeId === 'con').map((x) => `${x.path}:${x.source}:${x.code ?? 'ok'}`), ['acc.Name:l#item:ok', 'acc.industry:l#item:ok', 'loop.count:l:ok']);
  // A Lookup can point at it (nearest first), a pool option cannot.
  assert.equal(refChoices(scope, 'con').find((x) => x.usable).name, 'acc');
  assert.ok(!refChoices(scope, 'con', { pool: true }).some((x) => x.name === 'acc'));
  // A generated pool: fields of the Record and its record-level $n.
  const g = scopeOf(wf([r('a', 'acc', [tpl('Name', 'x')]), each('l', 'acc', 'a2', [r('o')])]));
  assert.deepEqual(g.sources['l#item'].members.map((m) => m.key), ['Name', '$n']);
  assert.equal(g.sources['l#item'].origin, 'generated');
  // Fixed / range loops do not have the record (no source), even with a stale itemAlias.
  assert.equal(scopeOf(wf([q('q', 'accs'), loop('l', { mode: 'fixed', count: 1, from: 'accs', itemAlias: 'acc' })])).sources['l#item'], undefined);
});

test('scope: each item alias is outsideLoop after the loop', () => {
  const w = wf([q('q', 'accs'), each('l', 'accs', 'acc', [r('in')]), r('after', 'after', [tpl('T', '{{acc.Name}}')])]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'after', 'l#item'), '-outsideLoop');
  assert.equal(scope.at.after.hidden.find((x) => x.source === 'l#item').note, 'chỉ có bên trong vòng lặp "loop"');
  assert.equal(stateOf(scope, 'l', 'l#item'), '-outsideLoop', 'not at the loop itself');
  assert.deepEqual(scope.refs.filter((x) => x.nodeId === 'after').map((x) => x.code), ['outsideLoop']);
  // Turned off, the loop's record is still "outside" (like a loop variable), not "turned off".
  const off = scopeOf(wf([q('q', 'accs'), { ...each('l', 'accs', 'acc', [r('in')]), disabled: true }, r('after', 'after', [tpl('T', '{{acc.Name}}')])]));
  assert.equal(stateOf(off, 'after', 'l#item'), '-outsideLoop');
});

test('scope: sources created in an each loop are maybe after it', () => {
  const w = wf([q('q', 'accs'), each('l', 'accs', 'acc', [r('con')]), r('after')]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 'after', 'con'), 'maybe');
  assert.deepEqual(scope.at.after.visible.find((v) => v.source === 'con').why, { loop: 'loop', loopId: 'l', range: false, each: 'accs' });
  // A missing pool: the record is still declared inside (no knock-on errors), only `from` fails.
  const bad = scopeOf(wf([each('l', 'nope', 'acc', [r('c', 'c', [tpl('T', '{{acc.Name}}')])])]));
  assert.deepEqual(bad.refs.map((x) => `${x.nodeId}.${x.field}:${x.code ?? 'ok'}`), ['l.from:unknownName', 'c.fields.T:ok']);
});

// ---------- design 0013: number variables, each extras, values loop, run variables ----------

const num = (name) => ({ name, type: 'number', options: {} });
const day = (name) => ({ name, type: 'date', options: {} });
const refsAt = (scope, id, field) => scope.refs.filter((x) => x.nodeId === id && (field === undefined || x.field === field));

test('showIf is transitive: an option whose showIf key is hidden is hidden', () => {
  const defs = [
    { key: 'mode', default: 'fixed' },
    { key: 'filter', default: 'none', showIf: { key: 'mode', in: ['each'] } },
    { key: 'filterValue', default: '', showIf: { key: 'filter', in: ['compare'] } },
  ];
  const fv = defs[2];
  assert.equal(optionShown(defs, fv, { mode: 'fixed', filter: 'compare' }), false, 'filter is hidden in fixed mode, so is its value');
  assert.equal(optionShown(defs, fv, { mode: 'each', filter: 'none' }), false);
  assert.equal(optionShown(defs, fv, { mode: 'each', filter: 'compare' }), true);
  // A cycle in a broken catalogue does not hang.
  const cyc = [{ key: 'a', showIf: { key: 'b', in: [1] } }, { key: 'b', showIf: { key: 'a', in: [1] } }];
  assert.equal(optionShown(cyc, cyc[0], { a: 1, b: 1 }), true);
  // The real catalogue: the filter value of a Lặp is hidden (still listed for renames) unless each + compare.
  const at = (config) => referenceOptions(loop('l', config, []), catalog, { includeHidden: true }).find((o) => o.option === 'filterValue');
  assert.equal(at({ mode: 'fixed', filter: 'compare', filterValue: '{{acc.Id}}' }).hidden, true);
  assert.equal(at({ mode: 'each', filterValue: '{{acc.Id}}' }).hidden, true);
  assert.equal(at({ mode: 'each', filter: 'compare', filterValue: '{{acc.Id}}' }).hidden, false);
});

test('number mode references are analysed like templates and carry valueType', () => {
  const w = wf([
    record('a', 'Account', 'acc', [num('NumberOfEmployees'), day('Since__c'), tpl('Note', 'x')]),
    loop('l1', { count: '{{acc.NumberOfEmployees}}' }, [r('x1')]),
    loop('l2', { mode: 'range', min: 1, max: ' {{ acc.$n }} ' }, [r('x2')]),
    loop('l3', { count: '{{acc.Since__c}}' }, [r('x3')]),
    loop('l4', { count: '{{acc.Note}}' }, [r('x4')]),
  ]);
  const scope = scopeOf(w);
  const [c1] = refsAt(scope, 'l1', 'count');
  assert.deepEqual([c1.mode, c1.path, c1.valueType, c1.code], ['number', 'acc.NumberOfEmployees', 'number', undefined]);
  assert.deepEqual(refsAt(scope, 'l2', 'max').map((x) => [x.path, x.valueType, x.code]), [['acc.$n', 'number', undefined]]);
  assert.deepEqual(refsAt(scope, 'l3', 'count').map((x) => [x.valueType, x.code, x.level]), [['date', 'notNumber', 'error']]);
  assert.deepEqual(refsAt(scope, 'l4', 'count').map((x) => [x.valueType, x.code, x.level]), [['string', 'notNumber', 'warning']]);
  assert.deepEqual([numberVarPath(' {{ acc.X }} '), numberVarPath('{{acc.X}} lần'), numberVarPath(5), isVar('{{a.b}}'), isVar('5')], ['acc.X', null, null, true, false]);
});

test('numeric values of a number option hold no reference', () => {
  assert.deepEqual(pathsIn('number', 5), []);
  assert.deepEqual(pathsIn('number', undefined), []);
  assert.deepEqual(pathsIn('number', '12'), []);
  assert.deepEqual(pathsIn('number', '{{a.b}}').map((p) => p.path), ['a.b']);
  const scope = scopeOf(wf([loop('l', { count: 5 }, [r('x')]), loop('m', { mode: 'range', min: 2, max: 4 }, [r('y')])]));
  assert.deepEqual(refsAt(scope, 'l'), []);
  assert.deepEqual(refsAt(scope, 'm'), []);
});

test('loopMinIterations: variable counts give 0, values give the list length', () => {
  assert.equal(loopMinIterations({ count: '{{acc.N}}' }), 0);
  assert.equal(loopMinIterations({ mode: 'range', min: '{{acc.N}}', max: 5 }), 0);
  assert.equal(loopMinIterations({ mode: 'range', min: 2, max: '{{acc.N}}' }), 2, 'max < min uses min while running');
  assert.equal(loopMinIterations({ mode: 'values', values: ['Hot', ' ', 'Warm', 'Cold'] }), 3);
  assert.equal(loopMinIterations({ mode: 'values', values: 'Hot\nWarm' }), 2);
  assert.equal(loopMinIterations({ mode: 'values' }), 0);
  assert.equal(loopMinIterations({ mode: 'each', from: 'acc' }, { poolNonEmpty: () => true }), 1);
  assert.equal(loopMinIterations({ mode: 'each', from: 'acc', limit: 2 }, { poolNonEmpty: () => true }), 1);
  assert.equal(loopMinIterations({ mode: 'each', from: 'acc', filter: 'compare' }, { poolNonEmpty: () => true }), 0);
});

test('an each loop over an always Record pool runs at least once (no maybe after it)', () => {
  const w = wf([
    record('a', 'Account', 'acc', [], { count: 5 }),
    loop('l', { mode: 'each', from: 'acc', itemAlias: 'it' }, [record('c', 'Contact', 'con')]),
    record('t', 'Task', 'task', [{ name: 'WhoId', type: 'lookup', options: { ref: 'con' } }]),
  ]);
  const scope = scopeOf(w);
  assert.equal(stateOf(scope, 't', 'c'), 'last');
  assert.deepEqual(validateWorkflow(w).warnings.filter((x) => x.code === 'maybe'), []);
});

test('an each loop with a filter, over a Query, or over a maybe pool may run 0 times', () => {
  const after = (l) => [l, record('t', 'Task', 'task', [{ name: 'WhoId', type: 'lookup', options: { ref: 'con' } }])];
  const body = [record('c', 'Contact', 'con')];
  const filtered = wf([record('a', 'Account', 'acc'), ...after(loop('l', { mode: 'each', from: 'acc', itemAlias: 'it', filter: 'compare', filterField: 'Name', filterValue: 'x' }, body))]);
  assert.equal(stateOf(scopeOf(filtered), 't', 'c'), 'maybe');
  const overQuery = wf([query('q', 'accs'), ...after(loop('l', { mode: 'each', from: 'accs', itemAlias: 'it' }, body))]);
  assert.equal(stateOf(scopeOf(overQuery), 't', 'c'), 'maybe');
  const maybePool = wf([branch('b', {}, [record('a', 'Account', 'acc')]), ...after(loop('l', { mode: 'each', from: 'acc', itemAlias: 'it' }, body))]);
  assert.equal(stateOf(scopeOf(maybePool), 't', 'c'), 'maybe');
  const overPick = wf([record('a', 'Account', 'acc'), pick('p', 'pa', 'acc'), ...after(loop('l', { mode: 'each', from: 'pa', itemAlias: 'it' }, body))]);
  assert.equal(stateOf(scopeOf(overPick), 't', 'c'), 'maybe', 'a Chọn bản ghi may skip: not nonEmpty');
});

test('loop.value exists only in values mode', () => {
  const use = (config) => wf([loop('l', config, [r('x', 'x', [tpl('T', '{{loop.value}}')])])]);
  const ok = scopeOf(use({ mode: 'values', values: ['Hot', 'Warm'] }));
  assert.deepEqual(refsAt(ok, 'x').map((x) => [x.source, x.code, x.valueType]), [['l', undefined, 'string']]);
  assert.equal(ok.sources.l.label, 'Vòng lặp theo 2 giá trị');
  assert.equal(ok.sources.l.members.find((m) => m.key === 'value').example, '"Hot", "Warm"');
  const bad = scopeOf(use({ count: 3 }));
  assert.deepEqual(refsAt(bad, 'x').map((x) => x.code), ['unknownMember']);
  assert.deepEqual(bad.sources.l.members.map((m) => m.key), ['index', 'index0', 'count']);
  const msg = validateWorkflow(use({ count: 3 })).errors.find((e) => e.nodeId === 'x').message;
  assert.match(msg, /không có "value"\. \{\{loop\.value\}\} chỉ có khi "Lặp theo" là "Mỗi giá trị trong danh sách"\./);
  // A variable count: label and example as written.
  const v = scopeOf(wf([record('a', 'Account', 'acc', [num('N')]), loop('l', { count: '{{acc.N}}' }, [r('y')])]));
  assert.equal(v.sources.l.label, 'Vòng lặp {{acc.N}} lần');
  assert.equal(v.sources.l.members.find((m) => m.key === 'count').example, 'giá trị của acc.N');
});

test("a loop's own variable in its own options is ownLoop", () => {
  const w = wf([
    query('q', 'cons', { sobject: 'Contact', fields: ['Id', 'AccountId'] }),
    loop('l', { count: '{{loop.index}}' }, [r('x')]),
    loop('e', { mode: 'each', from: 'cons', itemAlias: 'con', alias: 'k', filter: 'compare', filterField: 'AccountId', filterValue: '{{con.Id}}' }, [r('y')]),
    // An enclosing loop of the same name: the count reads the outer loop (computed outside the body).
    loop('outer', { count: 2 }, [loop('inner', { count: '{{loop.index}}' }, [r('z')])]),
  ]);
  const scope = scopeOf(w);
  assert.deepEqual(refsAt(scope, 'l', 'count').map((x) => x.code), ['ownLoop']);
  assert.deepEqual(refsAt(scope, 'e', 'filterValue').map((x) => x.code), ['ownLoop']);
  assert.deepEqual(refsAt(scope, 'inner', 'count').map((x) => [x.source, x.code]), [['outer', undefined]]);
  const errs = validateWorkflow(w).errors;
  assert.equal(errs.find((x) => x.nodeId === 'l' && x.field === 'count').message, '"Số lần lặp": {{loop.index}} là biến của chính bước Lặp này, chỉ có bên trong thân; ô này được tính một lần trước lần lặp đầu. Dùng biến của bước phía trên.');
  assert.match(errs.find((x) => x.nodeId === 'e' && x.field === 'filterValue').message, /^"So với": \{\{con\.Id\}\} là bản ghi đang lặp của chính bước Lặp này/);
});

test('run variables are visible everywhere and shadowed by an alias named run', () => {
  const w = wf([r('a', 'acc', [tpl('D', 'Batch {{run.seed}} {{run.today}}')]), loop('l', { count: 2 }, [r('b', 'b', [tpl('D', '{{run.now}}')])])]);
  const scope = scopeOf(w);
  assert.equal(scope.sources.$run.nodeId, null);
  assert.deepEqual(scope.sources.$run.members.map((m) => `${m.key}:${m.valueType}`), ['seed:number', 'now:datetime', 'today:date']);
  assert.deepEqual(refsAt(scope, 'a').map((x) => [x.source, x.code]), [['$run', undefined], ['$run', undefined]]);
  assert.equal(scope.at.b.visible.at(-1).source, '$run');
  assert.deepEqual(validateWorkflow(w).errors, []);
  // An alias named `run` wins (and is not an error); the run group is hidden as shadowed.
  const sh = wf([r('a', 'run', [num('seed')]), r('b', 'b', [tpl('D', '{{run.seed}}')])]);
  const s2 = scopeOf(sh);
  assert.deepEqual(refsAt(s2, 'b').map((x) => x.source), ['a']);
  assert.deepEqual(s2.at.b.hidden.find((h) => h.source === '$run'), { source: '$run', reason: 'shadowed', note: 'bị alias "run" che' });
  assert.ok(!s2.at.b.visible.some((v) => v.source === '$run'));
  assert.deepEqual(validateWorkflow(sh).errors, []);
  // So does a loop variable named `run`, inside its body only.
  const lv = scopeOf(wf([loop('l', { count: 2, alias: 'run' }, [r('x', 'x', [tpl('D', '{{run.index}}')])]), r('y', 'y', [tpl('D', '{{run.seed}}')])]));
  assert.deepEqual([refsAt(lv, 'x')[0].source, refsAt(lv, 'y')[0].source], ['l', '$run']);
});

test('numericSampleFields lists Query fields used as numbers or weights', () => {
  const w = wf([
    query('q', 'accs', { fields: ['Id', 'Name', 'NumberOfEmployees', 'AnnualRevenue', 'Owner.Num__c'] }),
    query('q2', 'cons', { sobject: 'Contact', fields: ['Id', 'Score__c'] }),
    loop('la', { mode: 'each', from: 'accs', itemAlias: 'acc' }, [
      loop('lc', { count: '{{acc.NumberOfEmployees}}' }, [r('x')]),
      loop('lr', { mode: 'range', min: '{{acc.Owner.Num__c}}', max: '{{accs.$count}}' }, [r('y')]),
    ]),
    pick('p', 'c1', 'cons', { mode: 'weighted', weightField: 'Score__c' }),
    pick('p2', 'a1', 'accs'),
    loop('lp', { count: '{{a1.AnnualRevenue}}' }, [r('z')]),
    { ...loop('off', { count: '{{a1.Name}}' }, [r('w')]), disabled: true },
  ]);
  const out = numericSampleFields(w, catalog);
  assert.deepEqual(Object.keys(out).sort(), ['q', 'q2']);
  assert.deepEqual(out.q.sort(), ['AnnualRevenue', 'NumberOfEmployees', 'Owner.Num__c']);
  assert.deepEqual(out.q2, ['Score__c']);
});
