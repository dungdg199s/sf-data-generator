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

export async function stack({ fake: fakeOpts = {}, cli: cliOpts = {} } = {}) {
  const fake = await startFakeSalesforce(fakeOpts);
  const cli = fakeCli(fake, cliOpts);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfdg-orgwrites-'));
  dirs.push(dir);
  const history = createHistory({ dir });
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
    assert.equal((await readdir(path.join(s.dir, 'history'))).length, 2);
    const f = await s.post(`/api/history/${hid}/forget`, {});
    assert.deepEqual([f.status, await f.json()], [200, { ok: true }]);
    assert.deepEqual(await readdir(path.join(s.dir, 'history')), []);
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
    const res = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ workflow: accCon(2, 2), seed: 1, target: { kind: 'org', org: 'dev' } }) });
    const last = JSON.parse((await res.text()).trim().split('\n').at(-1));
    assert.equal(last.type, 'error');
    assert.equal(last.insert, null);
    assert.match(last.error, /^Không ghi được Lịch sử \(.*\), nên chưa ghi gì vào org\. Kiểm tra quyền ghi thư mục .* hoặc đặt SFDG_DATA_DIR\.$/);
    assert.equal(fake.writes().length, 0);
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
