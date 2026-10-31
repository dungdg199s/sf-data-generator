// Workflow library (design 0012 A): many named workflows in localStorage, each saved on its own,
// instead of the single autosave `sfdg.workflow.v2`. This module is the storage part and has no
// DOM: storages are passed in (window.localStorage / sessionStorage in the browser, fakes in
// test/library.test.js), and imports are relative so Node can run it. library-ui.js is the UI.
//
// Keys:
//   sfdg.library         { version: 1, activeId, items: [{ id, name, createdAt, updatedAt, steps, bytes }] }
//   sfdg.wf.<id>         the workflow (version 2, exactly like a file)
//   sfdg.library.trash   { item, workflow } of the last deleted entry (for "Hoàn tác")
//   session sfdg.activeId  the entry this tab has open
// `sfdg.workflow.v2` and `sfdg.workflow.v1` are read once for the migration and never written or
// removed here (v2 stays as a frozen backup); `sfdg.workflow.v2.broken` is only written when absent.
// Every write puts the entry first and the index second.

import { malformedSteps, countSteps } from '../../shared/workflow-tree.js';

export const LIBRARY_KEY = 'sfdg.library';
export const ENTRY_PREFIX = 'sfdg.wf.';
export const TRASH_KEY = 'sfdg.library.trash';
export const ACTIVE_KEY = 'sfdg.activeId';
export const V2_KEY = 'sfdg.workflow.v2';
export const V1_KEY = 'sfdg.workflow.v1';
export const BROKEN_KEY = 'sfdg.workflow.v2.broken';
export const NEW_NAME = 'Workflow mới';
export const RECENT_MAX = 20;

const entryKey = (id) => `${ENTRY_PREFIX}${id}`;

/** A storage write failed because the browser storage is full. */
export function isQuotaError(e) {
  return Boolean(e) && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

/** `Account + Contact` → `Account + Contact (bản sao)`, then `(bản sao 2)`… not in `names`. */
export function copyName(name, names) {
  const taken = new Set(names);
  const base = String(name ?? '').replace(/ \(bản sao(?: \d+)?\)$/, '') || NEW_NAME;
  if (!taken.has(`${base} (bản sao)`)) return `${base} (bản sao)`;
  for (let i = 2; ; i++) if (!taken.has(`${base} (bản sao ${i})`)) return `${base} (bản sao ${i})`;
}

/** Index row of a workflow (`json`: its stored text). */
export function itemOf(id, wf, json, { createdAt, updatedAt }) {
  return {
    id,
    name: typeof wf?.name === 'string' && wf.name ? wf.name : NEW_NAME,
    createdAt,
    updatedAt,
    steps: Array.isArray(wf?.steps) ? countSteps(wf.steps) : 0,
    bytes: json.length * 2, // localStorage counts UTF-16 code units
  };
}

/** Parse a stored workflow. → { workflow } or { error, raw } (not JSON, not version 2, malformed). */
export function parseEntry(raw) {
  if (raw === null || raw === undefined) return { error: 'không còn trong trình duyệt', raw: null };
  let wf;
  try {
    wf = JSON.parse(raw);
  } catch {
    return { error: 'không phải JSON hợp lệ', raw };
  }
  if (!wf || typeof wf !== 'object' || wf.version !== 2) return { error: 'không phải workflow version 2', raw };
  const bad = malformedSteps(wf);
  return bad ? { error: bad, raw } : { workflow: wf };
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storageKeys(storage) {
  const out = [];
  for (let i = 0; i < storage.length; i++) out.push(storage.key(i));
  return out;
}

/**
 * Fix the index against what is stored (pure; `storage` is only read): an item without its
 * `sfdg.wf.<id>` is dropped, an `sfdg.wf.<id>` missing from the index is added back (name from the
 * workflow). → { index, changed }
 */
export function repairIndex(index, storage, now = Date.now()) {
  const base = index && Array.isArray(index.items) ? index : { version: 1, activeId: null, items: [] };
  const seen = new Set();
  const items = base.items.filter((it) => {
    if (!it || typeof it.id !== 'string' || seen.has(it.id) || storage.getItem(entryKey(it.id)) === null) return false;
    seen.add(it.id);
    return true;
  });
  let changed = items.length !== base.items.length || base !== index;
  for (const key of storageKeys(storage)) {
    if (!key?.startsWith(ENTRY_PREFIX)) continue;
    const id = key.slice(ENTRY_PREFIX.length);
    if (seen.has(id)) continue;
    const raw = storage.getItem(key);
    const { workflow } = parseEntry(raw);
    items.push(itemOf(id, workflow ?? {}, raw ?? '', { createdAt: now, updatedAt: now }));
    seen.add(id);
    changed = true;
  }
  const activeId = items.some((it) => it.id === base.activeId) ? base.activeId : items[0]?.id ?? null;
  if (activeId !== base.activeId) changed = true;
  return { index: { version: 1, activeId, items }, changed };
}

/** Items, most recently edited first (a copy right below its original). */
export function sortedItems(index) {
  return [...(index?.items ?? [])].sort((a, b) => (b.updatedAt - a.updatedAt) || (a.createdAt - b.createdAt));
}

let idCounter = 0;
/** A new entry id (not random: the time plus a counter is unique enough within one browser). */
export function newEntryId(now = Date.now()) {
  idCounter = (idCounter + 1) % 1296;
  return `w${now.toString(36)}${idCounter.toString(36).padStart(2, '0')}`;
}

/**
 * The library on `local` (localStorage) for the tab whose sessionStorage is `session`. Every
 * operation reads the index again (another tab may have changed it). Writes throw on failure
 * (quota): the caller decides what to tell the user, except `save`, which empties the trash and
 * tries once more first.
 */
export function createLibrary({ local, session, now = () => Date.now(), makeId = newEntryId } = {}) {
  const readIndex = () => {
    const { index, changed } = repairIndex(readJson(local, LIBRARY_KEY), local, now());
    if (changed) {
      try {
        local.setItem(LIBRARY_KEY, JSON.stringify(index));
      } catch {
        /* repaired again next time */
      }
    }
    return index;
  };
  const writeIndex = (index) => local.setItem(LIBRARY_KEY, JSON.stringify(index));
  const freshId = () => {
    let id = makeId(now());
    while (local.getItem(entryKey(id)) !== null) id = makeId(now());
    return id;
  };

  const lib = {
    exists: () => local.getItem(LIBRARY_KEY) !== null,
    index: readIndex,
    items: () => sortedItems(readIndex()),
    item: (id) => readIndex().items.find((it) => it.id === id) ?? null,
    read: (id) => parseEntry(local.getItem(entryKey(id))),
    raw: (id) => local.getItem(entryKey(id)),

    /** The entry this tab has open (sessionStorage), else the one opened last in any tab. */
    activeId() {
      const index = readIndex();
      let id = null;
      try {
        id = session.getItem(ACTIVE_KEY);
      } catch {
        id = null;
      }
      return index.items.some((it) => it.id === id) ? id : index.activeId;
    },

    setActive(id) {
      try {
        session.setItem(ACTIVE_KEY, id);
      } catch {
        /* optional */
      }
      const index = readIndex();
      if (index.activeId === id) return;
      index.activeId = id;
      try {
        writeIndex(index);
      } catch {
        /* only the "last opened" hint */
      }
    },

    /** A new entry holding `wf`. → its id. Throws when storage is full. */
    create(wf, { updatedAt } = {}) {
      const id = freshId();
      const json = JSON.stringify(wf);
      local.setItem(entryKey(id), json);
      try {
        const index = readIndex();
        const t = now();
        const at = index.items.findIndex((it) => it.id === id);
        const item = itemOf(id, wf, json, { createdAt: t, updatedAt: updatedAt ?? t });
        if (at >= 0) index.items[at] = item; // repairIndex just added it back from the entry
        else index.items.push(item);
        writeIndex(index);
      } catch (e) {
        local.removeItem(entryKey(id)); // entry and index together, or neither
        throw e;
      }
      return id;
    },

    /**
     * Save `wf` into entry `id` (also re-adds an entry deleted meanwhile in another tab). On a
     * full storage the trash is emptied and the write tried once more.
     * → { ok: true, json, readded } or { ok: false, quota, error }
     */
    save(id, wf) {
      const json = JSON.stringify(wf);
      const attempt = () => {
        const readded = local.getItem(entryKey(id)) === null;
        local.setItem(entryKey(id), json);
        const index = readIndex();
        const old = index.items.find((it) => it.id === id);
        const item = itemOf(id, wf, json, { createdAt: old?.createdAt ?? now(), updatedAt: now() });
        index.items = [...index.items.filter((it) => it.id !== id), item];
        writeIndex(index);
        return { ok: true, json, readded };
      };
      try {
        return attempt();
      } catch (e) {
        if (!isQuotaError(e)) return { ok: false, quota: false, error: e };
        local.removeItem(TRASH_KEY);
        try {
          return attempt();
        } catch (e2) {
          return { ok: false, quota: isQuotaError(e2), error: e2 };
        }
      }
    },

    /** Rename an entry that is not open (the open one is renamed through the workflow). */
    rename(id, name) {
      const res = lib.read(id);
      if (!res.workflow) return false;
      res.workflow.name = name;
      const json = JSON.stringify(res.workflow);
      local.setItem(entryKey(id), json);
      const index = readIndex();
      const it = index.items.find((x) => x.id === id);
      if (it) Object.assign(it, { name: name || NEW_NAME, bytes: json.length * 2 });
      writeIndex(index);
      return true;
    },

    /** "Nhân bản": a new entry `<name> (bản sao)` listed right below the original. → id */
    duplicate(id) {
      const res = lib.read(id);
      const src = lib.item(id);
      if (!res.workflow || !src) return null;
      const wf = { ...res.workflow, name: copyName(src.name, readIndex().items.map((it) => it.name)) };
      return lib.create(wf, { updatedAt: src.updatedAt });
    },

    /** Delete an entry; it waits in the trash (one entry) for "Hoàn tác". */
    remove(id) {
      const item = lib.item(id);
      const raw = local.getItem(entryKey(id));
      try {
        if (item && raw !== null) local.setItem(TRASH_KEY, JSON.stringify({ item, workflow: raw }));
      } catch {
        local.removeItem(TRASH_KEY); // no room for the copy: the delete still happens, without undo
      }
      local.removeItem(entryKey(id));
      const index = readIndex();
      index.items = index.items.filter((it) => it.id !== id);
      if (index.activeId === id) index.activeId = sortedItems(index)[0]?.id ?? null;
      writeIndex(index);
      return item;
    },

    /** "Hoàn tác" of a delete: the trashed entry back, under its id. → id or null. */
    restoreTrash() {
      const trash = readJson(local, TRASH_KEY);
      if (!trash?.item?.id || typeof trash.workflow !== 'string') return null;
      local.setItem(entryKey(trash.item.id), trash.workflow);
      const index = readIndex();
      index.items = [...index.items.filter((it) => it.id !== trash.item.id), trash.item];
      writeIndex(index);
      local.removeItem(TRASH_KEY);
      return trash.item.id;
    },

    /** Bytes used by the app in this origin's localStorage (UTF-16). */
    usage() {
      let n = 0;
      for (const key of storageKeys(local)) if (key?.startsWith('sfdg.')) n += (key.length + (local.getItem(key)?.length ?? 0)) * 2;
      return n;
    },

    /** "Tải tất cả (JSON)": the library file. */
    exportAll(exportedAt = new Date(now()).toISOString()) {
      const workflows = sortedItems(readIndex()).map((it) => lib.read(it.id).workflow).filter(Boolean);
      return libraryFile(workflows, exportedAt);
    },
  };
  return lib;
}

/** The library file format (design 0012 A). */
export function libraryFile(workflows, exportedAt) {
  return { sfdg: 'library', version: 1, exportedAt, workflows };
}

/** The workflows of a library file, or null when `data` is not one. */
export function parseLibraryFile(data) {
  if (!data || typeof data !== 'object' || data.sfdg !== 'library' || !Array.isArray(data.workflows)) return null;
  return data.workflows;
}

/**
 * First run of the library (no `sfdg.library`): the old autosave becomes the first entry.
 *   1. a valid `sfdg.workflow.v2` (name kept), 2. else `sfdg.workflow.v1` through `migrateV1`,
 *   3. else the first sample; a broken v2 is copied to `sfdg.workflow.v2.broken` (when absent) and
 *   the library starts with the sample. v1 and v2 are never written or removed.
 * `migrateV1(v1) → { workflow, report }` (may throw). Storage full: nothing is kept, status 'legacy'
 * (the tab goes on with the single autosave, as before).
 * → { status: 'exists' | 'migrated' | 'legacy', from: 'v2' | 'v1' | 'sample' | 'broken', workflow,
 *     id?, report?, rawV1?, brokenRaw?, brokenError?, brokenKey?, v1Error? }
 */
export function migrateToLibrary(lib, local, { samples, migrateV1 }) {
  if (lib.exists()) return { status: 'exists' };
  const out = { status: 'migrated' };
  const rawV2 = local.getItem(V2_KEY);
  const v2 = rawV2 === null ? null : parseEntry(rawV2);
  if (v2?.workflow) Object.assign(out, { from: 'v2', workflow: v2.workflow });
  else if (v2?.error) {
    let brokenKey = null;
    try {
      if (local.getItem(BROKEN_KEY) === null) local.setItem(BROKEN_KEY, rawV2);
      brokenKey = BROKEN_KEY;
    } catch {
      brokenKey = null;
    }
    Object.assign(out, { from: 'broken', brokenRaw: rawV2, brokenError: v2.error, brokenKey });
  } else {
    const rawV1 = local.getItem(V1_KEY);
    let v1 = null;
    try {
      v1 = rawV1 ? JSON.parse(rawV1) : null;
    } catch {
      v1 = null;
    }
    if (v1?.version === 1 && Array.isArray(v1.nodes)) {
      try {
        const { workflow, report } = migrateV1(v1);
        Object.assign(out, { from: 'v1', workflow, report, rawV1 });
      } catch (e) {
        out.v1Error = e.message;
      }
    }
  }
  if (!out.workflow) Object.assign(out, { from: out.from ?? 'sample', workflow: structuredClone(samples[0].workflow) });
  try {
    out.id = lib.create(out.workflow);
    lib.setActive(out.id);
  } catch {
    // Not even one entry fits: leave no half-made library behind, so the next start tries again.
    local.removeItem(LIBRARY_KEY);
    out.status = 'legacy';
  }
  return out;
}
