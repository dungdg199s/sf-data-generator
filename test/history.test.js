// server/history.js (design 0011 §5): insert history files in a temporary directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistory, defaultDataDir, isValidHid, orgIdentity } from '../server/history.js';
import { wf, record, query } from './helpers.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'sfdg-history-'));
const ORG = { alias: 'dev', username: 'me@example.com', orgId: '00D000000000001AAA', instanceUrl: 'https://acme.my.salesforce.com', kind: 'sandbox' };
let seq = 0;
const hex = () => (++seq).toString(16).padStart(6, '0');

test('create → append Ids → finish; remaining groups Ids by step in insert order; list is newest first', async () => {
  const dir = await tmp();
  let t = Date.parse('2026-10-28T10:32:00Z');
  const h = createHistory({ dir, clock: () => t, random: hex });
  const hid = await h.create({ org: ORG, workflow: wf([record('a', 'Account', 'acc')], { name: 'Acc' }), seed: 42, now: 1, steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 3 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 2 }], total: 5 });
  assert.ok(isValidHid(hid));
  assert.match(hid, /^h20261028T103200Z-[0-9a-f]{6}$/);
  await Promise.all([
    h.appendIds(hid, [{ sobject: 'Account', nodeId: 'a', ref: 'acc#1', id: '001A' }, { sobject: 'Account', nodeId: 'a', ref: 'acc#2', id: '001B' }]),
    h.appendIds(hid, [{ sobject: 'Contact', nodeId: 'c', ref: '', id: '003A' }, { sobject: 'Contact', nodeId: 'c', ref: 'x,"y"', id: '003B' }]),
  ]);
  assert.equal((await h.list())[0].inserted, 4, 'live count while running');
  await h.finish(hid, { status: 'done', inserted: 4, failed: 1 });
  const rem = await h.remaining(hid);
  assert.deepEqual(rem.steps.map((s) => [s.nodeId, s.ids]), [['a', ['001A', '001B']], ['c', ['003A', '003B']]]);
  assert.deepEqual([rem.total, rem.bySobject], [4, { Account: 2, Contact: 2 }]);
  const refs = [];
  for await (const r of h.ids(hid)) refs.push(r.ref);
  assert.deepEqual(refs, ['acc#1', 'acc#2', '', 'x,"y"']);
  await h.appendDeleted(hid, [{ id: '003B', outcome: 'deleted' }, { id: '003A', outcome: 'gone' }]);
  assert.deepEqual((await h.remaining(hid)).total, 2);
  t += 60000;
  const hid2 = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  const list = await h.list();
  assert.deepEqual(list.map((e) => e.id), [hid2, hid]);
  assert.equal(list[1].status, 'done');
  assert.equal(list[1].workflowName, 'Acc');
});

test('running entries become interrupted on the next start, with the Ids counted from the file', async () => {
  const dir = await tmp();
  const h = createHistory({ dir, random: hex });
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 10 });
  await h.appendIds(hid, [{ sobject: 'Account', nodeId: 'a', ref: 'acc#1', id: '001A' }]);
  const again = createHistory({ dir, random: hex });
  const data = await again.read(hid);
  assert.equal(data.status, 'interrupted');
  assert.equal(data.inserted, 1);
});

test('pruning removes fully deleted entries first, then the oldest; never a running one', async () => {
  const dir = await tmp();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const h = createHistory({ dir, clock: () => (t += 1000), random: hex, maxRuns: 3 });
  const mk = async (n) => {
    const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [{ nodeId: 'a', sobject: 'Account', records: n }], total: n });
    await h.appendIds(hid, Array.from({ length: n }, (_, i) => ({ sobject: 'Account', nodeId: 'a', ref: `acc#${i}`, id: `001${hid.slice(-6)}${i}` })));
    return hid;
  };
  const running = await mk(1); // stays running
  const old = await mk(1);
  await h.finish(old, { status: 'done', inserted: 1 });
  const deleted = await mk(1);
  await h.finish(deleted, { status: 'done', inserted: 1, deletion: { status: 'done', deleted: 1, gone: 0, lastAt: null, errorGroups: [] } });
  const fourth = await mk(1);
  let ids = (await h.list()).map((e) => e.id);
  assert.ok(!ids.includes(deleted), 'the fully deleted one went first although it is newer');
  assert.deepEqual(ids.sort(), [running, old, fourth].sort());
  await h.finish(fourth, { status: 'done', inserted: 1 });
  await mk(1);
  ids = (await h.list()).map((e) => e.id);
  assert.ok(ids.includes(running), 'never prunes a running entry');
  assert.ok(!ids.includes(old), 'then the oldest with records');
  assert.equal(ids.length, 3);
});

test('hid is checked: traversal and malformed ids read as missing; files are 0600, the directory 0700', async () => {
  const dir = await tmp();
  const h = createHistory({ dir, random: hex });
  for (const bad of ['../x', '..%2Fx', 'h20261028T103200Z-a1b2c3/../../etc', 'h20261028T103200Z-A1B2C3', '', null]) {
    assert.equal(await h.read(bad), null, String(bad));
    assert.equal(isValidHid(bad), false);
  }
  await assert.rejects(h.update('../x', {}), (e) => e.status === 404);
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  await h.appendDeleted(hid, [{ id: '001A', outcome: 'deleted' }]);
  if (process.platform !== 'win32') {
    for (const f of h.files(hid)) assert.equal((await stat(f)).mode & 0o777, 0o600, f);
    assert.equal((await stat(path.join(dir, 'history'))).mode & 0o777, 0o700);
  }
});

test('no credential and no Query row ever reaches the history directory', async () => {
  const dir = await tmp();
  const h = createHistory({ dir, random: hex });
  const workflow = wf([query('q', 'accs', { soql: 'SELECT Id FROM Account' }), record('a', 'Account', 'acc')]);
  const hid = await h.create({
    org: { ...ORG, accessToken: 'SECRET-TOKEN-123', Authorization: 'Bearer SECRET-TOKEN-123', refreshToken: 'SECRET-TOKEN-123' },
    workflow: { ...workflow, queryResults: { q: { records: [{ Id: '001REALROW', Name: 'Real Customer Ltd' }] } } },
    seed: 1, now: 1, steps: [], total: 0,
  });
  await h.appendIds(hid, [{ sobject: 'Account', nodeId: 'a', ref: 'acc#1', id: '001A' }]);
  await h.finish(hid, { status: 'done' });
  for (const f of await readdir(path.join(dir, 'history'))) {
    const text = await readFile(path.join(dir, 'history', f), 'utf8');
    for (const secret of ['SECRET-TOKEN-123', 'accessToken', 'Authorization', 'refreshToken', 'Real Customer Ltd', '001REALROW']) {
      assert.ok(!text.includes(secret), `${f} contains ${secret}`);
    }
  }
  assert.deepEqual(orgIdentity({ ...ORG, accessToken: 'x' }), ORG);
});

test('a directory that cannot be written turns history off; create throws so no insert starts', async () => {
  const dir = await tmp();
  const blocker = path.join(dir, 'file');
  await writeFile(blocker, '');
  const h = createHistory({ dir: path.join(blocker, 'sub'), random: hex });
  const s = await h.status();
  assert.equal(s.enabled, false);
  assert.match(s.reason, /ENOTDIR|EEXIST/);
  await assert.rejects(h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 }), /ENOTDIR|EEXIST/);
  assert.deepEqual(await h.list(), []);
});

test('data directory: SFDG_DATA_DIR, else XDG / macOS / Windows defaults', () => {
  assert.equal(defaultDataDir({ SFDG_DATA_DIR: '/data/x' }, 'linux', '/home/me'), path.resolve('/data/x'));
  assert.equal(defaultDataDir({}, 'linux', '/home/me'), path.join('/home/me', '.local', 'share', 'sf-data-generator'));
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/me'), path.join('/xdg', 'sf-data-generator'));
  assert.equal(defaultDataDir({}, 'darwin', '/Users/me'), path.join('/Users/me', 'Library', 'Application Support', 'sf-data-generator'));
  assert.equal(defaultDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'), path.join('C:\\Users\\me\\AppData\\Roaming', 'sf-data-generator'));
});

test('B1: a cell with a line break is never written (the append rejects, the file keeps its rows)', async () => {
  const dir = await tmp();
  const h = createHistory({ dir, random: hex });
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [{ nodeId: 'c', sobject: 'Contact' }], total: 1 });
  await assert.rejects(h.appendIds(hid, [{ sobject: 'Contact', nodeId: 'q\nAccount,s,r,001FOREIGN000000AAA\nz', ref: 'c#1', id: '003000000000001AAA' }]), /xuống dòng/);
  await assert.rejects(h.appendIds(hid, [{ sobject: 'Contact', nodeId: 'c', ref: 'c#1\r', id: '003000000000001AAA' }]), /xuống dòng/);
  assert.equal(await readFile(h.files(hid)[1], 'utf8'), 'sobject,step,ref,id\n');
});

test('S4: pruning never removes an entry with records in an org while one with none is left (collected Bulk Ids count); prunePreview names it', async () => {
  const dir = await tmp();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const h = createHistory({ dir, clock: () => (t += 1000), random: hex, maxRuns: 2 });
  const withRecords = await h.create({ org: ORG, workflow: { name: 'W1', steps: [] }, seed: 1, now: 1, steps: [], total: 1 });
  // Finished with 0 known Ids but a Bulk job whose Ids were collected later (inserted raised to 5).
  await h.finish(withRecords, { status: 'interrupted', inserted: 0, bulkJobs: [{ jobId: 'J1', records: 5, idsCollected: false }] });
  const empty = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  await h.finish(empty, { status: 'done', inserted: 0 });
  assert.deepEqual(await h.prunePreview(), [], 'the empty newer entry goes first');
  await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  const ids = (await h.list()).map((e) => e.id);
  assert.ok(ids.includes(withRecords));
  assert.ok(!ids.includes(empty));
  await h.update(withRecords, { inserted: 5, bulkJobs: [{ jobId: 'J1', records: 5, idsCollected: true }] });
  const doomed = await h.prunePreview();
  assert.deepEqual(doomed.map((e) => [e.id, e.remaining, e.workflowName]), [[withRecords, 5, 'W1']]);
});

test('N1: forget refuses an entry in use; N5: crash leftovers are cleaned, an empty .json is listed as corrupt', async () => {
  const dir = await tmp();
  const h = createHistory({ dir, random: hex });
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  const release = h.markActive(hid, 'delete');
  await assert.rejects(h.forget(hid), (e) => e.status === 409 && /đang được dùng/.test(e.message));
  release();
  assert.equal(await h.forget(hid), true);
  const root = path.join(dir, 'history');
  await writeFile(path.join(root, 'h20260101T000000Z-aaaaaa.json.tmp-123456'), '{');
  await writeFile(path.join(root, 'h20260101T000000Z-bbbbbb.ids.csv'), 'sobject,step,ref,id\n');
  await writeFile(path.join(root, 'h20260101T000000Z-cccccc.json'), '');
  const again = createHistory({ dir, random: hex });
  const list = await again.list();
  assert.deepEqual(list.map((e) => [e.id, e.status]), [['h20260101T000000Z-cccccc', 'corrupt']]);
  assert.ok(list[0].error.startsWith(`File ${path.join(root, 'h20260101T000000Z-cccccc.json')} rỗng`), list[0].error);
  assert.equal(list[0].hasIds, false);
  const left = (await readdir(root)).filter((f) => !f.startsWith('.')).sort();
  assert.deepEqual(left, ['h20260101T000000Z-cccccc.json']);
});

test('N6: a history directory locked by another live process is off, with a sentence naming it; a stale lock is taken over', async () => {
  const dir = await tmp();
  const root = path.join(dir, 'history');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, '.lock'), String(process.ppid)); // the test runner: alive, not us
  const h = createHistory({ dir, random: hex });
  const s = await h.status();
  assert.equal(s.enabled, false);
  assert.equal(s.reason, `Một server sf-data-generator khác (pid ${process.ppid}) đang dùng thư mục Lịch sử ${root}. Dừng server đó, hoặc đặt SFDG_DATA_DIR khác cho server này. Nếu không còn server nào khác, xóa file ${path.join(root, '.lock')}`);
  await assert.rejects(h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 }), /đang dùng thư mục Lịch sử/);
  await writeFile(path.join(root, '.lock'), '999999999'); // no such process
  const h2 = createHistory({ dir, random: hex });
  assert.equal((await h2.status()).enabled, true);
  assert.equal(await readFile(path.join(root, '.lock'), 'utf8'), String(process.pid));
});

test('item 2: a numeric nodeId still matches its rows (keys are String(nodeId))', async () => {
  const h = createHistory({ dir: await tmp(), random: hex });
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [{ nodeId: 5, alias: 'acc', sobject: 'Account', records: 1 }], total: 1 });
  await h.appendIds(hid, [{ sobject: 'Account', nodeId: 5, ref: 'acc#1', id: '001000000000001AAA' }]);
  const rem = await h.remaining(hid);
  assert.deepEqual([rem.total, rem.rejected, rem.steps[0].nodeId], [1, 0, '5']);
});

test('item 4: an empty lock younger than 5 s is held (a server is writing it); an old empty one is taken over', async () => {
  const { mkdir, utimes } = await import('node:fs/promises');
  const dir = await tmp();
  const root = path.join(dir, 'history');
  await mkdir(root, { recursive: true });
  const lock = path.join(root, '.lock');
  await writeFile(lock, '');
  const h = createHistory({ dir, random: hex });
  const st = await h.status();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /^Một server sf-data-generator khác \(pid không rõ\) đang dùng thư mục Lịch sử .*Nếu không còn server nào khác, xóa file .*\.lock$/);
  assert.equal(await readFile(lock, 'utf8'), '', 'the lock was not touched');
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  const h2 = createHistory({ dir, random: hex });
  assert.equal((await h2.status()).enabled, true);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  assert.deepEqual((await readdir(root)).filter((f) => f.startsWith('.lock.')), [], 'no temporary lock file left');
});

test('item 4: a lock whose pid now belongs to another live program is still held (safe side) and the sentence says how to remove it', async () => {
  const { mkdir } = await import('node:fs/promises');
  const dir = await tmp();
  const root = path.join(dir, 'history');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, '.lock'), String(process.ppid)); // reused pid: alive, not a server of ours
  const st = await createHistory({ dir, random: hex }).status();
  assert.equal(st.enabled, false);
  assert.ok(st.reason.endsWith(`Nếu không còn server nào khác, xóa file ${path.join(root, '.lock')}`));
});

test('item 4: two histories racing for one directory in this process share the lock; the file always holds a pid', async () => {
  const dir = await tmp();
  const [a, b] = [createHistory({ dir, random: hex }), createHistory({ dir, random: hex })];
  const [sa, sb] = await Promise.all([a.status(), b.status()]);
  assert.deepEqual([sa.enabled, sb.enabled], [true, true]);
  assert.equal(await readFile(path.join(dir, 'history', '.lock'), 'utf8'), String(process.pid));
});

test('item 5: an orphan Id file with Ids is kept and listed as corrupt; one with only the header is removed', async () => {
  const { mkdir } = await import('node:fs/promises');
  const dir = await tmp();
  const root = path.join(dir, 'history');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'h20260101T000000Z-aaaaaa.ids.csv'), 'sobject,step,ref,id\nAccount,a,acc#1,001000000000001AAA\n');
  await writeFile(path.join(root, 'h20260101T000000Z-bbbbbb.ids.csv'), 'sobject,step,ref,id\n');
  const h = createHistory({ dir, random: hex });
  const list = await h.list();
  assert.deepEqual(list.map((e) => [e.id, e.status]), [['h20260101T000000Z-aaaaaa', 'corrupt']]);
  assert.ok(list[0].error.startsWith(`Thiếu file ${path.join(root, 'h20260101T000000Z-aaaaaa.json')}:`), list[0].error);
  assert.match(list[0].error, /Quên/);
  assert.deepEqual([list[0].orphan, list[0].hasIds], [true, true]);
  const left = (await readdir(root)).filter((f) => !f.startsWith('.')).sort();
  assert.deepEqual(left, ['h20260101T000000Z-aaaaaa.ids.csv']);
  // review S4: its Ids are readable and "Quên" removes the file.
  assert.deepEqual((await (async () => { const out = []; for await (const r of h.ids('h20260101T000000Z-aaaaaa')) out.push(r.id); return out; })()), ['001000000000001AAA']);
  assert.equal(await h.forget('h20260101T000000Z-aaaaaa'), true);
  assert.deepEqual((await readdir(root)).filter((f) => !f.startsWith('.')), []);
});

test('corrupt entries count toward maxRuns and are pruned first only after their grace period', async () => {
  const { utimes } = await import('node:fs/promises');
  const dir = await tmp();
  let t = Date.now();
  const h = createHistory({ dir, clock: () => t, random: hex, maxRuns: 2 });
  const good = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  await h.finish(good, { status: 'done', inserted: 3 });
  const root = path.join(dir, 'history');
  const bad = path.join(root, 'h20200101T000000Z-cccccc.json');
  await writeFile(bad, '');
  assert.deepEqual((await h.prunePreview()).map((e) => e.id), [good], 'young corrupt entry is kept: the good one would go');
  const old = new Date(t - 8 * 24 * 3600 * 1000);
  await utimes(bad, old, old);
  assert.deepEqual(await h.prunePreview(), [], 'an old corrupt entry goes first');
  t += 1000;
  await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  assert.ok(!(await readdir(root)).includes('h20200101T000000Z-cccccc.json'));
});

test('review N7: without hard links the lock is an exclusive create with the pid; stale-aside files are cleaned; N11: a held lock says locked', async () => {
  const dir = await tmp();
  const root = path.join(dir, 'history');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, '.lock.stale-abcdef'), '123');
  const noLink = async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  const h = createHistory({ dir, random: hex, linkFn: noLink });
  const st = await h.status();
  assert.equal(st.enabled, true, st.reason);
  assert.equal((await readFile(path.join(root, '.lock'), 'utf8')).trim(), String(process.pid));
  assert.deepEqual((await readdir(root)).filter((f) => f.startsWith('.lock.')), []);
  // Another live process holds it (the parent of this test process).
  await writeFile(path.join(root, '.lock'), String(process.ppid));
  const other = createHistory({ dir, random: hex, linkFn: noLink });
  const st2 = await other.status();
  assert.deepEqual([st2.enabled, st2.locked], [false, true]);
  assert.match(st2.reason, new RegExp(`pid ${process.ppid}`));
});

test('an interrupted entry recounts each step from its Id file (fix after merge)', async () => {
  const dir = await tmp();
  const h1 = createHistory({ dir, random: hex });
  const hid = await h1.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [{ nodeId: 'a', alias: 'acc', sobject: 'Account', records: 5 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', records: 4 }], total: 9 });
  await h1.appendIds(hid, [1, 2, 3].map((i) => ({ sobject: 'Account', nodeId: 'a', ref: `acc#${i}`, id: `001${i}` })));
  await h1.appendIds(hid, [{ sobject: 'Contact', nodeId: 'c', ref: 'con#1', id: '0031' }]);
  const h2 = createHistory({ dir, random: hex }); // a new server: the entry was left running
  await h2.status({ retry: true });
  const d = await h2.read(hid);
  assert.equal(d.status, 'interrupted');
  assert.equal(d.inserted, 4);
  assert.deepEqual(d.steps.map((s) => [s.nodeId, s.inserted]), [['a', 3], ['c', 1]]);
});

test('history refuses a symlinked directory or Id file and another user\'s directory (fix after merge)', { skip: process.platform === 'win32' }, async () => {
  const { symlink, unlink } = await import('node:fs/promises');
  // The history directory is a symlink.
  const dir = await tmp();
  const real = await tmp();
  await symlink(real, path.join(dir, 'history'));
  const st = await createHistory({ dir }).status();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /symlink/);
  // Owned by another uid.
  const other = await createHistory({ dir: await tmp(), uid: (process.getuid?.() ?? 0) + 1 }).status();
  assert.equal(other.enabled, false);
  assert.match(other.reason, /người dùng khác/);
  // An Id file replaced by a symlink: appends and reads are refused, nothing is written through it.
  const d2 = await tmp();
  const h = createHistory({ dir: d2, random: hex });
  const hid = await h.create({ org: ORG, workflow: null, seed: 1, now: 1, steps: [], total: 0 });
  const ids = path.join(d2, 'history', `${hid}.ids.csv`);
  const target = path.join(real, 'elsewhere.csv');
  await writeFile(target, 'sobject,step,ref,id\n');
  await unlink(ids);
  await symlink(target, ids);
  await assert.rejects(h.appendIds(hid, [{ sobject: 'Account', nodeId: 'a', ref: 'acc#1', id: '001A' }]));
  assert.equal(await readFile(target, 'utf8'), 'sobject,step,ref,id\n');
  await assert.rejects(h.remaining(hid), /symlink/);
});
