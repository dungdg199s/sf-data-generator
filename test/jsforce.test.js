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
