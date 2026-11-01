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
    // The org Id must be known for a refresh to be accepted (fail closed, review 2 of 0011).
    const cli = { getConnection: async (_t, { refresh = false } = {}) => ({ accessToken: refresh ? 'fresh' : 'stale', instanceUrl, apiVersion: '62.0', orgId: '00D000000000001AAA' }) };
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

// ---------- design 0011: Bulk API 2.0, destroy, limits (fake Salesforce on localhost) ----------

const { startFakeSalesforce, fakeCli } = await import('./fake-salesforce.js');

test('real jsforce: a Bulk 2.0 insert job runs open → upload → close → check → results, in order, with the CSV as sent', async () => {
  const fake = await startFakeSalesforce();
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    const job = client.bulkJob('dev', { object: 'Contact', operation: 'insert' });
    const info = await job.open();
    assert.equal(info.state, 'Open');
    assert.match(job.id, /^7504x/);
    const csv = 'LastName,Description\nA,"x, ""y"""\nB,\n';
    await job.upload(csv);
    await job.close();
    assert.equal((await job.check()).state, 'InProgress');
    const done = await job.check();
    assert.deepEqual([done.state, done.numberRecordsProcessed, done.numberRecordsFailed], ['JobComplete', 2, 0]);
    const ok = await job.successfulResults();
    assert.match(ok, /^"?sf__Id"?,"?sf__Created"?,LastName,Description\n/);
    assert.equal(ok.trim().split('\n').length, 3);
    assert.equal(await job.failedResults(), 'sf__Id,sf__Error,LastName,Description\n');
    const seq = fake.requests.map((r) => `${r.method} ${r.path.replace(job.id, ':id')}`);
    assert.deepEqual(seq, [
      'POST /jobs/ingest', 'PUT /jobs/ingest/:id/batches', 'PATCH /jobs/ingest/:id', 'GET /jobs/ingest/:id', 'GET /jobs/ingest/:id',
      'GET /jobs/ingest/:id/successfulResults', 'GET /jobs/ingest/:id/failedResults',
    ]);
    assert.deepEqual(fake.requests[0].body, { object: 'Contact', operation: 'insert', lineEnding: 'LF', columnDelimiter: 'COMMA', contentType: 'CSV' });
    assert.equal(fake.requests[1].body, csv, 'the CSV reaches Salesforce byte for byte');
    assert.deepEqual(fake.requests[2].body, { state: 'UploadComplete' });
    assert.deepEqual([...fake.records.values()].map((r) => r.fields), [{ LastName: 'A', Description: 'x, "y"' }, { LastName: 'B', Description: '' }]);
  } finally {
    await fake.close();
  }
});

test('real jsforce: bulkJob refuses hardDelete / update / upsert / anything else before any request', async () => {
  const fake = await startFakeSalesforce();
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    for (const operation of ['hardDelete', 'update', 'upsert', 'query', undefined, 'HARDDELETE']) {
      assert.throws(() => client.bulkJob('dev', { object: 'Contact', operation }), /not allowed/);
    }
    assert.throws(() => client.bulkJob('dev', { object: '../x', operation: 'insert' }), /invalid sObject/);
    // A job attached by id is read-only: no open / upload / close.
    const attached = client.bulkJob('dev', { jobId: '7504x0000000001AAA' });
    assert.throws(() => attached.open(), /read-only/);
    assert.throws(() => attached.upload('Id\n1\n'), /read-only/);
    assert.throws(() => attached.close(), /read-only/);
    assert.throws(() => attached.abort(), /read-only/, 'N3: an attached job cannot be aborted either');
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('real jsforce: destroy sends DELETE /composite/sobjects with exactly the Ids (no allOrNone=true); more than 200 Ids throw', async () => {
  const fake = await startFakeSalesforce();
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    const created = await client.create('dev', 'Account', [{ Name: 'A' }, { Name: 'B' }]);
    const ids = created.map((r) => r.id);
    const res = await client.destroy('dev', 'Account', [ids[1], ids[0], '001000000000999AAA']);
    assert.deepEqual(res.map((r) => r.success), [true, true, false]);
    assert.equal(res[2].errors[0].statusCode, 'ENTITY_IS_DELETED');
    const del = fake.requests.find((r) => r.method === 'DELETE');
    assert.equal(del.path, '/composite/sobjects');
    assert.equal(del.query.ids, `${ids[1]},${ids[0]},001000000000999AAA`);
    assert.notEqual(del.query.allOrNone, 'true');
    assert.deepEqual(fake.alive(), []);
    assert.throws(() => client.destroy('dev', 'Account', Array.from({ length: 201 }, (_, i) => `001${i}`)), /at most 200/);
    assert.equal(fake.writes().length, 2);
  } finally {
    await fake.close();
  }
});

test('real jsforce: 401 INVALID_SESSION_ID on POST /jobs/ingest refreshes the token via the CLI and retries', async () => {
  const fake = await startFakeSalesforce({ expireOnce: new Set(['POST /jobs/ingest']) });
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    const job = client.bulkJob('dev', { object: 'Contact', operation: 'delete' });
    await job.open();
    assert.deepEqual(fake.requests.map((r) => [r.method, r.path, r.auth]), [
      ['POST', '/jobs/ingest', 'Bearer SECRET-TOKEN-123'],
      ['POST', '/jobs/ingest', 'Bearer SECRET-TOKEN-123-fresh'],
    ]);
    assert.equal(fake.jobs.size, 1);
  } finally {
    await fake.close();
  }
});

test('real jsforce: limits reads /limits; Salesforce errors of a job are 502 with the code', async () => {
  const fake = await startFakeSalesforce({ openJobError: () => ({ errorCode: 'INVALIDENTITY', message: 'Entity is not supported by the Bulk API' }) });
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    const l = await client.limits('dev');
    assert.deepEqual(l.DailyApiRequests, { Max: 15000, Remaining: 14200 });
    const job = client.bulkJob('dev', { object: 'Contact__x', operation: 'insert' });
    await assert.rejects(job.open(), (e) => e.status === 502 && e.cause?.errorCode === 'INVALIDENTITY' && /INVALIDENTITY/.test(e.message));
  } finally {
    await fake.close();
  }
});

test('real jsforce: Bulk inserter (Account 300 + Contact 12 000) against the fake: probe, 2 jobs, every created Id reaches onInserted', async () => {
  const { createInserter } = await import('../server/sf/insert.js');
  const { planInsert } = await import('../shared/insert-plan.js');
  const fake = await startFakeSalesforce();
  try {
    const client = createSfClient({ cli: fakeCli(fake) });
    const recs = [];
    let c = 0;
    for (let a = 1; a <= 300; a++) {
      recs.push({ ref: `acc#${a}`, sobject: 'Account', alias: 'acc', nodeId: 'a', fields: { Name: `Acme, "${a}"` } });
      for (let k = 0; k < 40; k++) recs.push({ ref: `con#${++c}`, sobject: 'Contact', alias: 'con', nodeId: 'c', fields: { LastName: `L${c}`, Description: c % 7 ? null : 'two\nlines; a|b', AccountId: { $ref: `acc#${a}` } } });
    }
    const plan = planInsert({ steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 300 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 12000 }], referenced: new Set(['acc']) });
    const saved = [];
    const ins = createInserter(client, 'dev', { plan, keepId: (r) => r.startsWith('acc#'), onInserted: async (rows) => { saved.push(...rows); }, bulkOptions: { sleep: () => new Promise((r) => setImmediate(r)) } });
    for (const r of recs) await ins.push(r);
    const res = await ins.end();
    assert.equal(res.inserted, 12300);
    assert.equal(fake.jobs.size, 2);
    assert.deepEqual([...fake.jobs.values()].map((j) => [j.operation, j.state, j.results.length]), [['insert', 'JobComplete', 10000], ['insert', 'JobComplete', 1800]]);
    assert.deepEqual(new Set(saved.map((r) => r.id)), new Set(fake.alive()));
    // Contacts point at the Accounts' real Ids; multi-line values with ; and | survive both ways.
    const accIds = new Set(fake.alive('Account'));
    const contacts = [...fake.records.values()].filter((r) => r.sobject === 'Contact');
    assert.ok(contacts.every((r) => accIds.has(r.fields.AccountId)));
    assert.equal(contacts.filter((r) => r.fields.Description === 'two\nlines; a|b').length, Math.floor(12000 / 7));
    assert.ok(fake.writes().every((w) => !(w.path.startsWith('/jobs/ingest') && w.method === 'POST' && w.body.operation !== 'insert')));
  } finally {
    await fake.close();
  }
});

test('real jsforce: a refreshed token of another org is refused; the call is not retried (review of 0011, S1)', async () => {
  const fake = await startFakeSalesforce({ expireOnce: new Set(['POST /composite/sobjects']) });
  try {
    const cli = fakeCli(fake);
    const getConnection = cli.getConnection.bind(cli);
    cli.getConnection = async (t, o = {}) => ({ ...(await getConnection(t, o)), ...(o.refresh ? { orgId: '00D000000000002BBB' } : {}) });
    const client = createSfClient({ cli });
    await assert.rejects(client.create('dev', 'Contact', [{ LastName: 'A' }]), /bây giờ là org khác/);
    assert.equal(fake.requests.filter((r) => r.method === 'POST').length, 1, 'only the request refused with 401');
    assert.equal(fake.records.size, 0);
    const who = await createSfClient({ cli: fakeCli(fake) }).whoami('dev');
    assert.deepEqual([who.orgId, who.username], ['00D000000000001AAA', 'me@example.com']);
  } finally {
    await fake.close();
  }
});
