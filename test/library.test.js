// Workflow library (design 0012 A): storage, migration of the old autosave, quota, library file
// (client/js/library.js, pure, with fake storages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLibrary, migrateToLibrary, repairIndex, copyName, parseLibraryFile, libraryFile, isQuotaError,
  LIBRARY_KEY, TRASH_KEY, V1_KEY, V2_KEY, BROKEN_KEY,
} from '../client/js/library.js';
import { SAMPLES } from '../client/js/samples.js';
import { migrateV1 } from '../shared/migrate-v1.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';

/** A Storage-like map; `limit`: total characters it accepts (setItem throws QuotaExceededError past it). */
function fakeStorage(init = {}, limit = Infinity) {
  const map = new Map(Object.entries(init));
  const size = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    limit,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const before = map.get(k);
      map.set(k, String(v));
      if (size() > this.limit) {
        if (before === undefined) map.delete(k);
        else map.set(k, before);
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      }
    },
    removeItem: (k) => { map.delete(k); },
  };
}

let clock = 1_000;
const setup = (init, limit) => {
  const local = fakeStorage(init, limit);
  const session = fakeStorage();
  const lib = createLibrary({ local, session, now: () => ++clock });
  return { local, session, lib };
};
const migrate = (lib, local) => migrateToLibrary(lib, local, { samples: SAMPLES, migrateV1: (v1) => migrateV1(v1) });

test('migrateToLibrary: a valid v2 autosave becomes the first entry; v2 and v1 are not written or removed', () => {
  const v2 = JSON.stringify({ version: 2, name: 'Đang soạn', steps: SAMPLES[1].workflow.steps });
  const v1 = JSON.stringify(V1_SAMPLES[0].workflow);
  const { local, lib } = setup({ [V2_KEY]: v2, [V1_KEY]: v1 });
  const res = migrate(lib, local);
  assert.equal(res.status, 'migrated');
  assert.equal(res.from, 'v2');
  assert.deepEqual(lib.items().map((it) => it.name), ['Đang soạn']);
  assert.equal(lib.activeId(), res.id);
  assert.deepEqual(lib.read(res.id).workflow, JSON.parse(v2));
  assert.equal(local.getItem(V2_KEY), v2, 'v2 byte for byte');
  assert.equal(local.getItem(V1_KEY), v1);
  assert.equal(migrate(lib, local).status, 'exists', 'only once');
});

test('migrateToLibrary: from v1 through migrateV1 (report kept), from nothing: the first sample', () => {
  const v1 = JSON.stringify(V1_SAMPLES[0].workflow);
  const a = setup({ [V1_KEY]: v1 });
  const res = migrate(a.lib, a.local);
  assert.equal(res.from, 'v1');
  assert.equal(res.rawV1, v1);
  assert.ok(res.report);
  assert.deepEqual(a.lib.read(res.id).workflow, migrateV1(V1_SAMPLES[0].workflow).workflow);
  assert.equal(a.local.getItem(V1_KEY), v1);
  assert.equal(a.local.getItem(V2_KEY), null, 'no v2 written');
  const b = setup();
  const res2 = migrate(b.lib, b.local);
  assert.equal(res2.from, 'sample');
  assert.deepEqual(b.lib.read(res2.id).workflow, SAMPLES[0].workflow);
});

test('migrateToLibrary: a broken v2 is copied to .broken (never overwritten) and the library starts with the sample', () => {
  const broken = JSON.stringify({ version: 2, steps: [{ id: 'x', type: 'loop', config: {}, slots: { body: 5 } }] });
  const a = setup({ [V2_KEY]: broken });
  const res = migrate(a.lib, a.local);
  assert.equal(res.from, 'broken');
  assert.equal(res.brokenKey, BROKEN_KEY);
  assert.equal(a.local.getItem(BROKEN_KEY), broken);
  assert.equal(a.local.getItem(V2_KEY), broken);
  assert.equal(a.lib.items()[0].name, SAMPLES[0].workflow.name);
  const b = setup({ [V2_KEY]: broken, [BROKEN_KEY]: 'older copy' });
  const res2 = migrate(b.lib, b.local);
  assert.equal(b.local.getItem(BROKEN_KEY), 'older copy');
  assert.deepEqual([res2.brokenKey, res2.brokenOlder], [null, true], 'the message must not claim a copy of this autosave');
});

test('migrateToLibrary: storage full ⇒ legacy mode, nothing half-written, v2 untouched', () => {
  const v2 = JSON.stringify(SAMPLES[0].workflow);
  const { local, lib } = setup({ [V2_KEY]: v2 }, v2.length + 40);
  const res = migrate(lib, local);
  assert.equal(res.status, 'legacy');
  assert.deepEqual(res.workflow, SAMPLES[0].workflow, 'the tab still shows the autosave');
  assert.deepEqual([...local.map.keys()], [V2_KEY]);
});

test('repairIndex drops items without an entry and adds entries missing from the index', () => {
  const wf = JSON.stringify({ version: 2, name: 'Mồ côi', steps: [{ id: 'a', type: 'record', config: {} }] });
  const local = fakeStorage({ 'sfdg.wf.w1': '{"version":2,"name":"A","steps":[]}', 'sfdg.wf.orphan': wf, 'sfdg.wf.bad': '{' });
  const index = { version: 1, activeId: 'gone', items: [{ id: 'w1', name: 'A', createdAt: 1, updatedAt: 5, steps: 0, bytes: 10 }, { id: 'gone', name: 'X', createdAt: 1, updatedAt: 9 }] };
  const { index: fixed, changed } = repairIndex(index, local, 7);
  assert.equal(changed, true);
  assert.deepEqual(fixed.items.map((it) => [it.id, it.name, it.steps, Boolean(it.broken)]), [['w1', 'A', 0, false], ['orphan', 'Mồ côi', 1, false], ['bad', 'Workflow mới', 0, true]]);
  assert.equal(fixed.activeId, 'w1');
  assert.equal(repairIndex(fixed, local).changed, false);
});

test('copyName: (bản sao), (bản sao 2)…', () => {
  assert.equal(copyName('Lead', ['Lead']), 'Lead (bản sao)');
  assert.equal(copyName('Lead', ['Lead', 'Lead (bản sao)']), 'Lead (bản sao 2)');
  assert.equal(copyName('Lead (bản sao)', ['Lead', 'Lead (bản sao)', 'Lead (bản sao 2)']), 'Lead (bản sao 3)');
  assert.equal(copyName('', []), 'Workflow mới (bản sao)');
});

test('entries: create, save, rename, duplicate right below, delete and restore from the trash', () => {
  const { lib, local } = setup();
  const a = lib.create({ version: 2, name: 'A', steps: [] });
  const b = lib.create({ version: 2, name: 'B', steps: [] });
  assert.deepEqual(lib.items().map((it) => it.name), ['B', 'A']);
  assert.equal(lib.save(a, { version: 2, name: 'A', steps: [{ id: 'r', type: 'record', config: {} }] }).ok, true);
  assert.deepEqual(lib.items().map((it) => [it.name, it.steps]), [['A', 1], ['B', 0]]);
  const c = lib.duplicate(a);
  assert.deepEqual(lib.items().map((it) => it.name), ['A', 'A (bản sao)', 'B']);
  lib.rename(c, 'C');
  assert.equal(lib.read(c).workflow.name, 'C');
  lib.remove(b);
  assert.equal(lib.read(b).error !== undefined, true);
  assert.ok(local.getItem(TRASH_KEY));
  assert.equal(lib.restoreTrash(), b);
  assert.equal(lib.read(b).workflow.name, 'B');
  assert.equal(local.getItem(TRASH_KEY), null);
  // The key was taken meanwhile (another tab): the trashed entry comes back under a new id.
  lib.remove(b);
  local.setItem(`sfdg.wf.${b}`, JSON.stringify({ version: 2, name: 'Khác', steps: [] }));
  const back = lib.restoreTrash();
  assert.notEqual(back, b);
  assert.deepEqual([lib.read(back).workflow.name, lib.read(b).workflow.name], ['B', 'Khác']);
  // The undo time is over: the trash is emptied (only if it still holds that entry).
  lib.remove(back);
  lib.clearTrash('other');
  assert.ok(local.getItem(TRASH_KEY));
  lib.clearTrash(back);
  assert.equal(local.getItem(TRASH_KEY), null);
  // An unreadable entry is flagged in the index once read, and the flag goes once it is readable.
  local.setItem(`sfdg.wf.${c}`, '{');
  assert.ok(lib.read(c).error);
  assert.equal(lib.item(c).broken, true);
  local.setItem(`sfdg.wf.${c}`, JSON.stringify({ version: 2, name: 'C', steps: [] }));
  lib.read(c);
  assert.equal(lib.item(c).broken, undefined);
  // An entry deleted in another tab comes back with the next save of the tab that has it open.
  local.removeItem(`sfdg.wf.${a}`);
  assert.equal(lib.save(a, { version: 2, name: 'A', steps: [] }).readded, true);
  assert.ok(lib.item(a));
});

test('quota: save empties the trash and retries; still full ⇒ not saved, nothing else lost', () => {
  const { lib, local } = setup();
  const a = lib.create({ version: 2, name: 'A', steps: [] });
  const b = lib.create({ version: 2, name: 'B', steps: [] });
  lib.remove(b); // in the trash
  const used = [...local.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  local.limit = used + 30;
  const big = { version: 2, name: 'A', steps: [{ id: 'x', type: 'record', config: { note: 'x'.repeat(60) } }] };
  const res = lib.save(a, big);
  assert.equal(res.ok, true, 'fits once the trash is gone');
  assert.equal(local.getItem(TRASH_KEY), null);
  const bigger = { version: 2, name: 'A', steps: [{ id: 'x', type: 'record', config: { note: 'x'.repeat(5000) } }] };
  const fail = lib.save(a, bigger);
  assert.deepEqual([fail.ok, fail.quota], [false, true]);
  assert.deepEqual(lib.read(a).workflow, big, 'the last good save stays');
  assert.ok(isQuotaError(fail.error));
});

test('usage counts characters; rename keeps entry and index together when the index cannot be written', () => {
  const { lib, local } = setup();
  const a = lib.create({ version: 2, name: 'A', steps: [] });
  const chars = [...local.map].filter(([k]) => k.startsWith('sfdg.')).reduce((n, [k, v]) => n + k.length + v.length, 0);
  assert.equal(lib.usage(), chars);
  const before = local.getItem(`sfdg.wf.${a}`);
  const realSet = local.setItem.bind(local);
  local.setItem = (k, v) => { if (k === LIBRARY_KEY) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); realSet(k, v); };
  assert.throws(() => lib.rename(a, 'Tên mới'));
  local.setItem = realSet;
  assert.equal(local.getItem(`sfdg.wf.${a}`), before);
  assert.equal(lib.item(a).name, 'A');
});

test('library file round trip: export, parse, the workflows as they were', () => {
  const { lib } = setup();
  lib.create(SAMPLES[0].workflow);
  lib.create(SAMPLES[1].workflow);
  const file = JSON.parse(JSON.stringify(lib.exportAll('2026-10-28T10:24:00.000Z')));
  assert.deepEqual(Object.keys(file), ['sfdg', 'version', 'exportedAt', 'workflows']);
  assert.deepEqual(parseLibraryFile(file), { workflows: [SAMPLES[1].workflow, SAMPLES[0].workflow], v1: 0, broken: 0 });
  assert.equal(parseLibraryFile({ version: 2, steps: [] }), null);
  const mixed = libraryFile([SAMPLES[0].workflow, { version: 1, nodes: [] }, { version: 2, steps: [{ id: 'l', type: 'loop', slots: { body: 5 } }] }, 'x'], 'x');
  assert.deepEqual(parseLibraryFile(mixed), { workflows: [SAMPLES[0].workflow], v1: 1, broken: 2 });
  assert.deepEqual(libraryFile([], 'x').workflows, []);
});
