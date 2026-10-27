import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { wf, record, loop } from './helpers.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';

let server;
let base;
const inserted = [];

before(async () => {
  const cli = { listOrgs: async () => [{ alias: 'dev', username: 'a@x.com' }], getConnection: async () => ({}) };
  const client = {
    create: async (_t, _sobject, recs) => {
      inserted.push(...recs);
      return recs.map((_, i) => ({ success: true, id: `001${i}` }));
    },
  };
  server = http.createServer(createApp({ cli, client }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/meta lists field types and step types with slots and categories', async () => {
  const meta = await (await fetch(base + '/api/meta')).json();
  assert.ok(meta.fieldTypes.some((f) => f.type === 'multipicklist'));
  assert.deepEqual(meta.nodeTypes.map((n) => n.type), ['record', 'loop', 'branch']);
  assert.deepEqual(meta.nodeTypes.map((n) => n.slots.map((s) => s.key)), [[], ['body'], ['true', 'false']]);
  assert.deepEqual(meta.nodeTypes.map((n) => n.category), ['data', 'control', 'control']);
  assert.ok(meta.nodeTypes.every((n) => !('outputs' in n) && !('inputs' in n)));
  assert.deepEqual(meta.stepCategories.map((c) => c.key), ['data', 'control']);
  assert.equal(meta.limits.maxDepth, 32);
  const ref = meta.fieldTypes.find((f) => f.type === 'lookup').options.find((o) => o.key === 'ref');
  assert.equal(ref.label, 'Bản ghi cha (alias)');
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
