// Exercises the real jsforce Connection against a fake Salesforce on localhost.
// jsforce reads https_proxy/HTTP_PROXY once at load time and ignores NO_PROXY, so proxy
// variables are cleared before importing it (node --test runs each file in its own process).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

for (const k of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) delete process.env[k];
const { createSfClient } = await import('../server/sf/client.js');

test('real jsforce: expired token is refreshed via the sf CLI and the call retried', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, body && JSON.parse(body)]);
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer fresh') {
        res.statusCode = 401;
        return res.end(JSON.stringify([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]));
      }
      res.end(JSON.stringify([{ id: '003000000000001AAA', success: true, errors: [] }]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const instanceUrl = `http://127.0.0.1:${server.address().port}`;
    const cli = { getConnection: async (_t, { refresh = false } = {}) => ({ accessToken: refresh ? 'fresh' : 'stale', instanceUrl, apiVersion: '62.0' }) };
    const res = await createSfClient({ cli }).create('dev', 'Contact', [{ LastName: 'A' }]);
    assert.equal(res[0].id, '003000000000001AAA');
    assert.deepEqual(seen.map((s) => s[2]), ['Bearer stale', 'Bearer fresh']);
    assert.equal(seen[1][1], '/services/data/v62.0/composite/sobjects');
    assert.deepEqual(seen[1][3], { allOrNone: false, records: [{ attributes: { type: 'Contact' }, LastName: 'A' }] });
  } finally {
    server.close();
  }
});

test('real jsforce: query follows nextRecordsUrl and stops at maxFetch, never calls queryAll', async () => {
  const seen = [];
  const page = (from, n) => Array.from({ length: n }, (_, i) => ({ attributes: { type: 'Account', url: '/x' }, Id: `001${String(from + i).padStart(3, '0')}`, Name: `A${from + i}` }));
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/services/data/v62.0/query?q=')) {
      return res.end(JSON.stringify({ totalSize: 7, done: false, nextRecordsUrl: '/services/data/v62.0/query/01gNEXT-3', records: page(0, 3) }));
    }
    if (req.url === '/services/data/v62.0/query/01gNEXT-3') {
      return res.end(JSON.stringify({ totalSize: 7, done: false, nextRecordsUrl: '/services/data/v62.0/query/01gNEXT-6', records: page(3, 3) }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify([{ errorCode: 'NOT_FOUND', message: req.url }]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const instanceUrl = `http://127.0.0.1:${server.address().port}`;
    const cli = { getConnection: async () => ({ accessToken: 't', instanceUrl, apiVersion: '62.0' }) };
    const res = await createSfClient({ cli }).query('dev', 'SELECT Id, Name FROM Account ORDER BY Id', { maxFetch: 5, timeoutMs: 5000 });
    assert.equal(res.records.length, 5);
    assert.equal(res.totalSize, 7);
    assert.equal(res.records[4].Id, '001004');
    assert.equal(seen.length, 2, 'stopped after the page that reached maxFetch');
    assert.equal(decodeURIComponent(seen[0].split('?q=')[1]), 'SELECT Id, Name FROM Account ORDER BY Id');
    assert.ok(seen.every((u) => !u.includes('queryAll')));
  } finally {
    server.close();
  }
});

test('real jsforce: windowed insert maps SaveResults back to refs across windows (design 0004)', async () => {
  const { createInserter } = await import('../server/sf/insert.js');
  const seen = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { records } = JSON.parse(body);
      seen.push(records);
      res.setHeader('Content-Type', 'application/json');
      // The second Contact fails, as Salesforce reports it: per record, in order.
      res.end(JSON.stringify(records.map((r) => (r.LastName === 'bad'
        ? { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'no', fields: ['LastName'] }] }
        : { id: `${r.attributes.type === 'Account' ? '001' : '003'}${String(++n).padStart(15, '0')}`, success: true, errors: [] }))));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const instanceUrl = `http://127.0.0.1:${server.address().port}`;
    const client = createSfClient({ cli: { getConnection: async () => ({ accessToken: 't', instanceUrl, apiVersion: '62.0' }) } });
    const ins = createInserter(client, 'dev', { window: 2, keepId: (ref) => ref.startsWith('acc#') });
    const recs = [
      { ref: 'acc#1', sobject: 'Account', nodeId: 'a', fields: { Name: 'A' } },
      { ref: 'acc#2', sobject: 'Account', nodeId: 'a', fields: { Name: 'B' } },
      { ref: 'con#1', sobject: 'Contact', nodeId: 'c', fields: { LastName: 'ok', AccountId: { $ref: 'acc#2' } } },
      { ref: 'con#2', sobject: 'Contact', nodeId: 'c', fields: { LastName: 'bad', AccountId: { $ref: 'acc#1' } } },
      { ref: 'con#3', sobject: 'Contact', nodeId: 'c', fields: { LastName: 'ok2', AccountId: { $ref: 'acc#1' } } },
    ];
    for (const r of recs) await ins.push(r);
    const res = await ins.end();
    assert.deepEqual(seen.map((s) => s.map((r) => r.attributes.type)), [['Account', 'Account'], ['Contact', 'Contact'], ['Contact']]);
    assert.deepEqual(seen[1].map((r) => r.AccountId), [res.ids['acc#2'], res.ids['acc#1']], 'parents of an earlier window resolved');
    assert.equal(seen[2][0].AccountId, res.ids['acc#1']);
    assert.equal(res.inserted, 4);
    assert.deepEqual(res.errors.map((e) => [e.ref, e.field]), [['con#2', 'fields.LastName']]);
  } finally {
    server.close();
  }
});
