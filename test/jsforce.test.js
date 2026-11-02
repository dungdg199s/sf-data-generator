// Exercises the real jsforce Connection against a fake Salesforce on localhost.
// jsforce reads https_proxy/HTTP_PROXY once at load time and ignores NO_PROXY, so proxy
// variables are cleared before importing it (node --test runs each file in its own process).

import { TEST_DATA_DIR } from './data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

for (const k of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) delete process.env[k];
const { createSfClient } = await import('../server/sf/client.js');
const { startFakeSalesforce, parseCsv } = await import('./fake-salesforce.js');
const { createInserter } = await import('../server/sf/insert.js');
const { createHistory } = await import('../server/history.js');
const { deleteRun } = await import('../server/sf/delete.js');
const { createApp } = await import('../server/index.js');
const path = await import('node:path');
const { mkdtempSync } = await import('node:fs');

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

// ---------- design 0011: Bulk API 2.0, delete, limits through the real jsforce ----------

const cliFor = (sf, extra = {}) => ({
  getConnection: async (_t, { refresh = false } = {}) => ({ accessToken: refresh ? 'fresh' : 'stale', instanceUrl: sf.url, apiVersion: '62.0', username: 'me@x.com', orgId: '00D000000000001AAA', ...extra }),
  listOrgs: async () => [{ alias: 'dev', username: 'me@x.com', isSandbox: true }],
});
const sleepless = { sleep: async () => {} };

test('real jsforce: Bulk job lifecycle in order (refresh on POST /jobs/ingest), CSV as uploaded; forbidden operations throw before any request', async () => {
  const sf = await startFakeSalesforce({ token: 'fresh' });
  try {
    const client = createSfClient({ cli: cliFor(sf) });
    for (const operation of ['hardDelete', 'update', 'upsert', undefined]) {
      assert.throws(() => client.bulkJob('dev', { object: 'Contact', operation }), /không được phép/);
    }
    assert.equal(sf.requests.length, 0, 'no request for a forbidden operation');
    const job = client.bulkJob('dev', { object: 'Contact', operation: 'insert' });
    await job.open();
    await job.upload('LastName,Email\nA,"x,y"\n');
    await job.close();
    let st;
    do st = await job.check(); while (st.state !== 'JobComplete');
    const ok = await job.successfulResults();
    assert.deepEqual(ok.map((r) => [r.LastName, r.Email]), [['A', 'x,y']]);
    assert.deepEqual(sf.requests.map((r) => [r.method, r.path.replace('/services/data/v62.0', ''), r.auth]), [
      ['POST', '/jobs/ingest', 'Bearer stale'],
      ['POST', '/jobs/ingest', 'Bearer fresh'],
      ['PUT', `/jobs/ingest/${job.id}/batches`, 'Bearer fresh'],
      ['PATCH', `/jobs/ingest/${job.id}`, 'Bearer fresh'],
      ['GET', `/jobs/ingest/${job.id}`, 'Bearer fresh'],
      ['GET', `/jobs/ingest/${job.id}`, 'Bearer fresh'],
      ['GET', `/jobs/ingest/${job.id}/successfulResults`, 'Bearer fresh'],
    ]);
    assert.deepEqual(JSON.parse(sf.requests[1].body), { object: 'Contact', operation: 'insert', lineEnding: 'LF', columnDelimiter: 'COMMA' });
    assert.equal(sf.requests[2].body, 'LastName,Email\nA,"x,y"\n');
    assert.deepEqual(JSON.parse(sf.requests[3].body), { state: 'UploadComplete' });
    // destroy: DELETE /composite/sobjects with the Ids, never allOrNone=true (Salesforce default: false).
    const [id] = sf.records.keys();
    const del = await client.destroy('dev', 'Contact', [id, '003000000000999AAA']);
    assert.deepEqual(del.map((r) => r.success), [true, false]);
    const last = sf.requests.at(-1);
    assert.equal(last.method, 'DELETE');
    assert.equal(decodeURIComponent(last.query), `?ids=${id},003000000000999AAA`);
    assert.ok(!/allOrNone=true/.test(last.query));
    assert.throws(() => client.destroy('dev', 'Contact', Array(201).fill(id)), /tối đa 200/);
    assert.deepEqual((await client.limits('dev')).DailyApiRequests, { Max: 15000, Remaining: 14200 });
  } finally {
    await sf.close();
  }
});

test('real jsforce: insert (Collections + Bulk) then delete — the deleted Ids are exactly the inserted ones, no hardDelete', async () => {
  const sf = await startFakeSalesforce({ progressChecks: 1 });
  try {
    const client = createSfClient({ cli: cliFor(sf) });
    const history = createHistory({ dir: path.join(mkdtempSync(path.join(TEST_DATA_DIR, 'j-')), 'history') });
    const steps = [{ nodeId: 'a', alias: 'acc', sobject: 'Account', mode: 'collections', records: 50 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', mode: 'bulk', records: 2500, jobs: 3 }];
    const entry = await history.create({ org: { alias: 'dev', username: 'me@x.com', orgId: '00D000000000001AAA' }, workflow: null, seed: 1, now: 1, bulk: 'auto', steps, total: 2550 });
    const ins = createInserter(client, 'dev', {
      keepId: (ref) => ref.startsWith('acc#'), plan: { c: steps[1] }, bulk: { ...sleepless, jobRecords: 1000 },
      onInserted: (rows) => entry.appendIds(rows), onBulkJob: (j) => entry.recordJob(j),
    });
    let c = 0;
    for (let a = 1; a <= 50; a++) {
      await ins.push({ ref: `acc#${a}`, sobject: 'Account', nodeId: 'a', fields: { Name: `A${a}` } });
      for (let k = 0; k < 50; k++) await ins.push({ ref: `con#${++c}`, sobject: 'Contact', nodeId: 'c', fields: { LastName: `C${c}`, AccountId: { $ref: `acc#${a}` } } });
    }
    const res = await ins.end();
    await entry.finish({ status: 'done', inserted: res.inserted });
    assert.equal(res.inserted, 2550);
    assert.equal([...sf.jobs.values()].filter((j) => j.operation === 'insert').length, 3);
    const insertedIds = new Set(sf.records.keys());
    assert.equal(insertedIds.size, 2550);
    const writesBefore = sf.writes().length;

    const handle = await history.open(entry.id);
    const out = await deleteRun({ client, target: 'dev', entry: handle, history, limits: { bulkMinRecords: 1000, bulkJobRecords: 1000 }, options: sleepless });
    assert.deepEqual([out.deleted, out.gone, out.failed, out.remaining], [2550, 0, 0, 0]);
    // Every Id sent to a DELETE or a delete job, and nothing else.
    const sent = [];
    for (const r of sf.writes().slice(writesBefore)) {
      if (r.method === 'DELETE') sent.push(...new URL(`http://x${r.url}`).searchParams.get('ids').split(','));
      const m = /\/jobs\/ingest\/([^/]+)\/batches$/.exec(r.path);
      if (m && r.method === 'PUT') {
        assert.equal(sf.jobs.get(m[1]).operation, 'delete');
        sent.push(...parseCsv(r.body).slice(1).map((l) => l[0]));
      }
    }
    assert.equal(sent.length, 2550);
    assert.deepEqual(new Set(sent), insertedIds);
    assert.ok(![...sf.jobs.values()].some((j) => !['insert', 'delete'].includes(j.operation)), 'no hardDelete job');
    // Children first: every Contact Id was sent before the first Account Id.
    const firstAccount = sent.findIndex((id) => id.startsWith('001'));
    assert.ok(sent.slice(firstAccount).every((id) => id.startsWith('001')));
    // Deleting again: everything is gone, nothing left to send.
    assert.equal((await history.remaining(entry.id)).total, 0);
  } finally {
    await sf.close();
  }
});

/** App on a fake Salesforce, real jsforce client; → { url, sf, history, close }. */
async function appOnFakeSf({ orgs, cli: extraCli = {}, sfOptions = {} } = {}) {
  const sf = await startFakeSalesforce(sfOptions);
  const history = createHistory({ dir: path.join(mkdtempSync(path.join(TEST_DATA_DIR, 'a-')), 'history') });
  const cli = { ...cliFor(sf), ...(orgs ? { listOrgs: async () => orgs } : {}), ...extraCli };
  const server = http.createServer(createApp({ cli, history, deleteOptions: sleepless, runOptions: { insertOptions: { bulk: sleepless } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, sf, history, cli, close: async () => { server.close(); await sf.close(); } };
}
const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const accConWf = (accounts, per) => ({ version: 2, name: 'Account + Contact', steps: [{ id: 'l', type: 'loop', config: { count: accounts }, slots: { body: [
  { id: 'a', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [{ name: 'Name', type: 'text', options: { mode: 'company' } }] } },
  { id: 'm', type: 'loop', config: { count: per }, slots: { body: [{ id: 'c', type: 'record', config: { sobject: 'Contact', alias: 'con', fields: [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }] } }] } },
] } }] });

test('delete endpoint: every refused request answers the exact message and makes 0 write requests', async () => {
  const app = await appOnFakeSf({ orgs: [{ alias: 'dev', username: 'me@x.com', isSandbox: false, isScratch: false }] });
  try {
    const ins = await (await postJson(`${app.url}/api/run`, { workflow: accConWf(3, 2), seed: 1, target: { kind: 'org', org: 'dev' } })).json();
    const hid = ins.insert.historyId;
    assert.equal(ins.insert.inserted, 9);
    const before = app.sf.writes().length;
    const del = (body) => postJson(`${app.url}/api/history/${hid}/delete`, body);
    const expect = async (res, status, message) => {
      assert.equal(res.status, status);
      const b = await res.json();
      if (message instanceof RegExp) assert.match(b.error, message);
      else assert.equal(b.error, message);
    };
    await expect(await postJson(`${app.url}/api/history/h20261028T103200Z-a1b2c3/delete`, { confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }), 404, 'Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).');
    await expect(await postJson(`${app.url}/api/history/..%2F..%2Fx/delete`, { confirm: { username: 'me@x.com', count: 9 } }), 404, /^Không tìm thấy lần insert này/);
    await expect(await del({}), 400, 'Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.');
    await expect(await del({ confirm: { username: 'other@x.com', count: 9, typedOrg: 'dev' } }), 409, 'Xác nhận ghi org "other@x.com" nhưng lần insert này thuộc org "me@x.com". Mở lại hộp xác nhận.');
    await expect(await del({ confirm: { username: 'me@x.com', count: 10, typedOrg: 'dev' } }), 409, 'Số bản ghi còn phải xóa đã đổi (còn 9, hộp xác nhận ghi 10). Mở lại hộp xác nhận để xem số mới.');
    await expect(await del({ confirm: { username: 'me@x.com', count: 9 } }), 400, 'Org "dev" là production: gõ đúng tên org trong hộp xác nhận để xóa.');
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'prod' } }), 400, /là production/);
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' }, bulk: 'x' }), 400, 'bulk phải là "auto" hoặc "off".');
    // The alias now names another org (sandbox refresh, re-login elsewhere).
    app.cli.getConnection = async () => ({ accessToken: 't', instanceUrl: app.sf.url, apiVersion: '62.0', username: 'me2@x.com', orgId: '00D000000000002AAA' });
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }), 409, 'Org "dev" bây giờ là org khác (00D000000000002AAA, me2@x.com) so với lúc insert (00D000000000001AAA, me@x.com). Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias dev rồi thử lại.');
    app.cli.getConnection = async () => { throw new Error('Org "dev" chưa đăng nhập hoặc token hết hạn.'); };
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }), 502, 'Org "dev" chưa đăng nhập hoặc token hết hạn. Đăng nhập lại: sf org login web --alias dev');
    // A cross-site page and a text/plain body are refused by requestGuard (403 / 415).
    assert.equal((await postJson(`${app.url}/api/history/${hid}/delete`, { confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${app.url}/api/history/${hid}/delete`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }) })).status, 415);
    assert.equal(app.sf.writes().length, before, 'no write request for any refused delete');
    // While the insert runs: 409.
    app.history.inserting.add(hid);
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }), 409, 'Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.');
    app.history.inserting.delete(hid);
    app.history.deleting.add(hid);
    await expect(await del({ confirm: { username: 'me@x.com', count: 9, typedOrg: 'dev' } }), 409, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
    app.history.deleting.delete(hid);
    assert.equal(app.sf.writes().length, before);

    // The real thing (typed name, NDJSON), then nothing is left.
    app.cli.getConnection = cliFor(app.sf).getConnection;
    const res = await postJson(`${app.url}/api/history/${hid}/delete`, { confirm: { username: 'me@x.com', count: 9, typedOrg: ' DEV ' } }, { Accept: 'application/x-ndjson' });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'start');
    assert.deepEqual(events[0].bySobject, { Contact: 6, Account: 3 });
    const done = events.at(-1);
    assert.deepEqual([done.type, done.result.deleted, done.result.remaining], ['done', 9, 0]);
    const writes = app.sf.writes().slice(before);
    assert.ok(writes.every((w) => w.method === 'DELETE'), 'only deletes');
    const after = app.sf.writes().length;
    await expect(await del({ confirm: { username: 'me@x.com', count: 0, typedOrg: 'dev' } }), 409, 'Lần insert này không còn bản ghi nào để xóa.');
    assert.equal(app.sf.writes().length, after);
    const run = await (await fetch(`${app.url}/api/history/${hid}`)).json();
    assert.deepEqual([run.deletion.status, run.deletion.deleted, run.remaining.total, run.hasParents], ['done', 9, 0, true]);
  } finally {
    await app.close();
  }
});

test('NDJSON insert with Bulk through the app: plan steps, every Id in ids.csv (Bulk ones too); preview makes no history entry', async () => {
  const app = await appOnFakeSf();
  try {
    await (await postJson(`${app.url}/api/run`, { workflow: accConWf(2, 2), seed: 1 }, { Accept: 'application/x-ndjson' })).text();
    assert.equal((await (await fetch(`${app.url}/api/history`)).json()).runs.length, 0, 'a preview is not recorded');
    const w = accConWf(10, 1001); // 10 Accounts, 10 010 leaf Contacts ⇒ Bulk
    w.settings = { maxRecords: 20000 };
    const text = await (await postJson(`${app.url}/api/run`, { workflow: w, seed: 2, target: { kind: 'org', org: 'dev' } }, { Accept: 'application/x-ndjson' })).text();
    const events = text.trim().split('\n').map((l) => JSON.parse(l));
    const plan = events.find((e) => e.type === 'plan');
    assert.deepEqual(plan.steps.map((s) => [s.nodeId, s.mode, s.probe, s.jobs]), [['a', 'collections', 0, 0], ['c', 'bulk', 200, 1]]);
    assert.deepEqual([plan.apiCalls, plan.apiCallsBy], [14, { collections: 2, bulk: 12 }]);
    assert.match(plan.historyId, /^h\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    const done = events.at(-1).result.insert;
    assert.deepEqual([done.inserted, done.failed, done.historyId], [10020, 0, plan.historyId]);
    assert.deepEqual(done.bulk, [{ nodeId: 'c', sobject: 'Contact', jobs: 1, records: 9810, inserted: 9810, failed: 0 }]);
    const list = await (await fetch(`${app.url}/api/history`)).json();
    assert.equal(list.enabled, true);
    assert.deepEqual([list.runs[0].id, list.runs[0].status, list.runs[0].inserted], [plan.historyId, 'done', 10020]);
    const csvRes = await fetch(`${app.url}/api/history/${plan.historyId}/ids.csv`);
    assert.match(csvRes.headers.get('content-disposition'), /attachment; filename="Account_Contact-\d{8}-\d{4}-ids\.csv"/);
    const lines = (await csvRes.text()).trim().split('\r\n');
    assert.equal(lines[0], 'sobject,id,ref,step,status');
    assert.equal(lines.length - 1, 10020);
    assert.deepEqual(new Set(lines.slice(1).map((l) => l.split(',')[1])), new Set(app.sf.records.keys()));
    const only = (await (await fetch(`${app.url}/api/history/${plan.historyId}/ids.csv?sobject=Account`)).text()).trim().split('\r\n');
    assert.equal(only.length - 1, 10);
    // forget removes the three files; afterwards 404.
    assert.deepEqual(await (await postJson(`${app.url}/api/history/${plan.historyId}/forget`, {})).json(), { ok: true });
    assert.equal((await fetch(`${app.url}/api/history/${plan.historyId}`)).status, 404);
    assert.equal((await postJson(`${app.url}/api/history/${plan.historyId}/forget`, {})).status, 404);
    // limits (cached), cross-site refused.
    assert.deepEqual(await (await fetch(`${app.url}/api/orgs/dev/limits`)).json(), { api: { max: 15000, remaining: 14200 }, bulkBatches: { max: 15000, remaining: 14980 } });
    assert.equal((await fetch(`${app.url}/api/orgs/dev/limits`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${app.url}/api/history/${plan.historyId}/ids.csv`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${app.url}/api/history`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal(app.sf.requests.filter((r) => r.path.endsWith('/limits')).length, 1);
  } finally {
    await app.close();
  }
});

// ---------- 0011 "Sửa sau review" ----------

test('review B1: Dừng / closing the tab while the delete checks run (slow sf org display) deletes nothing', async () => {
  const app = await appOnFakeSf();
  try {
    const ins = await (await postJson(`${app.url}/api/run`, { workflow: accConWf(3, 2), seed: 1, target: { kind: 'org', org: 'dev' } })).json();
    const hid = ins.insert.historyId;
    const base = cliFor(app.sf).getConnection;
    let entered;
    let finished;
    const lookup = new Promise((r) => { entered = r; });
    const lookupDone = new Promise((r) => { finished = r; });
    app.cli.getConnection = async (t, o = {}) => {
      if (o.refresh) {
        entered();
        await new Promise((r) => setTimeout(r, 300));
        setImmediate(finished);
      }
      return base(t, o);
    };
    const before = app.sf.writes().length;
    const ctl = new AbortController();
    const req = fetch(`${app.url}/api/history/${hid}/delete`, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ confirm: { username: 'me@x.com', count: 9 } }) }).catch((e) => e.name);
    await lookup;
    ctl.abort();
    assert.equal(await req, 'AbortError');
    // The checks end after the slow lookup; watch for writes for a while after that (the old code
    // deleted everything within a few ms here).
    await lookupDone;
    for (let t = 0; t < 25 && app.sf.writes().length === before; t++) await new Promise((r) => setTimeout(r, 20));
    while (app.history.deleting.has(hid)) await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.sf.writes().length, before, 'no DELETE after the client left');
    assert.equal(app.sf.deleted.size, 0);
    const run = await (await fetch(`${app.url}/api/history/${hid}`)).json();
    assert.deepEqual([run.deletion.status, run.remaining.total], ['none', 9], 'the run is as it was');
  } finally {
    await app.close();
  }
});

test('review B2: an alias re-pointed to another org after the Connection was cached — insert, history and delete all use the new org', async () => {
  const A = await startFakeSalesforce();
  const B = await startFakeSalesforce();
  let cur = { accessToken: 't', instanceUrl: A.url, apiVersion: '62.0', username: 'me@x.com', orgId: '00D00000000000AAAA' };
  const cli = { getConnection: async () => cur, listOrgs: async () => [{ alias: 'dev', username: 'me@x.com', isSandbox: true }] };
  const history = createHistory({ dir: path.join(mkdtempSync(path.join(TEST_DATA_DIR, 's-')), 'history') });
  const server = http.createServer(createApp({ cli, history, deleteOptions: sleepless }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${url}/api/orgs/dev/limits`); // the Connection to A is cached
    cur = { ...cur, instanceUrl: B.url, orgId: '00D00000000000BBBB' }; // sf org login web --alias dev → org B
    const ins = await (await postJson(`${url}/api/run`, { workflow: accConWf(2, 2), seed: 1, target: { kind: 'org', org: 'dev' } })).json();
    assert.equal(ins.insert.inserted, 6);
    assert.deepEqual([A.records.size, B.records.size], [0, 6], 'written to the org the CLI names now');
    const run = await (await fetch(`${url}/api/history/${ins.insert.historyId}`)).json();
    assert.deepEqual([run.org.orgId, run.org.instanceUrl], ['00D00000000000BBBB', B.url]);
    const del = await (await postJson(`${url}/api/history/${ins.insert.historyId}/delete`, { confirm: { username: 'me@x.com', count: 6 } })).json();
    assert.deepEqual([del.deleted, del.gone, B.deleted.size], [6, 0, 6]);
    assert.equal(A.writes().length, 0);
  } finally {
    server.close();
    await A.close();
    await B.close();
  }
});

test('review B2: a token refresh that lands in another org is refused (no retried write); no orgId ⇒ no insert', async () => {
  const sf = await startFakeSalesforce({ token: 'fresh' });
  try {
    let orgId = '00D00000000000AAAA';
    const cli = { getConnection: async (_t, { refresh = false } = {}) => ({ accessToken: refresh ? 'fresh' : 'stale', instanceUrl: sf.url, apiVersion: '62.0', username: 'me@x.com', orgId }) };
    const client = createSfClient({ cli });
    assert.deepEqual(await client.orgOf('dev'), { username: 'me@x.com', orgId: '00D00000000000AAAA', instanceUrl: sf.url });
    orgId = '00D00000000000BBBB'; // the refresh says: another org
    await assert.rejects(client.create('dev', 'Contact', [{ LastName: 'A' }]), (e) => e.status === 502 && /bây giờ là org khác/.test(e.message));
    assert.equal(sf.writes().filter((w) => w.auth === 'Bearer fresh').length, 0, 'the write was not retried with the other org\'s token');
    assert.equal(sf.records.size, 0);

    const app = await appOnFakeSf({ cli: { getConnection: async () => ({ accessToken: 't', instanceUrl: sf.url, apiVersion: '62.0', username: 'me@x.com' }) } });
    try {
      const res = await postJson(`${app.url}/api/run`, { workflow: accConWf(1, 1), seed: 1, target: { kind: 'org', org: 'dev' } });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /^sf CLI không cho biết org "dev" là org nào \(thiếu orgId hoặc username\), nên chưa ghi gì vào org\./);
      assert.equal(app.sf.writes().length, 0);
      assert.equal((await (await fetch(`${app.url}/api/history`)).json()).runs.length, 0);
    } finally {
      await app.close();
    }
  } finally {
    await sf.close();
  }
});

test('review S1: two deletes of one run at once — one runs (200), the other gets 409; each Id is deleted once', async () => {
  const app = await appOnFakeSf();
  try {
    const ins = await (await postJson(`${app.url}/api/run`, { workflow: accConWf(3, 2), seed: 1, target: { kind: 'org', org: 'dev' } })).json();
    const hid = ins.insert.historyId;
    const base = cliFor(app.sf).getConnection;
    app.cli.getConnection = async (t, o) => { await new Promise((r) => setTimeout(r, 50)); return base(t, o); };
    const before = app.sf.writes().length;
    const body = { confirm: { username: 'me@x.com', count: 9 } };
    const [a, b] = await Promise.all([postJson(`${app.url}/api/history/${hid}/delete`, body), postJson(`${app.url}/api/history/${hid}/delete`, body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const refused = a.status === 409 ? a : b;
    assert.equal((await refused.json()).error, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
    const ids = app.sf.writes().slice(before).flatMap((w) => new URL(`http://x${w.url}`).searchParams.get('ids')?.split(',') ?? []);
    assert.equal(ids.length, 9);
    assert.equal(new Set(ids).size, 9, 'no Id sent twice');
    assert.equal(app.history.deleting.size, 0, 'the claim is released');
  } finally {
    await app.close();
  }
});

test('review nits: /limits with a malformed escape is 404; production refusal carries code typedOrgRequired; a failing first save keeps the status and deletes nothing; /api/history/status', async () => {
  const app = await appOnFakeSf({ orgs: [{ alias: 'dev', username: 'me@x.com', isSandbox: false }] });
  try {
    assert.equal((await fetch(`${app.url}/api/orgs/%E0%A4%A/limits`)).status, 404);
    const status = await (await fetch(`${app.url}/api/history/status`)).json();
    assert.deepEqual([status.enabled, status.full, status.maxRuns, 'runs' in status], [true, false, 100, false]);
    const ins = await (await postJson(`${app.url}/api/run`, { workflow: accConWf(1, 1), seed: 1, target: { kind: 'org', org: 'dev' } })).json();
    const hid = ins.insert.historyId;
    const res = await postJson(`${app.url}/api/history/${hid}/delete`, { confirm: { username: 'me@x.com', count: 2 } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'typedOrgRequired');
    // The first "deleting" save fails once (disk full…): no delete, the status stays "none".
    const open = app.history.open.bind(app.history);
    let failOnce = true;
    app.history.open = async (h) => {
      const e = await open(h);
      const save = e.save;
      return { ...e, save: (patch) => { if (failOnce) { failOnce = false; return Promise.reject(new Error('ENOSPC: no space left on device')); } return save(patch); } };
    };
    const before = app.sf.writes().length;
    const bad = await postJson(`${app.url}/api/history/${hid}/delete`, { confirm: { username: 'me@x.com', count: 2, typedOrg: 'dev' } });
    assert.equal(bad.status, 500);
    assert.equal(app.sf.writes().length, before);
    const run = await (await fetch(`${app.url}/api/history/${hid}`)).json();
    assert.equal(run.deletion.status, 'none');
    assert.equal(app.history.deleting.size, 0);
  } finally {
    await app.close();
  }
});
