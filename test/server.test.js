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
  assert.deepEqual(meta.nodeTypes.map((n) => n.exposes?.kind ?? null), ['record', 'record', 'record', 'vars', null]);
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
  assert.deepEqual(pick.options.map((o) => o.key), ['from', 'alias', 'mode', 'filter', 'filterField', 'filterOp', 'filterValue', 'onEmpty']);
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
