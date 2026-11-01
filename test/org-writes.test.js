// Org writes end to end (design 0011): the real app (createApp) with real jsforce against the fake
// Salesforce on localhost, insert history in a temporary directory. Never a real org.
// jsforce reads the proxy variables once at load time and ignores NO_PROXY, so they are cleared
// before anything imports it (node --test runs each file in its own process).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for (const k of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) delete process.env[k];
const { createApp } = await import('../server/index.js');
const { createHistory } = await import('../server/history.js');
const { startFakeSalesforce, fakeCli } = await import('./fake-salesforce.js');
const { wf, record, loop } = await import('./helpers.js');

const tick = () => new Promise((r) => setImmediate(r));
const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** Account × n, each with `per` Contacts (Lookup), seed 7. */
const accCon = (n, per) => wf([loop('l', { count: n }, [
  record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { mode: 'company' } }]),
  loop('m', { count: per }, [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])]),
])], { name: 'Account + Contact' });

export async function stack({ fake: fakeOpts = {}, cli: cliOpts = {}, historyOpts = {} } = {}) {
  const fake = await startFakeSalesforce(fakeOpts);
  const cli = fakeCli(fake, cliOpts);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfdg-orgwrites-'));
  dirs.push(dir);
  const history = createHistory({ dir, ...historyOpts });
  const app = http.createServer(createApp({
    cli, history,
    runOptions: { progressIntervalMs: 0, insertOptions: { bulkOptions: { sleep: tick } } },
    deleteOptions: { bulkOptions: { sleep: tick } },
  }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body, headers = {}) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const ndjson = async (p, body) => {
    const res = await post(p, body, { Accept: 'application/x-ndjson' });
    const text = await res.text();
    return { status: res.status, events: text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  };
  const insert = async (workflow, target = {}) => ndjson('/api/run', { workflow, seed: 7, now: Date.parse('2026-10-28T10:00:00Z'), target: { kind: 'org', org: 'dev', ...target } });
  return {
    fake, cli, dir, history, url, post, ndjson, insert,
    get: (p, headers = {}) => fetch(url + p, { headers }),
    close: async () => {
      app.close();
      await fake.close();
    },
  };
}

test('insert with Bulk: plan, history entry, ids.csv lists every Id the org got (Bulk Ids included), status inserted', async () => {
  const s = await stack();
  try {
    const { events } = await s.insert(accCon(30, 400)); // 30 Account + 12 000 Contact
    const plan = events.find((e) => e.type === 'plan');
    assert.deepEqual(plan.steps.map((x) => [x.nodeId, x.mode, x.jobs]), [['a', 'collections', 0], ['c', 'bulk', 2]]);
    assert.match(plan.historyId, /^h\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    const ins = done.result.insert;
    assert.equal(ins.inserted, 12030);
    assert.equal(ins.historyId, plan.historyId);
    assert.deepEqual(ins.bulk.map((b) => [b.nodeId, b.jobs, b.inserted]), [['c', 2, 12000]]);
    assert.ok(events.some((e) => e.type === 'progress' && e.phase === 'insert' && e.bulk?.jobId), 'progress names the Bulk job');
    assert.equal(s.fake.jobs.size, 2);

    const csv = await s.get(`/api/history/${ins.historyId}/ids.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="Account_Contact-\d{8}-\d{4}-ids\.csv"$/);
    const lines = (await csv.text()).trim().split('\r\n');
    assert.equal(lines[0], 'sobject,id,ref,step,status');
    const rows = lines.slice(1).map((l) => l.split(','));
    assert.deepEqual(new Set(rows.map((r) => r[1])), new Set(s.fake.alive()));
    assert.equal(rows.length, 12030);
    assert.ok(rows.every((r) => r[4] === 'inserted'));
    assert.equal(rows.filter((r) => r[0] === 'Account' && /^acc#\d+$/.test(r[2])).length, 30);
    const onlyAcc = (await (await s.get(`/api/history/${ins.historyId}/ids.csv?sobject=Account`)).text()).trim().split('\r\n');
    assert.equal(onlyAcc.length, 31);

    const list = await (await s.get('/api/history')).json();
    assert.equal(list.enabled, true);
    assert.equal(list.runs.length, 1);
    assert.deepEqual([list.runs[0].status, list.runs[0].inserted, list.runs[0].workflowName, list.runs[0].org.alias, list.runs[0].org.kind], ['done', 12030, 'Account + Contact', 'dev', 'sandbox']);
    assert.equal(list.runs[0].deletion.remaining, 12030);
    const one = await (await s.get(`/api/history/${ins.historyId}`)).json();
    assert.ok(!('workflow' in one));
    assert.deepEqual(one.remaining.bySobject, { Account: 30, Contact: 12000 });
    assert.deepEqual(one.bulkJobs.map((j) => [j.state, j.idsCollected]), [['JobComplete', true], ['JobComplete', true]]);
    assert.deepEqual(one.pendingBulkJobs, []);
  } finally {
    await s.close();
  }
});

test('a preview creates no history entry; forget removes the entry files; unknown / malformed hid ⇒ 404', async () => {
  const s = await stack();
  try {
    const prev = await s.ndjson('/api/run', { workflow: accCon(2, 2), seed: 1 });
    assert.equal(prev.events.at(-1).type, 'done');
    assert.deepEqual((await (await s.get('/api/history')).json()).runs, []);
    const { events } = await s.insert(accCon(2, 2));
    const hid = events.at(-1).result.insert.historyId;
    const entryFiles = async () => (await readdir(path.join(s.dir, 'history'))).filter((f) => !f.startsWith('.'));
    assert.equal((await entryFiles()).length, 2);
    const f = await s.post(`/api/history/${hid}/forget`, {});
    assert.deepEqual([f.status, await f.json()], [200, { ok: true }]);
    assert.deepEqual(await entryFiles(), [], 'only the server lock (.lock) is left');
    for (const bad of [hid, '..%2F..%2Fetc%2Fpasswd', 'h20261028T103200Z-zzzzzz', '%E0%A4%A']) {
      const r = await s.get(`/api/history/${bad}`);
      assert.equal(r.status, 404, bad);
      assert.equal((await r.json()).error, 'Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).');
      assert.equal((await s.get(`/api/history/${bad}/ids.csv`)).status, 404);
      assert.equal((await s.post(`/api/history/${bad}/forget`, {})).status, 404);
    }
  } finally {
    await s.close();
  }
});

test('GET /api/history names in `prune` the entries the next insert would drop while they still have records in the org', async () => {
  const s = await stack({ historyOpts: { maxRuns: 1 } });
  try {
    assert.deepEqual((await (await s.get('/api/history')).json()).prune, []);
    const { events } = await s.insert(accCon(2, 2));
    const hid = events.at(-1).result.insert.historyId;
    const { prune } = await (await s.get('/api/history')).json();
    assert.deepEqual(prune.map((e) => [e.id, e.remaining, e.workflowName, e.org.alias]), [[hid, 6, 'Account + Contact', 'dev']]);
  } finally {
    await s.close();
  }
});

test('history that cannot be written: the insert answers an error and the org receives no write', async () => {
  const fake = await startFakeSalesforce();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfdg-orgwrites-'));
  dirs.push(dir);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'blocker'), '');
  const app = http.createServer(createApp({ cli: fakeCli(fake), history: createHistory({ dir: path.join(dir, 'blocker', 'x') }) }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${app.address().port}`;
    // S7: answered 503 before the run is prepared, in NDJSON and JSON mode alike.
    for (const accept of ['application/x-ndjson', 'application/json']) {
      const res = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify({ workflow: accCon(2, 2), seed: 1, target: { kind: 'org', org: 'dev' } }) });
      assert.equal(res.status, 503, accept);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.match((await res.json()).error, /^Không ghi được Lịch sử \(.*\), nên chưa ghi gì vào org\. Kiểm tra quyền ghi thư mục .*history hoặc đặt SFDG_DATA_DIR\.$/);
    }
    assert.equal(fake.writes().length, 0);
    assert.equal(fake.requests.length, 0, 'not even the identity is read');
    // A preview still works without history.
    const prev = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: accCon(2, 2), seed: 1 }) });
    assert.equal(prev.status, 200);
    const h = await (await fetch(`${url}/api/history`)).json();
    assert.equal(h.enabled, false);
    assert.ok(h.reason);
  } finally {
    app.close();
    await fake.close();
  }
});

test('GET /api/orgs/:org/limits maps /limits (read-only, cached 60 s)', async () => {
  const s = await stack();
  try {
    const a = await (await s.get('/api/orgs/dev/limits')).json();
    assert.deepEqual(a, { api: { max: 15000, remaining: 14200 }, bulkBatches: { max: 15000, remaining: 14980 } });
    await s.get('/api/orgs/dev/limits');
    assert.equal(s.fake.requests.filter((r) => r.path === '/limits').length, 1);
    assert.equal(s.fake.writes().length, 0);
  } finally {
    await s.close();
  }
});

// ---------- delete (design 0011 §7–8) ----------

/** Insert a workflow and return its history id and what the fake org holds. */
async function inserted(s, workflow = accCon(3, 4)) {
  const { events } = await s.insert(workflow);
  const done = events.at(-1);
  assert.equal(done.type, 'done', JSON.stringify(done));
  return done.result.insert.historyId;
}

const confirmOf = async (s, hid, extra = {}) => {
  const one = await (await s.get(`/api/history/${hid}`)).json();
  return { username: one.org.username, count: one.remaining.total, ...extra };
};

test('every refused delete answers the right status and sentence, and the org receives 0 write requests', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const writes = s.fake.writes().length;
    const del = (body) => s.post(`/api/history/${hid}/delete`, body);
    const expectRefused = async (body, status, message) => {
      const r = await del(body);
      assert.equal(r.status, status, JSON.stringify(body));
      const j = await r.json();
      if (message instanceof RegExp) assert.match(j.error, message);
      else assert.equal(j.error, message);
      assert.equal(s.fake.writes().length, writes, `no write for ${JSON.stringify(body)}`);
    };
    const good = await confirmOf(s, hid);
    assert.deepEqual(good, { username: 'me@example.com', count: 15 });

    await expectRefused({}, 400, 'Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.');
    await expectRefused({ confirm: { username: 'me@example.com' } }, 400, 'Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.');
    await expectRefused({ confirm: { ...good, username: 'other@example.com' } }, 409, 'Xác nhận ghi org "other@example.com" nhưng lần insert này thuộc org "me@example.com". Mở lại hộp xác nhận.');
    await expectRefused({ confirm: { ...good, count: 200000 } }, 409, 'Số bản ghi còn phải xóa đã đổi (còn 15, hộp xác nhận ghi 200000). Mở lại hộp xác nhận để xem số mới.');
    await expectRefused({ confirm: good, bulk: 'hard' }, 400, 'bulk phải là "auto" hoặc "off".');

    // The insert is still running (another tab) / another delete of it is running.
    const release = s.history.markActive(hid, 'insert');
    await expectRefused({ confirm: good }, 409, 'Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.');
    release();
    const release2 = s.history.markActive(hid, 'delete');
    await expectRefused({ confirm: good }, 409, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
    release2();

    // The alias now points at another org (refreshed sandbox, re-login).
    s.cli.orgId = '00D000000000002BBB';
    s.fake.identity.orgId = '00D000000000002BBB';
    await expectRefused({ confirm: good }, 409, 'Org "dev" bây giờ là org khác (00D000000000002BBB, me@example.com) so với lúc insert (00D000000000001AAA, me@example.com). Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias dev rồi thử lại.');
    s.cli.orgId = '00D000000000001AAA';
    s.fake.identity.orgId = '00D000000000001AAA';
    s.cli.username = 'me2@example.com';
    s.fake.identity.username = 'me2@example.com';
    await expectRefused({ confirm: good }, 409, /^Org "dev" bây giờ là org khác/);
    s.cli.username = 'me@example.com';
    s.fake.identity.username = 'me@example.com';

    // The org is not logged in any more.
    const getConnection = s.cli.getConnection;
    s.cli.getConnection = async () => { throw new Error('Org "dev" chưa đăng nhập hoặc token hết hạn.'); };
    await expectRefused({ confirm: good }, 502, 'Org "dev" chưa đăng nhập hoặc token hết hạn. Đăng nhập lại: sf org login web --alias dev');
    s.cli.getConnection = getConnection;

    // Unknown / malformed history id.
    const r = await s.post('/api/history/..%2Fx/delete', { confirm: good });
    assert.equal(r.status, 404);
    assert.equal(s.fake.writes().length, writes);
  } finally {
    await s.close();
  }
});

test('production: typedOrg must be the alias or username (case and spaces ignored); unknown kind counts as production', async () => {
  const s = await stack({ cli: { isSandbox: false } });
  try {
    const hid = await inserted(s);
    const writes = s.fake.writes().length;
    const good = await confirmOf(s, hid);
    const msg = 'Org "dev" là production: gõ đúng tên org trong hộp xác nhận để xóa.';
    for (const typedOrg of [undefined, '', 'de', 'prod', 42]) {
      const r = await s.post(`/api/history/${hid}/delete`, { confirm: { ...good, typedOrg } });
      assert.equal(r.status, 400, String(typedOrg));
      assert.equal((await r.json()).error, msg);
    }
    // sf org list failing: kind unknown ⇒ production rules.
    const listOrgs = s.cli.listOrgs;
    s.cli.listOrgs = async () => { throw new Error('sf broke'); };
    assert.equal((await s.post(`/api/history/${hid}/delete`, { confirm: good })).status, 400);
    s.cli.listOrgs = listOrgs;
    assert.equal(s.fake.writes().length, writes);
    const ok = await s.post(`/api/history/${hid}/delete`, { confirm: { ...good, typedOrg: '  DEV ' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).deleted, 15);
  } finally {
    await s.close();
  }
});

test('insert then delete through real jsforce: the Ids deleted are exactly the Ids inserted (Collections and Bulk), never hardDelete; then nothing is left', async () => {
  const s = await stack();
  try {
    // A record created by someone else in the same org must survive.
    const foreign = (await createSfClientFor(s).create('dev', 'Account', [{ Name: 'Not ours' }]))[0].id;
    const hid = await inserted(s, accCon(30, 400)); // 12 030 records, Contact by Bulk
    const ours = new Set(s.fake.alive().filter((id) => id !== foreign));
    assert.equal(ours.size, 12030);
    const before = s.fake.requests.length;
    const { events } = await s.ndjson(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) });
    assert.deepEqual(events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]), ['start', 'progress', 'done']);
    assert.deepEqual([events[0].total, events[0].bySobject], [12030, { Account: 30, Contact: 12000 }]);
    const res = events.at(-1).result;
    assert.deepEqual([res.deleted, res.gone, res.failed, res.remaining], [12030, 0, 0, 0]);
    // Every Id sent for deletion, through DELETE /composite/sobjects or a delete job's CSV.
    const reqs = s.fake.requests.slice(before);
    const sentIds = [];
    for (const r of reqs) {
      if (r.method === 'DELETE') sentIds.push(...r.query.ids.split(','));
      if (r.method === 'PUT') sentIds.push(...r.body.trim().split('\n').slice(1));
    }
    assert.equal(sentIds.length, 12030, 'each Id once');
    assert.deepEqual(new Set(sentIds), ours);
    assert.ok(!sentIds.includes(foreign));
    const opened = reqs.filter((r) => r.method === 'POST' && r.path === '/jobs/ingest');
    assert.ok(opened.length >= 1);
    assert.ok(opened.every((r) => r.body.operation === 'delete'));
    assert.ok(reqs.every((r) => r.method !== 'POST' || r.path === '/jobs/ingest'), 'no create during a delete');
    assert.ok(!JSON.stringify(reqs).includes('hardDelete'));
    // Children before parents: the last Contact Id goes before the first Account Id.
    const firstAccount = reqs.findIndex((r) => r.method === 'DELETE' && r.query.ids.startsWith('001'));
    const lastContact = reqs.findLastIndex((r) => (r.method === 'DELETE' && r.query.ids.startsWith('003')) || r.method === 'PUT');
    assert.ok(firstAccount > lastContact);
    assert.deepEqual(s.fake.alive(), [foreign]);

    const csv = (await (await s.get(`/api/history/${hid}/ids.csv`)).text()).trim().split('\r\n').slice(1);
    assert.ok(csv.every((l) => l.endsWith(',deleted')));
    const list = (await (await s.get('/api/history')).json()).runs[0];
    assert.deepEqual(list.deletion, { status: 'done', deleted: 12030, gone: 0, remaining: 0 });
    const again = await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 0 } });
    assert.deepEqual([again.status, (await again.json()).error], [409, 'Lần insert này không còn bản ghi nào để xóa.']);
  } finally {
    await s.close();
  }
});

test('records deleted by hand meanwhile are "gone", not errors; a second delete only sends what is left', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const [one, two] = s.fake.alive('Contact');
    s.fake.records.get(one).deleted = true;
    s.fake.options.deleteError = (id) => (id === two ? { statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'no access' } : null);
    const r1 = await (await s.post(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) })).json();
    assert.deepEqual([r1.deleted, r1.gone, r1.failed, r1.remaining], [13, 1, 1, 1]);
    assert.deepEqual(r1.errorGroups.map((g) => [g.sobject, g.count, g.message]), [['Contact', 1, 'INSUFFICIENT_ACCESS_OR_READONLY: no access']]);
    s.fake.options.deleteError = null;
    const before = s.fake.requests.length;
    const c = await confirmOf(s, hid);
    assert.equal(c.count, 1);
    const r2 = await (await s.post(`/api/history/${hid}/delete`, { confirm: c })).json();
    assert.deepEqual([r2.deleted, r2.remaining], [1, 0]);
    assert.deepEqual(s.fake.requests.slice(before).filter((r) => r.method === 'DELETE').map((r) => r.query.ids), [two]);
  } finally {
    await s.close();
  }
});

const { createSfClient } = await import('../server/sf/client.js');
function createSfClientFor(s) {
  return createSfClient({ cli: s.cli });
}

test('an interrupted run whose Bulk job results were never read: delete reads them first (read-only), then deletes those Ids too', async () => {
  const s = await stack();
  try {
    const client = createSfClientFor(s);
    const job = client.bulkJob('dev', { object: 'Contact', operation: 'insert' });
    await job.open();
    await job.upload('LastName\nA\nB\nC\n');
    await job.close();
    const hid = await s.history.create({ org: { alias: 'dev', username: 'me@example.com', orgId: '00D000000000001AAA', instanceUrl: s.fake.url, kind: 'sandbox' }, workflow: null, seed: 1, now: 1, steps: [{ nodeId: 'c', alias: 'con', sobject: 'Contact', mode: 'bulk', records: 3 }], total: 3 });
    await s.history.finish(hid, { status: 'interrupted', bulkJobs: [{ jobId: job.id, nodeId: 'c', sobject: 'Contact', records: 3, state: 'UploadComplete', idsCollected: false }] });
    const one = await (await s.get(`/api/history/${hid}`)).json();
    assert.deepEqual([one.remaining.total, one.pendingBulkJobs.map((j) => j.jobId)], [0, [job.id]]);
    // Still running in the org: nothing to delete yet, and nothing is sent.
    const writes = s.fake.writes().length;
    const running = await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 0 } });
    assert.equal(running.status, 409);
    assert.match((await running.json()).error, /^Lần insert này không còn bản ghi nào để xóa\. Job Bulk 7504x\w+ chưa trả Id/);
    s.fake.options.checksBeforeComplete = 0;
    // S2: the Ids are read first; the confirmed count (0) no longer matches ⇒ 409 with the new count, 0 deletes.
    const first = await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 0 } });
    assert.equal(first.status, 409);
    assert.deepEqual(await first.json(), { error: 'Số bản ghi cần xóa đã đổi thành 3 vì vừa lấy được Id từ job Bulk. Xác nhận lại.', count: 3, collected: 3 });
    assert.equal(s.fake.writes().length, writes);
    assert.equal(s.fake.alive().length, 3);
    const data = await s.history.read(hid);
    assert.deepEqual([data.inserted, data.bulkJobs[0].idsCollected], [3, true], 'S4: inserted counts the collected Ids');
    const res = await (await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 3 } })).json();
    assert.deepEqual([res.deleted, res.remaining], [3, 0]);
    assert.deepEqual(s.fake.alive(), []);
  } finally {
    await s.close();
  }
});

// ---------- safety locks (design 0011 §8, step 8) ----------

test('requests from another site get 403 on delete, ids.csv, history and limits; a text/plain delete gets 415; the org sees no write', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const writes = s.fake.writes().length;
    const limitsReads = () => s.fake.requests.filter((r) => r.path === '/limits').length;
    const body = JSON.stringify({ confirm: await confirmOf(s, hid) });
    const foreign = [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const h of foreign) {
      const del = await fetch(`${s.url}/api/history/${hid}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body });
      assert.equal(del.status, 403, JSON.stringify(h));
      for (const p of [`/api/history/${hid}/ids.csv`, `/api/history/${hid}`, '/api/history', '/api/orgs/dev/limits']) {
        const r = await fetch(s.url + p, { headers: h });
        assert.equal(r.status, 403, `${p} ${JSON.stringify(h)}`);
        assert.ok(!(await r.text()).includes(hid.slice(1)), 'no Id or entry leaks');
      }
      const forget = await fetch(`${s.url}/api/history/${hid}/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{}' });
      assert.equal(forget.status, 403);
    }
    // DNS rebinding: a foreign Host header (fetch cannot set Host, so plain http.request).
    for (const [method, p] of [['POST', `/api/history/${hid}/delete`], ['GET', `/api/history/${hid}/ids.csv`], ['GET', '/api/orgs/dev/limits']]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`${s.url}${p}`, { method, headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(method === 'POST' ? body : undefined);
      });
      assert.equal(status, 403, p);
    }
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await fetch(`${s.url}/api/history/${hid}/delete`, { method: 'POST', headers: { 'Content-Type': type }, body });
      assert.equal(r.status, 415, type);
    }
    assert.equal(s.fake.writes().length, writes);
    assert.equal(limitsReads(), 0);
    assert.equal((await s.history.remaining(hid)).total, 15, 'still there');
    // The app itself (same origin) still works.
    const ok = await fetch(`${s.url}/api/history/${hid}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url, 'Sec-Fetch-Site': 'same-origin' }, body });
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

// ---------- review of 0011, B1: nothing but the entry's own Ids can reach a delete ----------

const { writeFile: writeRaw, appendFile: appendRaw } = await import('node:fs/promises');

/** A history entry for `steps` whose ids.csv body is written raw (as an old or tampered file would be). */
async function rawEntry(s, steps, body) {
  const hid = await s.history.create({ org: { alias: 'dev', username: 'me@example.com', orgId: '00D000000000001AAA', instanceUrl: s.fake.url, kind: 'sandbox' }, workflow: null, seed: 1, now: 1, steps, total: 1 });
  await writeRaw(s.history.files(hid)[1], `sobject,step,ref,id\n${body}`);
  await s.history.finish(hid, { status: 'done', inserted: 1 });
  return hid;
}

test('B1: a step id with a line break cannot forge an Id row: the workflow is refused (422) and a crafted file yields no foreign Id', async () => {
  const s = await stack();
  try {
    const foreign = (await createSfClientFor(s).create('dev', 'Account', [{ Name: 'Real customer' }]))[0].id;
    const evil = `q\nAccount,s,r,${foreign}\nz`;
    const writes = s.fake.writes().length;
    const res = await s.post('/api/run', { workflow: wf([record(evil, 'Contact', 'con', [{ name: 'LastName', type: 'text' }])]), target: { kind: 'org', org: 'dev' } });
    assert.equal(res.status, 422);
    const issue = (await res.json()).issues.find((i) => i.nodeId === evil);
    assert.match(issue.message, /^Id bước ".*" không hợp lệ: chỉ dùng chữ không dấu, số, "_" hoặc "-", tối đa 64 ký tự\./);
    assert.equal(s.fake.writes().length, writes);
    // A history file written before the fix (cell quoted across lines): the parser keeps it one cell.
    const contact = (await createSfClientFor(s).create('dev', 'Contact', [{ LastName: 'ours' }]))[0].id;
    const hid = await rawEntry(s, [{ nodeId: evil, alias: 'con', sobject: 'Contact', records: 1 }], `Contact,"${evil}",con#1,${contact}\n`);
    const rem = await s.history.remaining(hid);
    assert.deepEqual(rem.steps.map((x) => x.ids), [[contact]]);
    const before = s.fake.requests.length;
    const out = await (await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 1 } })).json();
    assert.equal(out.deleted, 1);
    const sent = s.fake.requests.slice(before).filter((r) => r.method === 'DELETE').flatMap((r) => r.query.ids.split(','));
    assert.deepEqual(sent, [contact]);
    assert.ok(s.fake.alive().includes(foreign), 'the foreign record is untouched');
  } finally {
    await s.close();
  }
});

test('B1: a corrupted ids.csv (unknown step, wrong sObject, garbage) only yields the rows of the entry\'s own steps', async () => {
  const s = await stack();
  try {
    const [a, b] = (await createSfClientFor(s).create('dev', 'Contact', [{ LastName: 'a' }, { LastName: 'b' }])).map((r) => r.id);
    const foreign = (await createSfClientFor(s).create('dev', 'Account', [{ Name: 'x' }]))[0].id;
    const hid = await rawEntry(s, [{ nodeId: 'c', alias: 'con', sobject: 'Contact', records: 2 }], [
      `Contact,c,con#1,${a}`,
      `Account,c,con#2,${foreign}`, // wrong sObject for step c
      `Account,other,acc#1,${foreign}`, // step not in the entry
      'garbage line without commas',
      `"Contact","c","con#2","${b}"`,
      '',
    ].join('\n'));
    const rem = await s.history.remaining(hid);
    assert.deepEqual([rem.steps[0].ids, rem.rejected], [[a, b], 3]);
    const before = s.fake.requests.length;
    // Review 2, item 3: the rejected rows are shown before and after the delete, with the same count in the list.
    const one = await (await s.get(`/api/history/${hid}`)).json();
    const sentence = '3 dòng trong file Id không thuộc bước nào của lần insert này (file có thể đã bị sửa), không xóa.';
    assert.deepEqual([one.rejected, one.rejectedMessage, one.remaining.total], [3, sentence, 2]);
    const listed = (await (await s.get('/api/history')).json()).runs.find((r) => r.id === hid);
    assert.deepEqual([listed.rejected, listed.deletion.remaining], [3, 2]);
    const out = await (await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 2 } })).json();
    assert.equal(out.deleted, 2);
    assert.deepEqual([out.rejected, out.warnings], [3, [sentence]]);
    assert.ok(!JSON.stringify(s.fake.requests.slice(before)).includes(foreign));
    assert.ok(s.fake.alive().includes(foreign));
  } finally {
    await s.close();
  }
});

test('B1: Ids whose key prefix is not the step sObject\'s (describe) are not sent at all; the step is reported', async () => {
  const s = await stack();
  try {
    const foreign = (await createSfClientFor(s).create('dev', 'Account', [{ Name: 'x' }]))[0].id;
    const ours = (await createSfClientFor(s).create('dev', 'Contact', [{ LastName: 'a' }]))[0].id;
    const hid = await rawEntry(s, [{ nodeId: 'c', alias: 'con', sobject: 'Contact', records: 2 }], `Contact,c,con#1,${ours}\nContact,c,con#2,${foreign}\n`);
    const writes = s.fake.writes().length;
    const out = await (await s.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 2 } })).json();
    assert.equal(s.fake.writes().length, writes, 'nothing of the step is sent, not even the good Id');
    assert.deepEqual([out.deleted, out.remaining], [0, 2]);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /^Không xóa 2 bản ghi Contact của bước "c": Id trong Lịch sử không cùng tiền tố 003 của Contact/);
    assert.deepEqual(s.fake.alive().sort(), [foreign, ours].sort());
  } finally {
    await s.close();
  }
});

// ---------- review of 0011, S1 / S5: identity from the connection that writes ----------

test('S1: the token now belongs to another org although the sf CLI still names the old one ⇒ delete refused, 0 writes', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const writes = s.fake.writes().length;
    s.fake.identity.orgId = '00D000000000009ZZZ'; // the alias was re-pointed; the CLI cache did not notice
    const r = await s.post(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /^sf CLI ghi org 00D000000000001AAA \(me@example.com\) nhưng token thuộc org 00D000000000009ZZZ \(me@example.com\)\. Không xóa gì\./);
    assert.equal(s.fake.writes().length, writes);
    // The re-login is complete (CLI and token agree on the new org): still another org than the insert's.
    s.cli.orgId = '00D000000000009ZZZ';
    const r2 = await s.post(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) });
    assert.equal(r2.status, 409);
    assert.match((await r2.json()).error, /^Org "dev" bây giờ là org khác \(00D000000000009ZZZ/);
    assert.equal(s.fake.writes().length, writes);
  } finally {
    await s.close();
  }
});

test('S1: history keeps the org Id and username Salesforce reports for the writing connection', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const one = await (await s.get(`/api/history/${hid}`)).json();
    assert.deepEqual(one.org, { alias: 'dev', username: 'me@example.com', orgId: '00D000000000001AAA', instanceUrl: s.fake.url, kind: 'sandbox' });
    // Review 2, item 9: the identity URL is parsed, never fetched; the username comes from one SOQL.
    assert.ok(s.fake.requests.some((r) => r.path === '' && r.method === 'GET'), 'REST root read');
    assert.ok(s.fake.requests.some((r) => r.path === '/query' && r.query.q === "SELECT Username FROM User WHERE Id = '005000000000001AAA'"));
    assert.ok(!s.fake.requests.some((r) => r.path.startsWith('/id/') || 'oauth_token' in r.query), 'no identity fetch, no token in a URL');
  } finally {
    await s.close();
  }
});

test('S5: an org whose identity cannot be read ⇒ the insert ends with an error before any write', async () => {
  const s = await stack();
  try {
    s.cli.orgId = '00D000000000007XXX'; // CLI and token disagree
    const { events } = await s.insert(accCon(2, 2));
    const last = events.at(-1);
    assert.equal(last.type, 'error');
    assert.equal(last.insert, null);
    assert.match(last.error, /^Không xác định được org "dev" \(sf CLI ghi org 00D000000000007XXX .*\), nên chưa ghi gì vào org\. Đăng nhập lại: sf org login web --alias dev rồi chạy lại\.$/);
    assert.equal(s.fake.writes().length, 0);
    assert.deepEqual((await (await s.get('/api/history')).json()).runs, []);
  } finally {
    await s.close();
  }
});

test('N4: a Bulk job still running is reported in the delete result; the known Ids are deleted', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const job = createSfClientFor(s).bulkJob('dev', { object: 'Contact', operation: 'insert' });
    await job.open();
    await job.upload('LastName\nA\n');
    await job.close();
    await s.history.update(hid, (d) => ({ bulkJobs: [{ jobId: job.id, nodeId: 'c', sobject: 'Contact', records: 1, state: 'UploadComplete', idsCollected: false }] }));
    s.fake.options.checksBeforeComplete = 100;
    const res = await (await s.post(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) })).json();
    assert.equal(res.deleted, 15);
    assert.deepEqual(res.pendingBulkJobs, [{ jobId: job.id, sobject: 'Contact', state: 'InProgress', reason: 'running' }]);
  } finally {
    await s.close();
  }
});

test('N11: an entry that vanishes during a delete stops it with a 404 sentence; its files are not recreated', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s, accCon(3, 100)); // 303 records ⇒ more than one destroy call
    const { unlinkSync, existsSync } = await import('node:fs');
    let first = true;
    s.fake.options.deleteError = () => {
      if (first) {
        first = false;
        for (const f of s.history.files(hid)) if (existsSync(f)) unlinkSync(f);
      }
      return null;
    };
    const r = await s.post(`/api/history/${hid}/delete`, { confirm: await confirmOf(s, hid) });
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /^Lần insert này không còn trong Lịch sử \(đã bị quên hoặc bị xóa khỏi thư mục trong lúc xóa\), nên đã dừng xóa\. Bản ghi chưa xóa vẫn còn trong org\. Đã xóa 200 bản ghi trước khi dừng\.$/);
    assert.equal(s.fake.requests.filter((x) => x.method === 'DELETE').length, 1, 'stopped after the call in flight');
    assert.ok(s.history.files(hid).every((f) => !existsSync(f)));
  } finally {
    await s.close();
  }
});

test('N10: ids.csv prefixes cells a spreadsheet would run as a formula', async () => {
  const s = await stack();
  try {
    const w = wf([record('-cmd', 'Account', 'acc', [{ name: 'Name', type: 'text' }])]);
    const { events } = await s.insert(w);
    const hid = events.at(-1).result.insert.historyId;
    const lines = (await (await s.get(`/api/history/${hid}/ids.csv`)).text()).trim().split('\r\n');
    assert.match(lines[1], /^Account,001\w+,acc#1,'-cmd,inserted$/);
  } finally {
    await s.close();
  }
});

// ---------- review 2 of 0011, item 1: the writing connection is pinned for the whole run ----------

/** Two fake orgs behind one alias; `point(B)` re-points the alias (CLI) like a re-login. */
async function twoOrgs() {
  const A = await startFakeSalesforce();
  const B = await startFakeSalesforce({ identity: { orgId: '00D000000000002BBB' } });
  let cur = A;
  const cli = {
    async listOrgs() {
      return [{ alias: 'dev', username: 'me@example.com', instanceUrl: cur.url, isSandbox: true }];
    },
    async getConnection() {
      return { accessToken: cur === A ? 'tokA' : 'tokB', instanceUrl: cur.url, apiVersion: '62.0', username: 'me@example.com', orgId: cur.identity.orgId };
    },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfdg-orgwrites-'));
  dirs.push(dir);
  const history = createHistory({ dir });
  const app = http.createServer(createApp({ cli, history, runOptions: { progressIntervalMs: 0 } }));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  return {
    A, B, history, post,
    point: (fake) => { cur = fake; },
    close: async () => { app.close(); await A.close(); await B.close(); },
  };
}

test('item 1: the alias re-pointed between two batches of an insert: the rest still goes to the org whoami checked, org B gets nothing', async () => {
  const t = await twoOrgs();
  try {
    let first = true;
    t.A.options.createError = () => { if (first) { first = false; t.point(t.B); } return null; };
    const res = await t.post('/api/run', { workflow: accCon(3, 100), seed: 1, target: { kind: 'org', org: 'dev', bulk: 'off' } });
    assert.equal(res.insert.inserted, 303);
    assert.equal(t.A.alive().length, 303);
    assert.equal(t.B.requests.length, 0, 'not a single request to org B');
  } finally {
    await t.close();
  }
});

test('item 1: a refresh that lands on org B is refused: the insert stops with orgChanged, org B gets nothing', async () => {
  const t = await twoOrgs();
  try {
    let first = true;
    t.A.options.createError = () => {
      if (first) {
        first = false;
        t.point(t.B);
        t.A.options.expireOnce = new Set(['POST /composite/sobjects']); // A's token expires now
      }
      return null;
    };
    const res = await t.post('/api/run', { workflow: accCon(3, 100), seed: 1, target: { kind: 'org', org: 'dev', bulk: 'off' } });
    assert.equal(res.insert.stopped.reason, 'orgChanged');
    assert.match(res.insert.stopped.message, /^Org "dev" bây giờ là org khác \(00D000000000002BBB, me@example.com\) so với kết nối đang dùng \(00D000000000001AAA, me@example.com\)\. Không gửi tiếp\./);
    assert.equal(res.insert.inserted, t.A.alive().length);
    assert.equal(res.insert.inserted + res.insert.failed + res.insert.notSent, 303);
    assert.equal(t.B.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('item 1: a delete whose alias moves to org B mid-run: no request to B and no "gone" row; with a refused refresh it stops (orgChanged)', async () => {
  const t = await twoOrgs();
  try {
    const ins = await t.post('/api/run', { workflow: accCon(3, 100), seed: 1, target: { kind: 'org', org: 'dev', bulk: 'off' } });
    const hid = ins.insert.historyId;
    let first = true;
    t.A.options.deleteError = () => {
      if (first) {
        first = false;
        t.point(t.B);
        t.A.options.expireOnce = new Set(['DELETE /composite/sobjects']);
      }
      return null;
    };
    const res = await t.post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 303 } });
    assert.equal(res.stopped.reason, 'orgChanged');
    assert.deepEqual([res.deleted, res.gone, res.remaining], [200, 0, 103]);
    assert.equal(t.B.requests.length, 0);
    const outcomes = [...(await t.history.deletedMap(hid)).values()];
    assert.deepEqual([outcomes.length, outcomes.every((o) => o === 'deleted')], [200, true]);
    assert.equal(t.A.alive().length, 103);
  } finally {
    await t.close();
  }
});

test('item 10: with history off (another live server holds the lock) delete and forget answer 503 and the org sees no write', async () => {
  const s = await stack();
  try {
    const hid = await inserted(s);
    const writes = s.fake.writes().length;
    // A second server on the same directory: the lock belongs to another live process.
    await writeRaw(path.join(s.dir, 'history', '.lock'), String(process.ppid));
    const app = http.createServer(createApp({ cli: s.cli, history: createHistory({ dir: s.dir }) }));
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${app.address().port}`;
      const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const del = await post(`/api/history/${hid}/delete`, { confirm: { username: 'me@example.com', count: 15 } });
      assert.equal(del.status, 503);
      assert.match((await del.json()).error, /^Không ghi được Lịch sử \(Một server sf-data-generator khác \(pid \d+\) đang dùng thư mục Lịch sử .*\), nên không xóa được\./);
      const forget = await post(`/api/history/${hid}/forget`, {});
      assert.equal(forget.status, 503);
      assert.match((await forget.json()).error, /nên không quên lần insert này được\./);
      const run = await post('/api/run', { workflow: accCon(1, 1), seed: 1, target: { kind: 'org', org: 'dev' } });
      assert.equal(run.status, 503);
    } finally {
      app.close();
    }
    assert.equal(s.fake.writes().length, writes);
    assert.equal((await s.history.remaining(hid)).total, 15, 'still listed, nothing forgotten');
  } finally {
    await s.close();
  }
});
