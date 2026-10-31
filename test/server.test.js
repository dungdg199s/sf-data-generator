import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { wf, record, loop, query, pick } from './helpers.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';
import { W, rec, E } from './fixtures/v1-cases.js';

let server;
let base;
const inserted = [];
// Fake org data read by Query steps; tests change it to simulate the org changing.
let orgAccounts = [{ attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' }, { attributes: { type: 'Account' }, Id: '001000000000002AAA', Name: 'Globex' }];
const queried = [];

before(async () => {
  const cli = { listOrgs: async () => [{ alias: 'dev', username: 'a@x.com' }], getConnection: async () => ({}) };
  const client = {
    create: async (_t, _sobject, recs) => {
      inserted.push(...recs);
      return recs.map((_, i) => ({ success: true, id: `001${i}` }));
    },
    query: async (org, soql, opts) => {
      queried.push([org, soql, opts]);
      if (/FROM Nope/.test(soql)) throw Object.assign(new Error("Salesforce: INVALID_TYPE: sObject type 'Nope' is not supported."), { status: 502, cause: { errorCode: 'INVALID_TYPE', message: "sObject type 'Nope' is not supported." } });
      return { records: orgAccounts.map((r) => structuredClone(r)), totalSize: orgAccounts.length, done: true };
    },
    describeGlobal: async () => ({ sobjects: [
      { name: 'Account', label: 'Account', createable: true, queryable: true },
      { name: 'RecordType', label: 'Record Type', createable: false, queryable: true },
      { name: 'Old', label: 'Old', createable: true, queryable: true, deprecatedAndHidden: true },
    ] }),
    describe: async (_org, name) => ({ name, label: name, fields: [{ name: 'Name', label: 'Name', type: 'string', nameField: true, createable: true }, { name: 'Id', label: 'Id', type: 'id' }] }),
  };
  server = http.createServer(createApp({ cli, client }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Updated for 0006: Query and Chọn bản ghi join the catalogue (data category, after Record) and
// the Lookup `ref` label names pools too.
test('GET /api/meta lists field types and step types with slots and categories', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  assert.ok(meta.fieldTypes.some((f) => f.type === 'multipicklist'));
  assert.deepEqual(meta.nodeTypes.map((n) => n.type), ['record', 'query', 'pick', 'loop', 'branch']);
  assert.deepEqual(meta.nodeTypes.map((n) => n.slots.map((s) => s.key)), [[], [], [], ['body'], ['true', 'false']]);
  assert.deepEqual(meta.nodeTypes.map((n) => n.category), ['data', 'data', 'data', 'control', 'control']);
  assert.ok(meta.nodeTypes.every((n) => !('outputs' in n) && !('inputs' in n)));
  assert.deepEqual(meta.stepCategories.map((c) => c.key), ['data', 'control']);
  assert.equal(meta.limits.maxDepth, 32);
  const ref = meta.fieldTypes.find((f) => f.type === 'lookup').options.find((o) => o.key === 'ref');
  assert.equal(ref.label, 'Bản ghi cha / pool (alias)');
  // Variables (0005): every step type says how its slots run; record and loop expose variables.
  assert.deepEqual(meta.nodeTypes.map((n) => n.flow.kind), ['sequence', 'sequence', 'sequence', 'loop', 'branch']);
  // `exposes` may be a list (0010: the loop's variables, then the record of an each-loop).
  assert.deepEqual(meta.nodeTypes.map((n) => [n.exposes ?? []].flat().map((x) => x.kind).join('+') || null), ['record', 'record', 'record', 'vars+record', null]);
  assert.ok(meta.nodeTypes.every((n) => Object.values(n).every((v) => typeof v !== 'function')));
  const loopType = meta.nodeTypes.find((n) => n.type === 'loop');
  assert.ok(!('minIterations' in loopType), 'function keys are not served');
  const re = new RegExp(meta.syntax.templateToken, 'g');
  assert.deepEqual([...'{{acc.Name}} {{this.$n}}'.matchAll(re)].map((m) => m[1]), ['acc.Name', 'this.$n']);
  assert.ok(meta.syntax.valueTypes.some((v) => v.value === 'number' && v.label === 'Số'));
  const template = meta.fieldTypes.find((f) => f.type === 'template').options.find((o) => o.key === 'template');
  assert.deepEqual([template.vars, template.default], ['template', '{{this.$n}}']);
  assert.equal(meta.nodeTypes.find((n) => n.type === 'branch').options.find((o) => o.key === 'left').vars, 'path');
  assert.equal(meta.fieldTypes.find((f) => f.type === 'currency').valueType, 'number');
  assert.deepEqual(meta.fieldTypes.find((f) => f.type === 'geolocation').members.map((m) => m.key), ['latitude', 'longitude']);
});

test('GET /api/meta: loop has mode each with from and itemAlias shown only for each', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  const loopType = meta.nodeTypes.find((n) => n.type === 'loop');
  const opt = (k) => loopType.options.find((o) => o.key === k);
  assert.deepEqual(loopType.options.map((o) => o.key), ['mode', 'count', 'min', 'max', 'values', 'from', 'itemAlias', 'filter', 'filterField', 'filterOp', 'filterValue', 'order', 'limit', 'alias']);
  assert.equal(opt('mode').label, 'Lặp theo');
  assert.deepEqual(opt('mode').choices.map((c) => `${c.value}:${c.label}`), ['fixed:Số lần cố định', 'range:Số lần ngẫu nhiên trong khoảng', 'each:Mỗi bản ghi trong pool', 'values:Mỗi giá trị trong danh sách']);
  assert.deepEqual([opt('from').kind, opt('from').accepts, opt('from').showIf, opt('itemAlias').showIf], ['ref', { pool: true }, { key: 'mode', in: ['each'] }, { key: 'mode', in: ['each'] }]);
  assert.deepEqual([opt('count').showIf.in, opt('min').showIf.in], [['fixed'], ['range']]);
  const [vars, item] = loopType.exposes;
  assert.deepEqual([vars.kind, item.kind, item.key, item.when, item.name.key, item.current, item.pool, item.members], ['vars', 'record', 'item', { key: 'mode', in: ['each'] }, 'itemAlias', 'item', false, { fromSource: 'from' }]);
  assert.match(loopType.description, /mỗi bản ghi của một pool/);
});

test('GET /api/meta: loop has values, filter, order and limit with chained showIf; count/min/max declare vars number; branch right declares vars template; pick has weighted and weightField; globals lists run', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  const type = (t) => meta.nodeTypes.find((n) => n.type === t);
  const opt = (t, k) => type(t).options.find((o) => o.key === k);
  // Values loop (0013 D): a list with a placeholder; `value` member only in values mode.
  assert.deepEqual([opt('loop', 'values').kind, opt('loop', 'values').showIf, opt('loop', 'values').placeholder], ['list', { key: 'mode', in: ['values'] }, 'Hot\nWarm\nCold']);
  // One value per line in the form (a value may hold a comma), like valueList on the server.
  assert.equal(opt('loop', 'values').split, 'lines');
  assert.deepEqual(type('loop').exposes[0].members.find((m) => m.key === 'value').when, { key: 'mode', in: ['values'] });
  // Each filter (0013 C): `filter` shows in each mode, its fields when it is `compare` (transitive).
  assert.deepEqual(opt('loop', 'filter').showIf, { key: 'mode', in: ['each'] });
  for (const k of ['filterField', 'filterOp', 'filterValue']) assert.deepEqual(opt('loop', k).showIf, { key: 'filter', in: ['compare'] }, k);
  assert.equal(opt('loop', 'filterValue').vars, 'template');
  assert.deepEqual(opt('loop', 'order').choices.map((c) => c.value), ['pool', 'shuffle']);
  assert.deepEqual([opt('loop', 'order').showIf, opt('loop', 'limit').showIf, opt('loop', 'limit').default, opt('loop', 'limit').vars], [{ key: 'mode', in: ['each'] }, { key: 'mode', in: ['each'] }, 0, undefined]);
  // Number variables (0013 B).
  for (const k of ['count', 'min', 'max']) assert.deepEqual([opt('loop', k).kind, opt('loop', k).vars], ['integer', 'number'], k);
  assert.equal(opt('branch', 'right').vars, 'template');
  assert.match(opt('branch', 'right').help, /\{\{opp\.Amount\}\}/);
  // Weighted pick (0013 E); pick's filter has no showIf (as before).
  assert.ok(opt('pick', 'mode').choices.some((c) => c.value === 'weighted'));
  assert.deepEqual([opt('pick', 'weightField').showIf, opt('pick', 'weightField').suggest], [{ key: 'mode', in: ['weighted'] }, { kind: 'poolFields', poolKey: 'from' }]);
  assert.equal(opt('pick', 'filter').showIf, undefined);
  // Record pools are never empty after the step (C4); run variables (G).
  assert.equal(type('record').exposes.nonEmpty, true);
  assert.deepEqual(meta.globals.map((g) => [g.name, g.members.map((m) => `${m.key}:${m.valueType}`)]), [['run', ['seed:number', 'now:datetime', 'today:date']]]);
});

test('GET /api/meta (0006): Query / Chọn bản ghi options, suggest hints, presets and query limits', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  const query = meta.nodeTypes.find((n) => n.type === 'query');
  const pick = meta.nodeTypes.find((n) => n.type === 'pick');
  assert.equal(query.label, 'Query (đọc org)');
  assert.equal(query.needsOrg, true);
  assert.deepEqual(query.options.map((o) => o.key), ['mode', 'sobject', 'alias', 'fields', 'where', 'orderBy', 'limit', 'soql']);
  assert.deepEqual(query.options.find((o) => o.key === 'sobject').suggest, { kind: 'sobject', purpose: 'query' });
  assert.deepEqual(query.options.find((o) => o.key === 'fields').suggest, { kind: 'fields', sobjectKey: 'sobject' });
  assert.deepEqual(query.options.find((o) => o.key === 'fields').default, ['Id', 'Name']);
  assert.equal(query.options.find((o) => o.key === 'limit').max, 2000);
  assert.deepEqual([query.exposes.current, query.exposes.origin, query.exposes.members, query.exposes.builtins[0].key], ['none', 'org', 'select', '$count']);
  assert.equal(pick.label, 'Chọn bản ghi');
  assert.deepEqual(pick.options.map((o) => o.key), ['from', 'alias', 'mode', 'weightField', 'filter', 'filterField', 'filterOp', 'filterValue', 'onEmpty']);
  assert.deepEqual(pick.options.find((o) => o.key === 'from').accepts, { pool: true });
  assert.equal(pick.options.find((o) => o.key === 'filterValue').vars, 'template');
  assert.deepEqual(pick.options.find((o) => o.key === 'filterField').suggest, { kind: 'poolFields', poolKey: 'from' });
  assert.deepEqual(pick.exposes.origin, { fromSource: 'from' });
  assert.equal(meta.queryPresets.User.alias, 'users');
  assert.equal(meta.queryPresets.Pricebook2.limit, 1);
  assert.deepEqual([meta.limits.maxQueryRows, meta.limits.maxQueryNodes, meta.limits.queryTimeoutMs, meta.limits.queryCacheTtlMs], [2000, 20, 30000, 600000]);
  // Shown and executed loop count agree: missing count = 0 (default), a new step starts at 3 (initial).
  const count = meta.nodeTypes.find((n) => n.type === 'loop').options.find((o) => o.key === 'count');
  assert.deepEqual([count.default, count.initial], [0, 3]);
  assert.ok(meta.fieldTypes.some((f) => f.type === 'copy' && f.options[0].vars === 'path'));
});

test('POST /api/run returns records; invalid workflow returns 422 with issues', async () => {
  const good = wf([loop('l', { count: 2 }, [record('a', 'Account', 'acc', [{ name: 'Name', type: 'text' }], { count: 3 })])]);
  const r = await (await post('/api/run', { workflow: good, seed: 5 })).json();
  assert.equal(r.records.length, 6);
  assert.equal(r.seed, 5);
  assert.deepEqual(r.stats.byStep, { l: { runs: 1, records: 6, iterations: 2 }, a: { runs: 2, records: 6 } });

  const bad = await post('/api/run', { workflow: { version: 2, steps: [{ id: 'x', type: 'record', config: { sobject: '' } }] } });
  assert.equal(bad.status, 422);
  assert.ok((await bad.json()).issues.length);
});

test('POST /api/run with org target inserts', async () => {
  const good = wf([record('a', 'Account', 'acc', [{ name: 'Name', type: 'text' }], { count: 2 })]);
  const r = await (await post('/api/run', { workflow: good, target: { kind: 'org', org: 'dev' } })).json();
  assert.equal(r.insert.inserted, 2);
  assert.equal(inserted.length, 2);
});

test('POST /api/run and /api/validate accept version 1 with a conversion warning', async () => {
  const v1 = V1_SAMPLES[0].workflow;
  const r = await (await post('/api/run', { workflow: v1, seed: 3 })).json();
  assert.ok(r.records.length > 0);
  assert.match(r.warnings[0].message, /version 1 đã được tự chuyển sang version 2/);
  assert.ok(r.stats.byStep.loopAcc);
  const v = await (await post('/api/validate', { workflow: v1 })).json();
  assert.deepEqual(v.errors, []);
  assert.match(v.warnings[0].message, /version 1/);
});

test('POST /api/run refuses to insert a v1 workflow whose conversion copied steps; preview still works', async () => {
  const v1 = W(
    [{ id: 'l', type: 'loop', config: { count: 2 } }, rec('a', 'A', 'a'), rec('c', 'C', 'c')],
    [E('start', 'l'), E('l', 'a', 'body'), E('a', 'c'), E('l', 'c', 'done')],
  );
  const before = inserted.length;
  const res = await post('/api/run', { workflow: v1, target: { kind: 'org', org: 'dev' } });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /Workflow version 1 này phải đổi cấu trúc/);
  assert.match(body.error, /bấm Lưu trước khi insert/);
  assert.equal(inserted.length, before, 'nothing was inserted');

  const preview = await post('/api/run', { workflow: v1, seed: 1 });
  assert.equal(preview.status, 200);
  const r = await preview.json();
  assert.ok(r.records.length > 0);
  assert.ok(r.warnings.some((w) => /nhân thành "c" và "c_2"/.test(w.message)));

  // A v1 workflow that converts cleanly can still be inserted directly.
  const ok = await post('/api/run', { workflow: V1_SAMPLES[1].workflow, target: { kind: 'org', org: 'dev' } });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).insert.inserted > 0);
});

test('static files are served and traversal is blocked', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  const evil = await fetch(base + '/..%2fpackage.json');
  assert.ok([403, 404].includes(evil.status));
  // Revalidation (design 0014 review): no-cache + ETag; an unchanged file answers 304 without a body.
  const js = await fetch(base + '/js/dom.js');
  const etag = js.headers.get('etag');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  const again = await fetch(base + '/js/dom.js', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  assert.equal((await fetch(base + '/js/dom.js', { headers: { 'If-None-Match': 'W/"0-0"' } })).status, 200);
});

test('shared modules are served from /shared/ and traversal out of it is blocked', async () => {
  const mod = await fetch(base + '/shared/workflow-tree.js');
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/);
  assert.match(await mod.text(), /export function findStep/);
  for (const evil of ['/shared/..%2fpackage.json', '/shared/%2e%2e/server/index.js', '/shared/..%5c..%5cpackage.json']) {
    const res = await fetch(base + evil);
    assert.ok([400, 403, 404].includes(res.status), `${evil} → ${res.status}`);
  }
});

// ---------- Query and Chọn bản ghi (design 0006) ----------

const queryWf = () => wf([
  query('q', 'accs'),
  loop('l', { count: 3 }, [pick('p', 'acc', 'accs'), record('c', 'Contact', 'con', [{ name: 'LastName', type: 'template', options: { template: 'of {{acc.Name}}' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])]),
]);

test('POST /api/run with a query node returns queries[] and real Ids; without org it uses sample rows', async () => {
  const r = await (await post('/api/run', { workflow: queryWf(), seed: 3, org: 'dev' })).json();
  assert.equal(r.records.length, 3, 'org rows are not output records');
  assert.ok(r.records.every((x) => ['001000000000001AAA', '001000000000002AAA'].includes(x.fields.AccountId)));
  assert.equal(r.queries.length, 1);
  const q = r.queries[0];
  assert.deepEqual([q.nodeId, q.alias, q.sobject, q.soql, q.org, q.count, q.truncated], ['q', 'accs', 'Account', 'SELECT Id, Name FROM Account ORDER BY Id LIMIT 200', 'dev', 2, false]);
  assert.ok(['org', 'cache'].includes(q.source));
  assert.match(q.fingerprint, /^[0-9a-f]{8}$/);
  assert.deepEqual(q.records[0], { Id: '001000000000001AAA', Name: 'Acme' });
  assert.ok(r.samples.p.Name);

  const sample = await (await post('/api/run', { workflow: queryWf(), seed: 3 })).json();
  assert.equal(sample.queries[0].source, 'sample');
  assert.ok(sample.records.every((x) => /^mẫu:accs#\d$/.test(x.fields.AccountId)));
  assert.ok(sample.warnings.some((w) => w.nodeId === 'q' && /bản ghi mẫu/.test(w.message)));

  // A Salesforce error on the query is a 422 on the right field.
  const bad = await post('/api/run', { workflow: wf([query('q', 'accs', { sobject: 'Nope' }), pick('p', 'acc', 'accs')]), org: 'dev', refreshQueries: true });
  assert.equal(bad.status, 422);
  const issue = (await bad.json()).issues[0];
  assert.deepEqual([issue.nodeId, issue.field], ['q', 'sobject']);
});

test('insert reuses the previewed query rows; changed org data gives 409 and inserts nothing', async () => {
  const preview = await (await post('/api/run', { workflow: queryWf(), seed: 8, org: 'dev', refreshQueries: true })).json();
  const calls = queried.length;
  const expectQueries = Object.fromEntries(preview.queries.map((q) => [q.nodeId, { fingerprint: q.fingerprint, count: q.count, fetchedAt: q.fetchedAt }]));
  const before = inserted.length;
  const ok = await (await post('/api/run', { workflow: queryWf(), seed: 8, expectQueries, target: { kind: 'org', org: 'dev' } })).json();
  assert.equal(queried.length, calls, 'the insert used the cached rows of the preview');
  assert.deepEqual(ok.records, preview.records);
  assert.equal(inserted.length - before, 3);
  assert.deepEqual(inserted.slice(before).map((x) => x.AccountId), preview.records.map((x) => x.fields.AccountId));
  // The insert cleared the cache: the org now has one more Account, and a stale insert is refused.
  orgAccounts = [...orgAccounts, { attributes: { type: 'Account' }, Id: '001000000000003AAA', Name: 'Initech' }];
  const n = inserted.length;
  const stale = await post('/api/run', { workflow: queryWf(), seed: 8, expectQueries, target: { kind: 'org', org: 'dev' } });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.match(body.error, /^Dữ liệu trong org đã thay đổi từ lần xem trước/);
  assert.equal(body.issues[0].nodeId, 'q');
  assert.match(body.issues[0].message, /lúc xem trước có 2 bản ghi.*bây giờ đọc lại thì khác \(3 bản ghi\)/);
  assert.equal(inserted.length, n, 'nothing was inserted');
});

test('GET /api/orgs/:org/sobjects?for=query lists queryable objects', async () => {
  const create = await (await fetch(`${base}/api/orgs/dev/sobjects`)).json();
  const read = await (await fetch(`${base}/api/orgs/dev/sobjects?for=query`)).json();
  assert.deepEqual(create.map((x) => x.name), ['Account']);
  assert.deepEqual(read.map((x) => x.name), ['Account', 'RecordType']);
});

test('GET /api/orgs/:org/sobjects/:name/fields', async () => {
  const r = await (await fetch(`${base}/api/orgs/dev/sobjects/Account/fields`)).json();
  assert.equal(r.sobject, 'Account');
  assert.equal(r.nameField, 'Name');
  assert.deepEqual(r.fields.map((f) => f.name), ['Id', 'Name']);
});

test('POST /api/validate returns derived SOQL and pool fields', async () => {
  const v = await (await post('/api/validate', { workflow: queryWf() })).json();
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.derived.q, { soql: 'SELECT Id, Name FROM Account ORDER BY Id LIMIT 200', sobject: 'Account', fields: ['Id', 'Name'] });
  assert.deepEqual(v.derived.p, { sobject: 'Account', fields: ['Id', 'Name'], from: 'accs' });
});

// ---------- streaming /api/run, cancel, export (design 0004) ----------

const ndjson = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), ...extra });
const lines = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const big = () => wf([loop('l', { count: 300 }, [record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { mode: 'company' } }]), loop('m', { count: 3 }, [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])])])]);

test('POST /api/run with Accept ndjson streams events ending in done (first 200 rows per sObject)', async () => {
  const res = await ndjson('/api/run', { workflow: big(), seed: 4, now: 1761552000000 });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/x-ndjson/);
  const events = await lines(res);
  assert.equal(events[0].type, 'start');
  assert.match(events[0].runId, /^r[0-9a-f]{8}$/);
  assert.deepEqual([events[0].seed, events[0].now], [4, 1761552000000]);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.result.stats.bySobject, { Account: 300, Contact: 900 });
  assert.equal(done.result.records.length, 400);
  assert.equal(done.result.stats.truncated, true);
  assert.equal(done.result.now, 1761552000000);
  // Same seed and now ⇒ same data as the JSON mode.
  const json = await (await post('/api/run', { workflow: big(), seed: 4, now: 1761552000000 })).json();
  assert.equal(json.records.length, 1200);
  assert.equal(json.now, 1761552000000);
  assert.deepEqual(done.result.records, [...json.records.filter((r) => r.sobject === 'Account').slice(0, 200), ...json.records.filter((r) => r.sobject === 'Contact').slice(0, 200)].sort((a, b) => json.records.indexOf(a) - json.records.indexOf(b)));
});

test('invalid workflow still returns 422 before streaming; a bad now is 400', async () => {
  const bad = await ndjson('/api/run', { workflow: { version: 2, steps: [{ id: 'x', type: 'record', config: { sobject: '' } }] } });
  assert.equal(bad.status, 422);
  assert.match(bad.headers.get('content-type'), /^application\/json/);
  assert.ok((await bad.json()).issues[0].nodeId === 'x');
  const now = await post('/api/run', { workflow: big(), now: 'yesterday' });
  assert.equal(now.status, 400);
  assert.equal((await now.json()).error, 'Tham số now không hợp lệ.');
});

test('NDJSON insert: plan, insert progress and done with the insert summary', async () => {
  const before = inserted.length;
  const events = await lines(await ndjson('/api/run', { workflow: big(), seed: 4, target: { kind: 'org', org: 'dev' } }));
  const plan = events.find((e) => e.type === 'plan');
  assert.deepEqual([plan.total, plan.apiCalls], [1200, 7]);
  const done = events.at(-1);
  assert.equal(done.result.insert.inserted, 1200);
  assert.deepEqual([done.result.insert.errorsTotal, done.result.insert.errorGroups, done.result.insert.cancelled, done.result.insert.stopped], [0, [], false, null]);
  assert.equal(inserted.length - before, 1200);
});

test('cancel unknown run returns 404', async () => {
  const res = await post('/api/runs/rdeadbeef/cancel', {});
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Lần chạy này đã kết thúc.');
});

test('POST /api/runs/:id/cancel stops an insert after the call in flight', async () => {
  let release;
  let calls = 0;
  const held = new Promise((r) => { release = r; });
  const client = {
    identity: async (org) => org,
    create: async (_t, _s, recs) => {
      if (++calls === 2) await held;
      return recs.map((_, i) => ({ success: true, id: `001${calls}${i}` }));
    },
  };
  const app = http.createServer(createApp({ cli: { listOrgs: async () => [] }, client }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${app.address().port}`;
    const res = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ workflow: big(), seed: 1, target: { kind: 'org', org: 'dev' } }) });
    const reader = res.body.getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]);
    assert.equal(first.type, 'start');
    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    const cancel = await fetch(`${url}/api/runs/${first.runId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepEqual(await cancel.json(), { ok: true });
    release();
    let text = '';
    for (let c; !(c = await reader.read()).done;) text += new TextDecoder().decode(c.value);
    const done = text.trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(done.type, 'done');
    // The first window holds the 300 Accounts: call 1 (200) and the held call 2 (100) both land.
    assert.deepEqual([done.result.insert.cancelled, done.result.insert.inserted, calls], [true, 300, 2]);
    assert.equal((await fetch(`${url}/api/runs/${first.runId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, 'the run is over');
  } finally {
    app.close();
  }
});

test('export csv streams the header + one line per record of the sObject, matching the preview rows', async () => {
  const body = { workflow: big(), seed: 11, now: 1761552000000 };
  const preview = await (await ndjson('/api/run', body)).text();
  const result = JSON.parse(preview.trim().split('\n').at(-1)).result;
  const res = await post('/api/export', { ...body, format: 'csv', sobject: 'Contact' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="test-Contact\.csv"/);
  const csv = (await res.text()).trim().split('\r\n');
  assert.equal(csv[0], 'ref,LastName,AccountId');
  assert.equal(csv.length, 901);
  const firstCon = result.records.find((r) => r.sobject === 'Contact');
  assert.equal(csv[1], `${firstCon.ref},${firstCon.fields.LastName},${firstCon.fields.AccountId.$ref}`);

  const json = await (await post('/api/export', { ...body, format: 'json' })).json();
  assert.equal(json.length, 1200);
  assert.deepEqual(json.filter((r) => r.sobject === 'Account').slice(0, 200), result.records.filter((r) => r.sobject === 'Account'));

  assert.equal((await post('/api/export', { ...body, format: 'csv' })).status, 400);
  assert.equal((await (await post('/api/export', { ...body, format: 'csv' })).json()).error, 'Chọn sObject cần tải CSV.');
  assert.equal((await post('/api/export', { workflow: big(), format: 'json' })).status, 400);
});

test('export of a workflow with a Query reads through the cache; changed org data is a 409', async () => {
  const preview = await (await post('/api/run', { workflow: queryWf(), seed: 3, org: 'dev', refreshQueries: true })).json();
  const expectQueries = Object.fromEntries(preview.queries.map((q) => [q.nodeId, q.fingerprint]));
  const ok = await (await post('/api/export', { workflow: queryWf(), seed: 3, now: preview.now, org: 'dev', expectQueries, format: 'json' })).json();
  assert.deepEqual(ok, preview.records);
  orgAccounts = [...orgAccounts, { attributes: { type: 'Account' }, Id: '001000000000009AAA', Name: 'Umbrella' }];
  await post('/api/run', { workflow: queryWf(), seed: 3, org: 'dev', refreshQueries: true });
  const stale = await post('/api/export', { workflow: queryWf(), seed: 3, now: preview.now, org: 'dev', expectQueries, format: 'json' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'Dữ liệu đọc từ org đã đổi so với lần chạy này. Bấm Xem trước lại rồi tải.');
});

test('GET /api/meta has recordPresets; Task has Subject and noName (0012 G)', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  const p = meta.recordPresets;
  assert.deepEqual(p.Task.fields.map((f) => f.name), ['Subject']);
  assert.equal(p.Task.noName, true);
  assert.equal(p.Task.nameField, 'Subject');
  assert.deepEqual(p.Task.fields[0].options.values, ['Call', 'Send Letter', 'Send Quote', 'Other']);
  assert.deepEqual(p.Contact.fields.map((f) => f.name), ['FirstName', 'LastName']);
  assert.deepEqual(p.Lead.fields.map((f) => f.name), ['FirstName', 'LastName', 'Company']);
  assert.deepEqual(p.Event.fields.map((f) => [f.name, f.type]), [['Subject', 'text'], ['ActivityDateTime', 'datetime'], ['DurationInMinutes', 'number']]);
  assert.deepEqual(p.Opportunity.fields.map((f) => f.name), ['Name', 'StageName', 'CloseDate']);
  assert.equal(p.Opportunity.noName, undefined);
  // Account keeps today's default (company name), so the samples and golden hashes do not move.
  assert.deepEqual(p.Account, { fields: [{ name: 'Name', type: 'text', options: { mode: 'company' } }] });
  // Any other sObject (custom ones included) starts with the served default list.
  assert.deepEqual(meta.recordDefaultFields, [{ name: 'Name', type: 'text', options: { mode: 'name' } }]);
  // Every preset field is a known field type, and each preset alone validates without errors.
  const types = new Set(meta.fieldTypes.map((t) => t.type));
  for (const [sobject, preset] of Object.entries(p)) {
    for (const f of preset.fields) assert.ok(types.has(f.type), `${sobject}.${f.name}: ${f.type}`);
    const res = await (await fetch(base + '/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: { version: 2, steps: [{ id: 'r', type: 'record', config: { sobject, alias: 'r1', fields: preset.fields } }] } }) })).json();
    assert.deepEqual([res.errors, res.warnings], [[], []], sobject);
  }
});

test('GET /api/meta serves limits.previewRows', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  assert.equal(meta.limits.previewRows, 200);
});

test('a client that leaves while Query steps are read gets no run (nothing inserted)', async () => {
  let created = 0;
  let queried2 = 0;
  const client = {
    identity: async (org) => org,
    query: async () => {
      queried2++;
      await new Promise((r) => setTimeout(r, 150));
      return { records: [{ Id: '001000000000001AAA', Name: 'Acme' }], totalSize: 1, done: true };
    },
    create: async (_t, _s, recs) => { created += recs.length; return recs.map(() => ({ success: true, id: '001x' })); },
  };
  const app = http.createServer(createApp({ cli: { listOrgs: async () => [] }, client }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const controller = new AbortController();
    const req = fetch(`http://127.0.0.1:${app.address().port}/api/run`, {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ workflow: queryWf(), seed: 1, target: { kind: 'org', org: 'dev' } }),
    });
    while (!queried2) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await req.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(created, 0);
  } finally {
    app.close();
  }
});

// ---------- review fixes (0004 "Sửa sau review") ----------

import { requestGuard } from '../server/index.js';

/** A throwaway app on its own port with a given client; → { url, close }. */
async function appWith(client, opts = {}) {
  const app = http.createServer(createApp({ cli: { listOrgs: async () => [{ alias: 'dev', username: 'a@x.com' }], getConnection: async () => ({}) }, client, ...opts }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${app.address().port}`, close: () => app.close() };
}

test('cross-site requests are refused: foreign Origin / Sec-Fetch-Site / Host (403), non-JSON body (415); curl and the app still work', async () => {
  let created = 0;
  const { url, close } = await appWith({ create: async (_t, _s, recs) => { created += recs.length; return recs.map(() => ({ success: true, id: '001x' })); } });
  try {
    const port = new URL(url).port;
    const body = JSON.stringify({ workflow: wf([record('a', 'Account', 'acc', [], { count: 2 })]), target: { kind: 'org', org: 'dev' } });
    // The attack: a page on another site posts a "simple" text/plain request (no CORS preflight).
    const plain = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    assert.equal(plain.status, 415);
    assert.match((await plain.json()).error, /Content-Type: application\/json/);
    const foreign = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body });
    assert.equal(foreign.status, 403);
    assert.match((await foreign.json()).error, /^Từ chối yêu cầu từ trang web khác/);
    const site = await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' });
    assert.equal(site.status, 403);
    const read = await fetch(`${url}/api/orgs`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(read.status, 403, 'org data is not readable cross-site');
    for (const path of ['/api/validate', '/api/runs/rabc/cancel']) {
      assert.equal((await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: '{}' })).status, 403, path);
    }
    assert.equal(created, 0, 'nothing was inserted');
    // DNS rebinding: same origin as far as the browser knows, but the Host is not this machine.
    assert.deepEqual(requestGuard({ method: 'GET', headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` } }, { allowedHosts: new Set(['127.0.0.1', 'localhost']) }).status, 403);
    // curl (no Origin) and the app (same origin) are fine.
    assert.equal((await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 200);
    assert.equal((await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: url, 'Sec-Fetch-Site': 'same-origin' }, body })).status, 200);
    assert.equal((await fetch(`${url}/api/meta`, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
    assert.equal(created, 4);
  } finally {
    close();
  }
});

test('JSON mode stops when the client disconnects', async () => {
  let calls = 0;
  const { url, close } = await appWith({ create: async (_t, _s, recs) => { calls++; await new Promise((r) => setTimeout(r, 40)); return recs.map(() => ({ success: true, id: '001x' })); } });
  try {
    const ac = new AbortController();
    const req = fetch(`${url}/api/run`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: wf([record('a', 'Account', 'acc', [], { count: 3000 })]), seed: 1, target: { kind: 'org', org: 'dev' } }) });
    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await req.catch(() => {});
    const at = calls;
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(calls <= at + 1, `${calls} calls after the disconnect at ${at} (15 without the fix)`);
  } finally {
    close();
  }
});

test('error groups are bounded: Ids in messages are masked, at most 100 groups, the done line stays small', async () => {
  let n = 0;
  const { url, close } = await appWith({ create: async (_t, _s, recs) => recs.map((_, i) => (i === 0 ? { success: true, id: `003${++n}` }
    : { success: false, errors: [{ statusCode: 'DUPLICATE_VALUE', message: `duplicate value found: Email duplicates value on record with id: 003000000${String(++n).padStart(6, '0')}`, fields: [] }] })) });
  try {
    const res = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ workflow: wf([record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: {} }], { count: 40000 })]), seed: 1, target: { kind: 'org', org: 'dev' } }) });
    const last = (await res.text()).trim().split('\n').at(-1);
    const ins = JSON.parse(last).result.insert;
    assert.equal(ins.errorsTotal, 39800);
    assert.equal(ins.errorGroups.length, 1);
    assert.equal(ins.errorGroups[0].count, 39800);
    assert.match(ins.errorGroups[0].message, /with id: 003000000\d{6}$/, 'the example keeps the raw message');
    assert.ok(last.length < 400000, `done line ${last.length} bytes (7 MB before)`);
  } finally {
    close();
  }
});

test('export after an insert uses the Query rows that run used (no 409 although the org changed)', async () => {
  const accounts = [{ attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' }];
  let idn = 0;
  const { url, close } = await appWith({
    identity: async (o) => o,
    query: async () => ({ records: accounts.map((r) => structuredClone(r)), totalSize: accounts.length, done: true }),
    create: async (_t, sobject, recs) => recs.map((r) => {
      const id = `001${String(++idn).padStart(15, '0')}`;
      accounts.push({ attributes: { type: sobject }, Id: id, Name: r.Name });
      return { success: true, id };
    }),
  });
  try {
    const w = wf([query('q', 'accs', { fields: ['Id', 'Name'] }), record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { mode: 'company' } }, { name: 'ParentId', type: 'lookup', options: { mode: 'random', ref: 'accs' } }], { count: 3 })]);
    const nd = async (body) => JSON.parse((await (await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) })).text()).trim().split('\n').at(-1)).result;
    const p = await nd({ workflow: w, seed: 1, org: 'dev' });
    const expectQueries = Object.fromEntries(p.queries.map((q) => [q.nodeId, q.fingerprint]));
    const r = await nd({ workflow: w, seed: p.seed, now: p.now, target: { kind: 'org', org: 'dev' }, expectQueries });
    assert.equal(r.insert.inserted, 3);
    assert.match(r.runId, /^r[0-9a-f]{8}$/);
    const exq = Object.fromEntries(r.queries.map((q) => [q.nodeId, q.fingerprint]));
    const body = { workflow: w, seed: r.seed, now: r.now, org: 'dev', expectQueries: exq, format: 'json' };
    const stale = await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(stale.status, 409, 'without the run id the changed org is still detected');
    const ok = await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, runId: r.runId }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), r.records, 'exactly what was inserted');
  } finally {
    close();
  }
});

test('a malformed cancel id is a 404; the response ends before the query cache is cleared', async () => {
  const bad = await fetch(`${base}/api/runs/%E0%A4%A/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 404);
  let release;
  const slowIdentity = new Promise((r) => { release = r; });
  const { url, close } = await appWith({ identity: async (o) => { await slowIdentity; return o; }, create: async (_t, _s, recs) => recs.map(() => ({ success: true, id: '001x' })) });
  try {
    const res = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ workflow: wf([record('a', 'Account', 'acc', [], { count: 2 })]), seed: 1, target: { kind: 'org', org: 'dev' } }) });
    const text = await Promise.race([res.text(), new Promise((r) => setTimeout(() => r('timeout'), 1000))]);
    assert.notEqual(text, 'timeout', 'the stream ended while the cache invalidation still waits');
    assert.equal(JSON.parse(text.trim().split('\n').at(-1)).result.insert.inserted, 2);
  } finally {
    release();
    close();
  }
});

// ---------- design 0012 E: POST /api/field-samples ----------

const NOW0 = Date.parse('2026-10-28T00:00:00Z');
const industry = { name: 'Industry', type: 'picklist', options: { values: ['Banking', 'Retail', 'Tech'], weights: [3, 1, 1] } };

test('POST /api/field-samples returns 3 deterministic values (same seed ⇒ same values)', async () => {
  const body = { sobject: 'Account', fields: [{ name: 'Name', type: 'text', options: { mode: 'company' } }, industry], index: 1, seed: 1, now: NOW0 };
  const a = await post('/api/field-samples', body);
  assert.equal(a.status, 200);
  const { values } = await a.json();
  assert.equal(values.length, 3);
  assert.ok(values.every((v) => industry.options.values.includes(v)), values.join());
  const b = await (await post('/api/field-samples', body)).json();
  assert.deepEqual(b.values, values);
  // Another seed (very likely) changes them; an empty seed is seed 1.
  const c = await (await post('/api/field-samples', { ...body, seed: 999 })).json();
  assert.equal(c.values.length, 3);
  assert.deepEqual((await (await post('/api/field-samples', { ...body, seed: undefined })).json()).values, values);
});

test('POST /api/field-samples: {{this.FirstName}} uses the field above; a reference to another step is empty', async () => {
  const fields = [
    { name: 'FirstName', type: 'text', options: { mode: 'firstName' } },
    { name: 'AccountId', type: 'lookup', options: { mode: 'current', ref: 'acc' } }, // cannot be made here: left out
    { name: 'Title', type: 'template', options: { template: 'Chào {{this.FirstName}}{{acc.Name}}' } },
  ];
  const first = (await (await post('/api/field-samples', { fields, index: 0, seed: 3, now: NOW0 })).json()).values;
  const res = await post('/api/field-samples', { fields, index: 2, seed: 3, now: NOW0 });
  assert.equal(res.status, 200);
  const { values } = await res.json();
  assert.equal(values.length, 3);
  for (const v of values) assert.match(v, /^Chào \S+$/);
  assert.equal(values[0], `Chào ${first[0]}`);
});

test('POST /api/field-samples: unknown type ⇒ 422 with the field; count is clamped to 5; exhausted unique values ⇒ 422', async () => {
  const unknown = await post('/api/field-samples', { fields: [{ name: 'X__c', type: 'nope', options: {} }], index: 0, now: NOW0 });
  assert.equal(unknown.status, 422);
  const u = await unknown.json();
  assert.equal(u.issues[0].field, 'fields.X__c');
  assert.match(u.issues[0].message, /kiểu "nope" không được hỗ trợ/);

  const many = await (await post('/api/field-samples', { fields: [industry], index: 0, count: 50, now: NOW0 })).json();
  assert.equal(many.values.length, 5);

  const unique = await post('/api/field-samples', { fields: [{ name: 'N__c', type: 'number', options: { min: 1, max: 2, unique: true } }], index: 0, count: 3, now: NOW0 });
  assert.equal(unique.status, 422);
  assert.match((await unique.json()).error, /không tạo được giá trị duy nhất/);

  // Malformed requests: 400.
  assert.equal((await post('/api/field-samples', { fields: [], index: 0, now: NOW0 })).status, 400);
  assert.equal((await post('/api/field-samples', { fields: [industry], index: 1, now: NOW0 })).status, 400);
  assert.equal((await post('/api/field-samples', { fields: [industry], index: 0 })).status, 400);
  assert.equal((await post('/api/field-samples', { fields: Array.from({ length: 501 }, () => industry), index: 0, now: NOW0 })).status, 400);
});

test('POST /api/field-samples and /api/run refuse out-of-range options (no long loop); options: null is no options', async () => {
  const huge = { name: 'Description', type: 'textarea', options: { maxSentences: 1e9 } };
  const res = await post('/api/field-samples', { fields: [huge], index: 0, now: NOW0 });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(body.issues.map((i) => [i.field, i.option]), [['fields.Description', 'maxSentences']]);
  assert.match(body.issues[0].message, /"Số câu tối đa" phải từ 1 đến 200 \(đang là 1000000000\)/);
  // A field above with a huge option is clamped, not refused (only the asked field is checked).
  const above = await post('/api/field-samples', { fields: [{ name: 'A', type: 'text', options: { maxWords: 1e9 } }, industry], index: 1, now: NOW0 });
  assert.equal(above.status, 200);
  const nul = await post('/api/field-samples', { fields: [{ name: 'Industry', type: 'picklist', options: null }], index: 0, now: NOW0 });
  assert.equal(nul.status, 200);
  assert.equal((await nul.json()).values.length, 3);
  // Generator errors carry the field too.
  const unique = await (await post('/api/field-samples', { fields: [{ name: 'N__c', type: 'number', options: { min: 1, max: 2, unique: true } }], index: 0, count: 3, now: NOW0 })).json();
  assert.equal(unique.issues[0].field, 'fields.N__c');
  const run = await post('/api/run', { seed: 1, workflow: wf([record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { maxWords: 1e9 } }])]) });
  assert.equal(run.status, 422);
  const issue = (await run.json()).issues[0];
  assert.deepEqual([issue.nodeId, issue.field, issue.option, issue.code], ['a', 'fields.Name', 'maxWords', 'optionRange']);
});

test('a now outside what a Date holds is a 400 for /api/run, /api/export and /api/field-samples (review of 0013)', async () => {
  for (const now of [1e20, 8.64e15 + 1]) {
    const run = await post('/api/run', { workflow: big(), seed: 1, now });
    assert.equal(run.status, 400);
    assert.equal((await run.json()).error, 'Tham số now không hợp lệ.');
    const exp = await post('/api/export', { workflow: big(), seed: 1, now, format: 'json' });
    assert.equal(exp.status, 400);
    assert.equal((await exp.json()).error, 'Tham số now không hợp lệ.');
    const fs = await post('/api/field-samples', { fields: [{ name: 'D', type: 'date', options: {} }], index: 0, seed: 1, now });
    assert.equal(fs.status, 400);
    assert.equal((await fs.json()).error, 'Tham số now không hợp lệ.');
  }
});
