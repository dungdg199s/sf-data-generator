// server/history.js (design 0011): files of the insert history in a temporary SFDG_DATA_DIR.
import { TEST_DATA_DIR } from './data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync, symlinkSync, mkdirSync, chownSync, rmSync } from 'node:fs';
import { createHistory, dataDir } from '../server/history.js';
import { createApp } from '../server/index.js';
import { wf, record, query, pick, loop } from './helpers.js';

let n = 0;
const freshDir = () => mkdtempSync(path.join(TEST_DATA_DIR, `h${++n}-`));
const org = { alias: 'dev', username: 'me@x.com', orgId: '00D000000000001AAA', instanceUrl: 'https://x', kind: 'sandbox', accessToken: 'SECRET-TOKEN-123' };
const steps = [{ nodeId: 'a', alias: 'acc', sobject: 'Account', mode: 'collections', records: 2 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', mode: 'collections', records: 3 }];

async function insertRun(h, { ids = 5, clockAt } = {}) {
  const e = await h.create({ org, workflow: wf([]), seed: 1, now: 2, bulk: 'auto', steps, total: 5 });
  const rows = [];
  for (let i = 0; i < ids; i++) rows.push(i < 2 ? { sobject: 'Account', step: 'a', ref: `acc#${i + 1}`, id: `001${i}` } : { sobject: 'Contact', step: 'c', ref: '', id: `003${i}` });
  await e.appendIds(rows);
  await e.finish({ status: 'done', inserted: ids });
  return e;
}

test('dataDir: SFDG_DATA_DIR, then per OS; refused under node --test without it', () => {
  assert.equal(dataDir({ env: { SFDG_DATA_DIR: '/tmp/x' } }), '/tmp/x');
  assert.equal(dataDir({ env: {}, platform: 'linux', home: '/home/me' }), '/home/me/.local/share/sf-data-generator');
  assert.equal(dataDir({ env: { XDG_DATA_HOME: '/d' }, platform: 'linux', home: '/home/me' }), '/d/sf-data-generator');
  assert.equal(dataDir({ env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/Library/Application Support/sf-data-generator');
  assert.equal(dataDir({ env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\me' }), path.join('C:\\Users\\me\\AppData\\Roaming', 'sf-data-generator'));
  assert.throws(() => dataDir({ env: { NODE_TEST_CONTEXT: 'child' } }), /SFDG_DATA_DIR/);
});

test('create, append, finish; remaining in delete order; ids.csv rows; 0700 / 0600; no credential stored', async () => {
  const h = createHistory({ dir: path.join(freshDir(), 'history') });
  const e = await insertRun(h);
  assert.match(e.id, /^h\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  const run = await h.read(e.id);
  assert.deepEqual([run.status, run.inserted, run.org.username, run.org.accessToken], ['done', 5, 'me@x.com', undefined]);
  const rem = await h.remaining(e.id, { withIds: true });
  assert.deepEqual(rem.bySteps, [{ nodeId: 'c', sobject: 'Contact', count: 3 }, { nodeId: 'a', sobject: 'Account', count: 2 }]);
  assert.deepEqual(rem.ids.get('c'), ['0034', '0033', '0032'], 'reverse insert order');
  const h2 = await h.open(e.id);
  await h2.appendDeleted([{ id: '0034', outcome: 'deleted' }, { id: '0033', outcome: 'gone' }]);
  assert.equal((await h.remaining(e.id)).total, 3);
  let csv = '';
  for await (const c of h.idRows(e.id)) csv += c;
  assert.equal(csv, 'sobject,id,ref,step,status\r\nAccount,0010,acc#1,a,inserted\r\nAccount,0011,acc#2,a,inserted\r\nContact,0032,,c,inserted\r\nContact,0033,,c,gone\r\nContact,0034,,c,deleted\r\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(h.dir).mode & 0o777, 0o700);
    for (const f of readdirSync(h.dir)) assert.equal(statSync(path.join(h.dir, f)).mode & 0o777, 0o600, f); // .lock included
  }
  for (const f of readdirSync(h.dir)) assert.ok(!readFileSync(path.join(h.dir, f), 'utf8').includes('SECRET-TOKEN-123'), f);
});

test('hid is checked: ../x and malformed ids never reach the file system', async () => {
  const h = createHistory({ dir: path.join(freshDir(), 'history') });
  assert.equal(h.isValidId('../x'), false);
  assert.equal(await h.read('../x'), null);
  assert.equal(await h.open('h20261028T103200Z-a1b2c3/../../x'), null);
  assert.equal(await h.remaining('../../etc/passwd'), null);
});

test('a run still "running" when the server stops is "interrupted" on the next start, with the Ids written', async () => {
  const dir = path.join(freshDir(), 'history');
  const h = createHistory({ dir });
  const e = await h.create({ org, workflow: wf([]), seed: 1, now: 2, bulk: 'auto', steps, total: 5 });
  await e.appendIds([{ sobject: 'Account', step: 'a', ref: 'acc#1', id: '0010' }]);
  await e.appendIds([{ sobject: 'Contact', step: 'c', ref: '', id: '0030' }, { sobject: 'Contact', step: 'c', ref: '', id: '0031' }]);
  const again = createHistory({ dir });
  const run = await again.read(e.id);
  assert.deepEqual([run.status, run.inserted], ['interrupted', 3]);
  // Review nit: the per-step counts are recounted from the Ids file too.
  assert.deepEqual(run.steps.map((st) => [st.nodeId, st.inserted]), [['a', 1], ['c', 2]]);
});

// Review S4: only runs with nothing left in the org are pruned; a run with records (or with an
// unread Bulk job) is never forgotten silently — the next insert is refused instead.
test('pruning: only emptied runs go; when only runs with records are left the insert is refused (HISTORY_FULL)', async () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const h = createHistory({ dir: path.join(freshDir(), 'history'), maxRuns: 3, clock: () => (t += 60000) });
  const running = await h.create({ org, workflow: wf([]), seed: 1, now: 2, bulk: 'auto', steps, total: 5 });
  const old = await insertRun(h);
  const emptied = await insertRun(h);
  const em = await h.open(emptied.id);
  await em.save({ deletion: { status: 'done', deleted: 5, gone: 0 } });
  assert.equal((await h.status()).full, false, 'the emptied run can make room');
  await insertRun(h); // 4th: the emptied one goes (not the older one with records, not the running one)
  const ids = (await h.list()).map((r) => r.id);
  assert.ok(!ids.includes(emptied.id));
  assert.ok(ids.includes(old.id) && ids.includes(running.id));
  const status = await h.status();
  assert.equal(status.full, true);
  await assert.rejects(insertRun(h), (e) => e.code === 'HISTORY_FULL' && /^Lịch sử đã đủ 3 lần insert còn bản ghi trong org/.test(e.message));
  assert.equal((await h.list()).length, 3, 'nothing was forgotten');
  // A run whose records were deleted but that still has an unread Bulk job keeps its place.
  const o = await h.open(old.id);
  await o.save({ deletion: { status: 'done', deleted: 5, gone: 0 }, bulkJobs: [{ jobId: '7504x1', idsCollected: false }] });
  await assert.rejects(insertRun(h), (e) => e.code === 'HISTORY_FULL');
  await o.save({ bulkJobs: [{ jobId: '7504x1', idsCollected: false, neverProcessed: true }] });
  await insertRun(h);
  assert.ok(!(await h.list()).some((r) => r.id === old.id), 'emptied for good: pruned');
});

test('a directory that cannot be written turns the history off (create refuses)', async () => {
  const base = freshDir();
  writeFileSync(path.join(base, 'file'), 'x');
  const h = createHistory({ dir: path.join(base, 'file', 'history') });
  await h.ready;
  assert.equal(h.enabled, false);
  assert.match(h.reason, /ENOTDIR|EEXIST|ENOENT/);
  await assert.rejects(h.create({ org, workflow: null, seed: 1, now: 2, bulk: 'auto', steps, total: 5 }));
});

test('scan: after an insert through the app no file holds a token, an Authorization header or a Query row', async () => {
  const dir = path.join(freshDir(), 'history');
  const history = createHistory({ dir });
  let k = 0;
  const cli = {
    listOrgs: async () => [{ alias: 'dev', username: 'me@x.com', isSandbox: true }],
    getConnection: async () => ({ accessToken: 'SECRET-TOKEN-123', instanceUrl: 'https://x', username: 'me@x.com', orgId: '00D000000000001AAA', refreshToken: 'SECRET-TOKEN-123' }),
  };
  const client = {
    identity: async (o) => o,
    query: async () => ({ records: [{ Id: '001000000000777AAA', Name: 'Row-From-The-Org-XYZ' }], totalSize: 1, done: true }),
    create: async (_t, _s, recs) => recs.map(() => ({ success: true, id: `003${String(++k).padStart(15, '0')}` })),
  };
  const server = http.createServer(createApp({ cli, client, history }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const w = wf([query('q', 'accs'), loop('l', { count: 3 }, [pick('p', 'acc', 'accs'), record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: {} }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])])]);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer SECRET-TOKEN-123' }, body: JSON.stringify({ workflow: w, seed: 1, target: { kind: 'org', org: 'dev' } }) });
    const body = await res.json();
    assert.equal(body.insert.inserted, 3);
    assert.match(body.insert.historyId, /^h\d{8}T/);
    const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
    assert.equal(files.length, 2, 'json + ids.csv (+ the .lock of this process)');
    for (const f of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      for (const bad of ['SECRET-TOKEN-123', 'accessToken', 'refreshToken', 'Authorization', 'Row-From-The-Org-XYZ']) assert.ok(!text.includes(bad), `${f} contains ${bad}`);
    }
    const run = JSON.parse(readFileSync(path.join(dir, files.find((f) => f.endsWith('.json'))), 'utf8'));
    assert.deepEqual(run.org, { alias: 'dev', username: 'me@x.com', orgId: '00D000000000001AAA', instanceUrl: 'https://x', kind: 'sandbox' });
  } finally {
    server.close();
  }
});

// ---------- 0011 "Sửa sau review" ----------

test('review nit: one server per history directory (.lock with the pid); a stale lock is taken over', async () => {
  const dir = path.join(freshDir(), 'history');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, '.lock'), String(process.ppid), { mode: 0o600 }); // a live process: the test runner
  const h = createHistory({ dir });
  await h.ready;
  assert.equal(h.enabled, false);
  assert.match(h.reason, new RegExp(`đang được một server khác dùng \\(pid ${process.ppid}\\)`));
  let dead = 4194000;
  for (; dead > 1000; dead--) { try { process.kill(dead, 0); } catch (e) { if (e.code === 'ESRCH') break; } }
  writeFileSync(path.join(dir, '.lock'), String(dead));
  const h2 = createHistory({ dir });
  await h2.ready;
  assert.equal(h2.enabled, true);
  assert.equal(readFileSync(path.join(dir, '.lock'), 'utf8'), String(process.pid));
});

test('review nit: a symlinked history directory or file is never used; files of another user neither', async () => {
  const base = freshDir();
  const real = path.join(base, 'elsewhere');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, path.join(base, 'history'));
  const h = createHistory({ dir: path.join(base, 'history') });
  await h.ready;
  assert.equal(h.enabled, false);
  assert.match(h.reason, /là symlink/);

  const ok = createHistory({ dir: path.join(freshDir(), 'history') });
  const e = await insertRun(ok);
  const outside = path.join(freshDir(), 'secret.csv');
  writeFileSync(outside, 'sobject,step,ref,id\nAccount,a,,001OUTSIDE\n');
  rmSync(path.join(ok.dir, `${e.id}.ids.csv`));
  symlinkSync(outside, path.join(ok.dir, `${e.id}.ids.csv`));
  await assert.rejects(ok.remaining(e.id), /là symlink/);
  const h2 = await ok.open(e.id);
  await assert.rejects(h2.appendIds([{ sobject: 'Account', step: 'a', ref: '', id: '001X' }]), /là symlink/);
  assert.ok(!readFileSync(outside, 'utf8').includes('001X'), 'nothing written through the link');
  if (process.getuid?.() === 0) {
    const e2 = await insertRun(ok);
    chownSync(path.join(ok.dir, `${e2.id}.ids.csv`), 65534, 65534);
    await assert.rejects(ok.remaining(e2.id), /thuộc user khác/);
  }
});
