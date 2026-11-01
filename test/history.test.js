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
