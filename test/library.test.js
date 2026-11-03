// Design 0012 A: the workflow library (client/js/library.js, pure functions over a fake Storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYS, itemKey, readIndex, repairIndex, copyName, migrateToLibrary, saveItem, readItem, exportLibrary, libraryWorkflows, trySet,
  createLibrary,
} from '../client/js/library.js';
import { migrateV1 } from '../shared/migrate-v1.js';
import { SAMPLES } from '../client/js/samples.js';

/** A Storage with an optional byte quota (setItem throws QuotaExceededError past it). */
function fakeStorage(init = {}, { quota = Infinity } = {}) {
  const map = new Map(Object.entries(init));
  const size = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => { map.delete(k); },
    setItem(k, v) {
      const before = map.get(k);
      map.set(k, String(v));
      if (size() > quota) {
        if (before === undefined) map.delete(k);
        else map.set(k, before);
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      }
    },
  };
}

let n = 0;
const deps = () => ({ sample: SAMPLES[0].workflow, migrateV1: (wf) => migrateV1(wf), now: 1000, newId: () => `w${++n}` });
const V2 = JSON.stringify({ version: 2, name: 'Của tôi', steps: [{ id: 'a', type: 'record', config: { sobject: 'Account' } }] });
const V1 = JSON.stringify({ version: 1, name: 'Cũ', nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'a', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [] } }], edges: [{ from: 'start', to: 'a' }] });

test('migrateToLibrary: a v2 autosave becomes the first item; v2 and v1 are not written or removed', () => {
  const s = fakeStorage({ [KEYS.v2]: V2, [KEYS.v1]: V1 });
  const res = migrateToLibrary(s, deps());
  assert.equal(res.mode, 'library');
  assert.deepEqual(res.announce, { kind: 'v2' });
  assert.equal(res.workflow.name, 'Của tôi');
  assert.equal(s.getItem(KEYS.v2), V2, 'v2 byte for byte');
  assert.equal(s.getItem(KEYS.v1), V1);
  const index = readIndex(s);
  assert.deepEqual(index.items.map((it) => [it.name, it.steps]), [['Của tôi', 1]]);
  assert.equal(index.activeId, res.activeId);
  assert.equal(s.getItem(itemKey(res.activeId)), V2);
});

test('migrateToLibrary: from v1 (migrated, report), from nothing (the sample), from a malformed v2 (backed up, sample)', () => {
  const v1 = fakeStorage({ [KEYS.v1]: V1 });
  const a = migrateToLibrary(v1, deps());
  assert.equal(a.announce.kind, 'v1');
  assert.equal(a.workflow.version, 2);
  assert.equal(v1.getItem(KEYS.v1), V1);
  assert.equal(v1.getItem(KEYS.v2), null, 'v2 is not written either');
  const none = fakeStorage();
  const b = migrateToLibrary(none, deps());
  assert.equal(b.announce, null);
  assert.equal(b.workflow.name, SAMPLES[0].workflow.name);
  const broken = JSON.stringify({ version: 2, steps: [{ id: 'x', type: 'loop', slots: { body: 5 } }] });
  const bad = fakeStorage({ [KEYS.v2]: broken });
  const c = migrateToLibrary(bad, deps());
  assert.equal(c.announce.kind, 'broken');
  assert.equal(c.announce.backup, KEYS.broken);
  assert.equal(bad.getItem(KEYS.v2), broken);
  assert.equal(bad.getItem(KEYS.broken), broken);
  assert.equal(c.workflow.name, SAMPLES[0].workflow.name);
});

test('migrateToLibrary: storage full ⇒ legacy mode, nothing left behind', () => {
  const s = fakeStorage({ [KEYS.v2]: V2 }, { quota: V2.length + KEYS.v2.length + 40 });
  const res = migrateToLibrary(s, deps());
  assert.equal(res.mode, 'legacy');
  assert.equal(readIndex(s), null);
  assert.deepEqual([...s.map.keys()], [KEYS.v2]);
});

test('repairIndex: an entry without its workflow is dropped, an orphan workflow is added back', () => {
  const s = fakeStorage({
    [itemKey('a')]: JSON.stringify({ version: 2, name: 'A', steps: [] }),
    [itemKey('orphan')]: JSON.stringify({ version: 2, name: 'Mồ côi', steps: [{ id: 'x', type: 'record' }] }),
  });
  const { index, changed } = repairIndex({ version: 1, activeId: 'gone', items: [{ id: 'a', name: 'A', updatedAt: 5 }, { id: 'gone', name: 'G', updatedAt: 9 }] }, s);
  assert.ok(changed);
  assert.deepEqual(index.items.map((it) => [it.id, it.name]), [['a', 'A'], ['orphan', 'Mồ côi']]);
  assert.equal(index.activeId, 'a', 'activeId falls back to the most recent item');
});

test('copyName: "(bản sao)", then "(bản sao 2)"', () => {
  assert.equal(copyName('Lead', ['Lead']), 'Lead (bản sao)');
  assert.equal(copyName('Lead', ['Lead', 'Lead (bản sao)']), 'Lead (bản sao 2)');
  assert.equal(copyName('Lead (bản sao)', ['Lead', 'Lead (bản sao)', 'Lead (bản sao 2)']), 'Lead (bản sao 3)');
});

test('saveItem: quota ⇒ trash emptied and retried; still full ⇒ not saved; an item deleted elsewhere is added back', () => {
  const wf = { version: 2, name: 'A', steps: [] };
  const trash = JSON.stringify({ item: { id: 't' }, workflow: { version: 2, steps: Array(50).fill({ id: 'x', type: 'record' }) } });
  const room = itemKey('a').length + JSON.stringify(wf).length + 400;
  const s = fakeStorage({ [KEYS.trash]: trash }, { quota: room });
  const ok = saveItem(s, 'a', wf, { now: 5 });
  assert.equal(ok.ok, true, 'saved once the trash was emptied');
  assert.equal(s.getItem(KEYS.trash), null);
  assert.equal(ok.readded, true);
  const big = { ...wf, steps: Array(200).fill({ id: 'y', type: 'record', config: { sobject: 'Account' } }) };
  assert.deepEqual(saveItem(s, 'a', big, { now: 6 }), { ok: false, error: 'quota' });
  assert.deepEqual(readItem(s, 'a').workflow, wf, 'the last good save is kept');
  assert.equal(trySet(s, 'k', 'x'.repeat(room)), 'quota');
});

test('library file round trip: export, then libraryWorkflows reads it back', () => {
  const s = fakeStorage();
  saveItem(s, 'a', { version: 2, name: 'A', steps: [] }, { now: 1 });
  saveItem(s, 'b', { version: 2, name: 'B', steps: [{ id: 'x', type: 'record' }] }, { now: 2 });
  s.setItem(itemKey('bad'), '{');
  const text = exportLibrary(s, readIndex(s), '2026-10-28T10:24:00Z');
  const obj = JSON.parse(text);
  assert.deepEqual([obj.sfdg, obj.version, obj.exportedAt], ['library', 1, '2026-10-28T10:24:00Z']);
  assert.deepEqual(libraryWorkflows(obj).map((w) => w.name), ['B', 'A'], 'most recent first');
  assert.equal(libraryWorkflows({ version: 2, steps: [] }), null, 'a workflow file is not a library file');
  assert.match(readItem(s, 'bad').error, /không đọc được/);
});

// ---------- review 0012: the open item of a tab (createLibrary) ----------

const wfOf = (name, n = 0) => ({ version: 2, name, steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: 'record', config: {} })) });
function libWith(storage, ids) {
  for (const id of ids) saveItem(storage, id, wfOf(id), { now: 1 });
  let k = 0;
  return createLibrary({ storage, now: () => 10, newId: () => `n${++k}`, activeId: ids[0] });
}

test('review B1: a pause (another tab wrote the item) ends when another item is opened or created; the new one is saved', () => {
  const s = fakeStorage();
  const lib = libWith(s, ['a', 'b']);
  lib.pause();
  assert.equal(lib.isPaused(), true);
  assert.deepEqual(lib.save(wfOf('a edited')), { ok: false, paused: true });
  assert.equal(readItem(s, 'a').workflow.name, 'a', 'the other tab\'s version is not overwritten');
  const created = lib.create(wfOf('Mới'));
  assert.equal(lib.isPaused(), false);
  assert.equal(lib.save(wfOf('Mới', 1)).ok, true);
  assert.equal(readItem(s, created.id).workflow.steps.length, 1, 'edits of the new workflow are saved');
  // The pause of "a" no longer applies: a late "Giữ bản của tab này" for it does nothing.
  assert.equal(lib.resume('a'), false);
  lib.open('a');
  lib.pause();
  lib.open('b');
  assert.equal(lib.isPaused(), false);
  assert.equal(lib.save(wfOf('b edited')).ok, true);
});

test('review B2 / S1: deleting keeps the undo in memory (trash not writable), opens a successor first, never sfdg.wf.null', () => {
  const big = JSON.stringify(wfOf('x', 30));
  // Room for the items and the index, not for a copy in the trash.
  const s = fakeStorage({}, { quota: 3 * big.length });
  for (const id of ['a', 'b']) saveItem(s, id, wfOf(id, 30), { now: id === 'a' ? 2 : 1 });
  const lib = createLibrary({ storage: s, now: () => 10, newId: () => 'n1', activeId: 'a' });
  const res = lib.remove('a', { empty: wfOf('Workflow mới') });
  assert.equal(res.ok, true);
  assert.equal(s.getItem(KEYS.trash), null, 'the trash could not be written');
  assert.deepEqual([res.opened.id, lib.activeId], ['b', 'b']);
  assert.equal(s.getItem(itemKey('a')), null);
  assert.ok(![...s.map.keys()].includes(itemKey('null')));
  const back = lib.restore(res.undo);
  assert.deepEqual(back, { ok: true, id: 'a' });
  assert.equal(readItem(s, 'a').workflow.steps.length, 30);
  assert.ok(readIndex(s).items.some((it) => it.id === 'a'));
  // The last item: an empty workflow is created and opened first.
  const one = fakeStorage();
  const l1 = libWith(one, ['only']);
  const r1 = l1.remove('only', { empty: wfOf('Workflow mới') });
  assert.equal(r1.opened.id, 'n1');
  assert.equal(readItem(one, 'n1').workflow.name, 'Workflow mới');
  assert.ok(![...one.map.keys()].includes(itemKey('null')));
});

test('review N3: restoring never overwrites an existing item (a new id then)', () => {
  const s = fakeStorage();
  const lib = libWith(s, ['a', 'b']);
  const res = lib.remove('b');
  saveItem(s, 'b', wfOf('another b'), { now: 3 });
  const back = lib.restore(res.undo);
  assert.equal(back.ok, true);
  assert.notEqual(back.id, 'b');
  assert.equal(readItem(s, 'b').workflow.name, 'another b');
  assert.equal(readItem(s, back.id).workflow.name, 'b');
});
