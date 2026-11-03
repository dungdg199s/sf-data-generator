// Workflow library (design 0012 A): many named workflows in this browser, each saved on its own.
// Pure functions over a Storage-like object ({ getItem, setItem, removeItem, key(i), length }),
// tested in Node with a fake one (test/library.test.js). The UI is library-ui.js; main.js boots it.
// The relative imports resolve to /shared/ in the browser and to shared/ in Node.
//
// localStorage:
//   sfdg.library        { version: 1, activeId, items: [{ id, name, createdAt, updatedAt, steps, bytes }] }
//                       (index only; activeId = the item opened last, for a new tab)
//   sfdg.wf.<id>        the workflow (version 2, exactly as a file)
//   sfdg.library.trash  { item, workflow } of the item deleted last (for "Hoàn tác")
// sessionStorage:
//   sfdg.activeId       the item this tab has open (two tabs can edit two workflows)
// sfdg.workflow.v2 and sfdg.workflow.v1 are never written or removed once the library exists
// (v2 stays as a frozen backup; it is still the autosave of a tab that could not create the
// library because storage was full: "legacy" mode). sfdg.workflow.v2.broken: as before.

import { malformedSteps, walkSteps } from '../../shared/workflow-tree.js';

export const KEYS = {
  index: 'sfdg.library',
  trash: 'sfdg.library.trash',
  active: 'sfdg.activeId',
  v2: 'sfdg.workflow.v2',
  v1: 'sfdg.workflow.v1',
  broken: 'sfdg.workflow.v2.broken',
};
export const itemKey = (id) => `sfdg.wf.${id}`;
export const RECENT = 20;

const isQuota = (e) => e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

/** Number of steps of a workflow (every level). */
export function countSteps(wf) {
  let n = 0;
  walkSteps(wf?.steps, () => { n++; });
  return n;
}

function parse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const validIndex = (x) => x && typeof x === 'object' && x.version === 1 && Array.isArray(x.items);

/** The index, or null when missing / unreadable. */
export function readIndex(storage) {
  const x = parse(storage.getItem(KEYS.index));
  return validIndex(x) ? { version: 1, activeId: x.activeId ?? null, items: x.items.filter((it) => it && typeof it.id === 'string') } : null;
}

/** Keys of every workflow item in storage. */
function itemIds(storage) {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith('sfdg.wf.')) out.push(k.slice('sfdg.wf.'.length));
  }
  return out;
}

/**
 * Repair the index when read: an entry without its `sfdg.wf.<id>` is dropped; a `sfdg.wf.<id>`
 * missing from the index is added back (its name from the workflow). → { index, changed }
 */
export function repairIndex(index, storage) {
  let changed = false;
  const items = index.items.filter((it) => {
    if (storage.getItem(itemKey(it.id)) !== null) return true;
    changed = true;
    return false;
  });
  const known = new Set(items.map((it) => it.id));
  for (const id of itemIds(storage)) {
    if (known.has(id)) continue;
    const raw = storage.getItem(itemKey(id));
    const wf = parse(raw);
    items.push({ id, name: typeof wf?.name === 'string' && wf.name ? wf.name : 'Workflow', createdAt: 0, updatedAt: 0, steps: countSteps(wf), bytes: raw.length });
    changed = true;
  }
  const activeId = items.some((it) => it.id === index.activeId) ? index.activeId : mostRecent(items)?.id ?? null;
  if (activeId !== index.activeId) changed = true;
  return { index: { version: 1, activeId, items }, changed };
}

/** Items, most recently edited first. */
export const byRecent = (items) => [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
const mostRecent = (items) => byRecent(items)[0] ?? null;

/** "<name> (bản sao)", then "(bản sao 2)", … the first not in `names`. */
export function copyName(name, names) {
  const taken = new Set(names);
  const base = String(name ?? '').replace(/ \(bản sao(?: \d+)?\)$/, '') || 'Workflow';
  let candidate = `${base} (bản sao)`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base} (bản sao ${i})`;
  return candidate;
}

/** Index entry of a workflow. */
export function itemMeta(id, wf, json, now, createdAt = now) {
  return { id, name: wf?.name || 'Workflow mới', createdAt, updatedAt: now, steps: countSteps(wf), bytes: json.length };
}

/** setItem, retried once after emptying the trash when storage is full. → null | 'quota' | 'error' */
export function trySet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return null;
  } catch (e) {
    if (!isQuota(e)) return 'error';
  }
  try {
    storage.removeItem(KEYS.trash);
    storage.setItem(key, value);
    return null;
  } catch (e) {
    return isQuota(e) ? 'quota' : 'error';
  }
}

/**
 * Save `wf` as item `id`: the workflow first, then the index (read again, so another tab's items
 * are kept); an item missing from the index (deleted in another tab) is added back.
 * → { ok: true, index, readded } | { ok: false, error: 'quota' | 'error' }
 */
export function saveItem(storage, id, wf, { now, activeId = id } = {}) {
  const json = JSON.stringify(wf);
  const err = trySet(storage, itemKey(id), json);
  if (err) return { ok: false, error: err };
  const index = readIndex(storage) ?? { version: 1, activeId: null, items: [] };
  const at = index.items.findIndex((it) => it.id === id);
  const readded = at < 0;
  const meta = itemMeta(id, wf, json, now, at >= 0 ? index.items[at].createdAt : now);
  if (at >= 0) index.items[at] = meta;
  else index.items.push(meta);
  index.activeId = activeId;
  const err2 = trySet(storage, KEYS.index, JSON.stringify(index));
  if (err2) return { ok: false, error: err2 };
  return { ok: true, index, readded };
}

/** The workflow of an item: { workflow } | { error: message, raw } (unreadable / malformed). */
export function readItem(storage, id) {
  const raw = storage.getItem(itemKey(id));
  if (raw === null) return { error: 'không còn trong thư viện', raw: null };
  const wf = parse(raw);
  if (!wf || wf.version !== 2) return { error: 'không đọc được (không phải workflow version 2)', raw };
  const bad = malformedSteps(wf);
  return bad ? { error: bad, raw } : { workflow: wf };
}

/**
 * First start of a version with the library (no sfdg.library): the autosave becomes the first
 * item. v2 valid → that; v2 malformed → backed up to sfdg.workflow.v2.broken, start with the
 * sample; no v2 but v1 → migrateV1; nothing → the sample. The item is written before the index;
 * either failing (quota) → legacy mode (one autosave in sfdg.workflow.v2, as before), nothing
 * left behind. v2 and v1 are never written or removed.
 * deps: { sample (workflow), migrateV1(wf) → { workflow, report }, now, newId() }
 * → { mode: 'library' | 'legacy', index, activeId, workflow, announce }
 *   announce: { kind: 'v2' } | { kind: 'v1', report, raw } | { kind: 'broken', raw, error, backup } | { kind: 'v1failed', error } | null
 */
export function migrateToLibrary(storage, { sample, migrateV1, now, newId }) {
  let workflow = null;
  let announce = null;
  const rawV2 = storage.getItem(KEYS.v2);
  if (rawV2 !== null) {
    const wf = parse(rawV2);
    const bad = wf?.version === 2 ? malformedSteps(wf) : 'không phải workflow version 2';
    if (!bad) {
      workflow = wf;
      announce = { kind: 'v2' };
    } else {
      const backup = trySet(storage, KEYS.broken, rawV2) ? null : KEYS.broken;
      announce = { kind: 'broken', raw: rawV2, error: bad, backup };
    }
  }
  if (!workflow && !announce) {
    const rawV1 = storage.getItem(KEYS.v1);
    const v1 = parse(rawV1);
    if (v1?.version === 1 && Array.isArray(v1.nodes)) {
      try {
        const res = migrateV1(v1);
        workflow = res.workflow;
        announce = { kind: 'v1', report: res.report, raw: rawV1 };
      } catch (e) {
        announce = { kind: 'v1failed', error: e.message };
      }
    }
  }
  workflow ??= structuredClone(sample);
  const id = newId();
  const json = JSON.stringify(workflow);
  const index = { version: 1, activeId: id, items: [itemMeta(id, workflow, json, now)] };
  if (trySet(storage, itemKey(id), json)) return { mode: 'legacy', index: null, activeId: null, workflow, announce };
  if (trySet(storage, KEYS.index, JSON.stringify(index))) {
    try { storage.removeItem(itemKey(id)); } catch { /* nothing more to do */ }
    return { mode: 'legacy', index: null, activeId: null, workflow, announce };
  }
  return { mode: 'library', index, activeId: id, workflow, announce };
}

/**
 * The library file ("Tải tất cả (JSON)"): { sfdg: 'library', version: 1, exportedAt, workflows }.
 * Unreadable items are left out.
 */
export function exportLibrary(storage, index, exportedAt) {
  const workflows = byRecent(index.items).map((it) => readItem(storage, it.id).workflow).filter(Boolean);
  return JSON.stringify({ sfdg: 'library', version: 1, exportedAt, workflows }, null, 2);
}

/** The workflows of a library file (Mở file JSON…), or null when `obj` is not one. */
export function libraryWorkflows(obj) {
  if (!obj || obj.sfdg !== 'library' || !Array.isArray(obj.workflows)) return null;
  return obj.workflows.filter((wf) => wf && typeof wf === 'object' && wf.version === 2 && !malformedSteps(wf));
}

/** Bytes used by this app in storage (keys starting with "sfdg."), UTF-16 like the browser counts. */
export function usedBytes(storage) {
  let n = 0;
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith('sfdg.')) n += (k.length + (storage.getItem(k)?.length ?? 0)) * 2;
  }
  return n;
}
