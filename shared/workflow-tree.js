// Tree operations on workflow JSON version 2 (design 0003). Shared by the server (Node) and
// the browser (served from /shared/), so it must stay pure: no DOM, no I/O, and only imports
// from shared/ (scope.js, for reference-aware renames: design 0005).
//
// A workflow is { version: 2, steps: [step…] }. A step is { id, type, config, slots?, disabled? };
// container steps (loop, branch) hold child sequences in `slots: { <key>: [step…] }`.
// The order of slot keys comes from the step-type catalogue: pass `slotKeys(type) → string[]`
// (server: nodeTypeMap, client: state.meta). Without it, the keys present on the step are used.
//
// An insertion point ("target") is { parentId: null | stepId, slot: null | key, index }:
// parentId null means the root sequence `wf.steps`.

import { analyzeScope, referenceOptions, refsToRecords, tokenize, stripPath, exposesOf, exposesList } from './scope.js';

const ownSlots = (step) => Object.keys(step?.slots ?? {});

export function slotKeysOf(step, slotKeys) {
  if (!slotKeys) return ownSlots(step);
  const declared = slotKeys(step.type) ?? [];
  return declared.length ? declared : ownSlots(step);
}

/** The child list of `step` for `key`; created (and attached) when `create` is true. */
export function slotList(step, key, create = false) {
  const list = step.slots?.[key];
  if (Array.isArray(list)) return list;
  if (!create) return [];
  step.slots ??= {};
  step.slots[key] = [];
  return step.slots[key];
}

/**
 * Visit every step in reading order (top to bottom, slots in declared order: Đúng before Sai).
 * `visit(step, info)` gets { depth, parent, slot, index, list, ancestors } and may return
 * false to skip the step's children.
 */
export function walkSteps(steps, visit, slotKeys, _parent = null, _slot = null, _depth = 0, _ancestors = []) {
  if (!Array.isArray(steps)) return;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || typeof step !== 'object') continue;
    const info = { depth: _depth, parent: _parent, slot: _slot, index, list: steps, ancestors: _ancestors };
    if (visit(step, info) === false) continue;
    if (!step.slots) continue;
    const anc = [..._ancestors, step];
    for (const key of slotKeysOf(step, slotKeys)) walkSteps(step.slots[key], visit, slotKeys, step, key, _depth + 1, anc);
  }
}

/**
 * Structural check before showing a workflow: every step must be a JSON object and every
 * `slots` an object of lists. → a Vietnamese message naming the first problem, or null.
 * Iterative, so a very deep file cannot overflow the stack.
 */
export function malformedSteps(wf) {
  if (!Array.isArray(wf?.steps)) return 'thiếu danh sách "steps"';
  const todo = [{ list: wf.steps, where: 'steps' }];
  while (todo.length) {
    const { list, where } = todo.pop();
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const at = `${where}[${i}]`;
      if (!step || typeof step !== 'object' || Array.isArray(step)) return `${at} không phải một bước (object JSON)`;
      if (step.slots === undefined) continue;
      if (!step.slots || typeof step.slots !== 'object' || Array.isArray(step.slots)) return `"slots" của bước "${step.id ?? at}" không phải object`;
      for (const [key, children] of Object.entries(step.slots)) {
        if (!Array.isArray(children)) return `"slots.${key}" của bước "${step.id ?? at}" không phải danh sách`;
        todo.push({ list: children, where: `${at}.slots.${key}` });
      }
    }
  }
  return null;
}

/** Steps in reading order, flattened. */
export function allSteps(wf, slotKeys) {
  const out = [];
  walkSteps(wf?.steps, (s) => { out.push(s); }, slotKeys);
  return out;
}

/** → { step, parentId, slot, index, depth, ancestors, list } or null. */
export function findStep(wf, id, slotKeys) {
  let found = null;
  walkSteps(wf?.steps, (step, info) => {
    if (found) return false;
    if (step.id === id) {
      found = { step, parentId: info.parent?.id ?? null, slot: info.slot, index: info.index, depth: info.depth, ancestors: info.ancestors, list: info.list };
      return false;
    }
    return true;
  }, slotKeys);
  return found;
}

/** The list a target points into (created when missing), or null if the parent is gone. */
export function targetList(wf, target) {
  if (!target?.parentId) {
    wf.steps ??= [];
    return wf.steps;
  }
  const parent = findStep(wf, target.parentId)?.step;
  if (!parent) return null;
  return slotList(parent, target.slot, true);
}

export function insertStep(wf, target, step) {
  const list = targetList(wf, target);
  if (!list) return false;
  const index = Math.max(0, Math.min(target.index ?? list.length, list.length));
  list.splice(index, 0, step);
  return true;
}

/** Ids of `step` and every step inside it. */
export function subtreeIds(step, slotKeys) {
  const ids = new Set([step.id]);
  walkSteps(Object.values(step.slots ?? {}).flat(), (s) => { ids.add(s.id); }, slotKeys);
  return ids;
}

/**
 * Remove a step. With keepChildren, its children (all slots, in order) take its place
 * ("Bỏ vỏ"). Returns the removed step, or null.
 */
export function removeStep(wf, id, { keepChildren = false, slotKeys } = {}) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return null;
  const children = keepChildren ? slotKeysOf(at.step, slotKeys).flatMap((k) => slotList(at.step, k)) : [];
  at.list.splice(at.index, 1, ...children);
  return at.step;
}

/**
 * Move a step to `target`, expressed in the tree as it is *before* the move (what the user
 * sees when dropping). Moving into its own subtree is refused. Returns true when moved.
 */
export function moveStep(wf, id, target, slotKeys) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return false;
  if (target.parentId && subtreeIds(at.step, slotKeys).has(target.parentId)) return false;
  const sameList = (target.parentId ?? null) === at.parentId && (target.parentId ? target.slot === at.slot : true);
  let index = target.index ?? Infinity;
  if (sameList) {
    if (index === at.index || index === at.index + 1) return false; // already there
    if (index > at.index) index--;
  }
  at.list.splice(at.index, 1);
  return insertStep(wf, { parentId: target.parentId ?? null, slot: target.slot ?? null, index }, at.step);
}

/**
 * Replace a step by `container` (a loop/branch step) holding it in its first slot
 * (or `slot` if given). Returns the container.
 */
export function wrapStep(wf, id, container, { slot, slotKeys } = {}) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return null;
  const key = slot ?? slotKeysOf(container, slotKeys)[0];
  container.slots ??= {};
  for (const k of slotKeysOf(container, slotKeys)) container.slots[k] ??= [];
  container.slots[key] = [at.step];
  at.list.splice(at.index, 1, container);
  return container;
}

// ---------- ids and aliases ----------

export function collectIds(wf) {
  const ids = new Set();
  walkSteps(wf?.steps, (s) => { if (s.id) ids.add(s.id); });
  return ids;
}

/**
 * Step types whose `alias` names a record or pool other steps reference — one namespace — read
 * from the catalogue ({ nodeTypes }, as in /api/meta): every type whose `exposes` is a record
 * named by `alias` (Record; Query and Chọn bản ghi of design 0006). Without a catalogue (v1
 * migration, which only knows Record): `record`.
 */
export function aliasTypes(catalog) {
  const types = catalog?.nodeTypes instanceof Map ? [...catalog.nodeTypes.values()] : catalog?.nodeTypes;
  if (!Array.isArray(types)) return new Set(['record']);
  return new Set(types.filter((t) => t.exposes?.kind === 'record' && t.exposes?.name?.key === 'alias').map((t) => t.type));
}

const catalogType = (catalog, type) => (catalog?.nodeTypes instanceof Map ? catalog.nodeTypes.get(type) : catalog?.nodeTypes?.find?.((t) => t.type === type));

/**
 * The names `step` gives in the alias namespace (one namespace, unique across the tree):
 * [{ key, value }] for every config key naming a record or pool in its `exposes` entries in
 * effect — `alias` of Record, Query, Chọn bản ghi; `itemAlias` of a Lặp `each` (design 0010).
 * Without a catalogue (v1 migration): a Record's `alias`.
 */
export function stepNames(step, catalog) {
  const c = step?.config ?? {};
  if (!Array.isArray(catalog?.nodeTypes) && !(catalog?.nodeTypes instanceof Map)) {
    return step?.type === 'record' && c.alias ? [{ key: 'alias', value: c.alias }] : [];
  }
  const out = [];
  for (const { ex } of exposesOf(catalogType(catalog, step?.type), c)) {
    const key = ex.kind === 'record' ? ex.name?.key : null;
    if (key && c[key]) out.push({ key, value: c[key] });
  }
  return out;
}

/** Aliases of record / pool steps and records looped over (the names other steps reference). */
export function collectAliases(wf, catalog) {
  const out = new Set();
  walkSteps(wf?.steps, (s) => { for (const e of stepNames(s, catalog)) out.add(e.value); });
  return out;
}

/** `con` → `con2`, `con2` → `con3`, … first one not in `taken`. */
export function nextName(name, taken, sep = '') {
  const base = String(name).replace(/\d+$/, '') || String(name);
  for (let i = 2; ; i++) {
    const candidate = `${base}${sep}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `acc` → `acc_2`, `acc_2` → `acc_3`, … first id not in `taken`. */
export function nextId(id, taken) {
  const base = String(id).replace(/_\d+$/, '');
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A usable alias / loop variable name (same rule as server/workflow/schema.js). */
export const isAliasName = (name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'this';

/**
 * Options holding references, without a catalogue: the built-in ones (template, ref, branch
 * left / right, pick and each-loop from / filterValue, loop counts holding a variable).
 */
function legacyReferenceOptions(step) {
  const out = [];
  (step.config?.fields ?? []).forEach((f, fieldIndex) => {
    if (!f?.options) return;
    for (const [key, mode] of [['template', 'template'], ['ref', 'ref']]) {
      if (typeof f.options[key] === 'string') out.push({ field: `fields.${f.name}`, option: key, mode, stored: f.options[key], fieldIndex, set: (v) => { f.options[key] = v; } });
    }
  });
  const keys = [];
  if (step.type === 'branch') keys.push(['left', 'path'], ['right', 'template']);
  if (step.type === 'pick') keys.push(['from', 'ref'], ['filterValue', 'template']);
  if (step.type === 'loop') {
    // Design 0013: counts may hold one {{path}}; an each loop has a filter value.
    keys.push(['count', 'number'], ['min', 'number'], ['max', 'number']);
    if (step.config?.mode === 'each') keys.push(['from', 'ref'], ['filterValue', 'template']);
  }
  for (const [key, mode] of keys) {
    if (typeof step.config?.[key] === 'string') out.push({ field: key, option: key, mode, value: step.config[key], set: (v) => { step.config[key] = v; } });
  }
  return out;
}

/** Stored value of a reference option (a field option left at its default is not stored). */
const storedValue = (o) => (o.fieldIndex !== undefined ? o.stored : o.value);

/** Rename the head `from` of every reference in one option value. → [newValue, count] */
export function renameInValue(mode, value, from, to) {
  if (typeof value !== 'string') return [value, 0];
  if (mode === 'ref') return value === from ? [to, 1] : [value, 0];
  if (mode === 'path') {
    const path = stripPath(value);
    if (path !== from && !path.startsWith(`${from}.`)) return [value, 0];
    const i = value.indexOf(from);
    return [value.slice(0, i) + to + value.slice(i + from.length), 1];
  }
  let count = 0;
  const out = tokenize(value).map((p) => {
    if (p.kind !== 'token' || (p.path !== from && !p.path.startsWith(`${from}.`))) return p.text;
    count++;
    return p.text.replace(from, to); // the path is the first word inside the braces
  }).join('');
  return [out, count];
}

/**
 * Rename a record alias (or a loop variable) inside `steps`: every option holding references
 * (with `catalog` = { nodeTypes, fieldTypes }: options declaring `vars` or `kind: 'ref'`;
 * without it: the built-in options of legacyReferenceOptions). `only` (Set of "stepId|field|option")
 * limits the rename to those options, e.g. the references that resolve to one loop.
 * Returns the number of references changed.
 */
export function renameAlias(steps, from, to, { catalog, only } = {}) {
  if (!from || from === to || !isAliasName(to)) return 0; // never move references to an unusable name
  let count = 0;
  walkSteps(steps, (s) => {
    const options = catalog ? referenceOptions(s, catalog, { includeHidden: true }) : legacyReferenceOptions(s);
    for (const o of options) {
      if (only && !only.has(`${s.id}|${o.field}|${o.option}`)) continue;
      const [next, n] = renameInValue(o.mode, storedValue(o), from, to);
      if (!n) continue;
      o.set(next);
      count += n;
    }
  });
  return count;
}

/**
 * After renaming field `from` → `to` of step `stepId`: update `{{<alias>.from}}` everywhere,
 * `{{this.from}}` in the same step and branch `left` paths, using the scope analysis (only
 * references that resolve to this step, directly or through a Chọn bản ghi / the record of a
 * Lặp `each` whose records come from it). Returns { count, places: [{ nodeId, field }], names }
 * (`names`: the prefixes whose references changed, e.g. ['acc', 'this']).
 */
export function renameField(wf, stepId, from, to, { catalog } = {}) {
  const none = { count: 0, places: [], names: [] };
  if (!from || !to || from === to || !catalog) return none;
  const scope = analyzeScope(wf, catalog);
  // Also through a Chọn bản ghi from its pool and the record a Lặp `each` loops over (0010 review).
  const refs = refsToRecords(scope, stepId, from, { includeHidden: true }).filter((r) => r.mode !== 'ref');
  if (!refs.length) return none;
  let count = 0;
  const places = [];
  const changedNames = new Set();
  const steps = new Map();
  walkSteps(wf.steps, (s) => { steps.set(s.id, s); });
  const byOption = new Map();
  for (const r of refs) {
    const key = `${r.nodeId}|${r.field}|${r.option}`;
    if (!byOption.has(key)) byOption.set(key, { r, names: new Set() });
    byOption.get(key).names.add(r.name);
  }
  for (const { r, names } of byOption.values()) {
    const o = referenceOptions(steps.get(r.nodeId), catalog, { includeHidden: true }).find((x) => x.field === r.field && x.option === r.option);
    let value = o ? storedValue(o) : undefined;
    if (typeof value !== 'string') continue;
    let changed = 0;
    for (const name of names) {
      const [next, n] = renameInValue(o.mode, value, `${name}.${from}`, `${name}.${to}`);
      value = next;
      changed += n;
      if (n) changedNames.add(name);
    }
    if (!changed) continue;
    o.set(value);
    count += changed;
    places.push({ nodeId: r.nodeId, field: r.field });
  }
  return { count, places, names: [...changedNames] };
}

/**
 * Set the alias of a record step, or the variable of a loop step (empty = "loop"), to `value`
 * while the user types, and move references along — but only to a name that is valid and not
 * used by another step. While the field is empty, invalid or equal to another name (mid-typing),
 * references stay on the last good name, remembered in `memo` (Map stepId → name), and follow
 * again once the name is good. Record references are renamed in the whole workflow, loop
 * variables only inside the loop body — and, with `catalog`, only where they resolve to this
 * loop (not inside a nested loop of the same name). A record without alias is referenced by its
 * id; the first alias set moves those references. Returns true when references were moved.
 * `key` (default 'alias'): the config key holding the name — 'itemAlias' for the record a Lặp
 * `each` loops over (design 0010), renamed like a loop variable: inside the body, only the
 * references to that record.
 */
export function setStepAlias(wf, id, value, { memo = new Map(), slotKeys, catalog, scope, key = 'alias' } = {}) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return false;
  const step = at.step;
  const c = (step.config ??= {});
  const isLoop = step.type === 'loop' && key === 'alias';
  const entries = exposesList(catalog ? catalogType(catalog, step.type) : null);
  const index = entries.findIndex((ex) => ex.name?.key === key);
  const entry = entries[index];
  // Names visible inside a slot only (loop variable, record looped over) rename inside it.
  const inside = entry?.visibleIn?.inside ?? (isLoop ? 'body' : null);
  const sourceId = index > 0 ? `${id}#${entry.key ?? index}` : id;
  const memoKey = key === 'alias' ? id : `${id}#${key}`;
  const effective = (v) => (isLoop ? v || 'loop' : v);
  const good = (name) => isAliasName(name) && !aliasTaken(wf, at, name, slotKeys, catalog, key);
  // References can follow from the current name when it is unambiguous. A loop variable that
  // shadows an enclosing one still owns the references inside its body.
  const owns = (name) => isAliasName(name) && (isLoop || !aliasTaken(wf, at, name, slotKeys, catalog, key));
  const current = effective(c[key]);
  if (good(current) || (!memo.has(memoKey) && owns(current))) memo.set(memoKey, current);
  // A record without alias is referenced by its id (like the executor): the first alias takes them along.
  const byId = key === 'alias' && (catalog ? entries[0]?.name?.fallback === 'id' : step.type === 'record');
  if (byId && !c.alias && !memo.has(memoKey) && owns(String(step.id))) memo.set(memoKey, String(step.id));
  const from = memo.get(memoKey);
  const to = effective(value);
  if (!from || from === to || !good(to) || !owns(from)) {
    c[key] = value;
    return false;
  }
  let only;
  if (inside && catalog) {
    // Only the references that resolve to this loop / record (not those of a shadowing inner
    // loop), including options hidden by showIf. `scope` (analysis of `wf` as it is) saves a
    // second analysis when the step still has the name the references use.
    const reuse = scope && effective(c[key]) === from;
    const saved = c[key];
    c[key] = from;
    const refs = (reuse ? scope : analyzeScope(wf, catalog)).refs;
    c[key] = saved;
    only = new Set(refs.filter((r) => r.source === sourceId).map((r) => `${r.nodeId}|${r.field}|${r.option}`));
  }
  c[key] = value;
  renameAlias(inside ? step.slots?.[inside] ?? [] : wf.steps, from, to, { catalog, only });
  memo.set(memoKey, to);
  return true;
}

/**
 * Is `name` used by another step in a way that clashes with the name `key` of step `at` (from
 * findStep)? Record / pool alias or record looped over: another such name or any loop variable.
 * Loop variable: a record alias, or the variable of an enclosing loop or of a loop inside this
 * one (shadowing).
 */
function aliasTaken(wf, at, name, slotKeys, catalog, key = 'alias') {
  const self = at.step;
  const selfVar = self.type === 'loop' && key === 'alias';
  let taken = false;
  walkSteps(wf.steps, (s) => {
    if (taken) return false;
    if (stepNames(s, catalog).some((e) => e.value === name && !(s === self && e.key === key))) taken = true;
    else if (s.type === 'loop' && !selfVar && (s.config?.alias || 'loop') === name) taken = true;
    return !taken;
  }, slotKeys);
  if (taken || !selfVar) return taken;
  const nested = [];
  walkSteps(Object.values(self.slots ?? {}).flat(), (s) => { if (s.type === 'loop') nested.push(s); }, slotKeys);
  return [...at.ancestors, ...nested].some((s) => s.type === 'loop' && (s.config?.alias || 'loop') === name);
}

/**
 * Deep-copy steps with new ids, and new names for every record alias (and record looped over)
 * defined inside the copy; references *inside the copy* follow the rename. `ids` and `aliases`
 * (Sets) are the names already taken and are updated. `keepFree` (paste, design 0012 B): a name
 * not in `aliases` is kept; only a taken one gets the next free name.
 * Returns { steps, renamed: [{ id, copyId, alias, newAlias, names? }] } (`names`: other renamed
 * keys, [{ key, from, to }]).
 */
export function cloneSteps(steps, { ids = new Set(), aliases = new Set(), makeId = nextId, catalog, keepFree = false } = {}) {
  const copy = structuredClone(steps);
  const renamed = [];
  const aliasMap = new Map();
  // A new name is never one of the copy's own names: the renames below run one after the other,
  // so `acc → acc2` then `acc2 → acc3` would send the references to `acc` on to `acc3` (0012 review).
  const originals = new Set();
  // Loop variables inside the copy count too: `item → item2` must not land on a copied loop's `item2`.
  walkSteps(copy, (s) => {
    for (const { value } of stepNames(s, catalog)) originals.add(value);
    if (s.type === 'loop') originals.add(s.config?.alias || 'loop');
  });
  walkSteps(copy, (s) => {
    const entry = { id: s.id, copyId: makeId(s.id, ids) };
    ids.add(entry.copyId);
    s.id = entry.copyId;
    for (const { key, value } of stepNames(s, catalog)) {
      const next = keepFree && !aliases.has(value) ? value : nextName(value, new Set([...aliases, ...originals]));
      aliases.add(next);
      if (next !== value) aliasMap.set(value, next);
      if (key === 'alias') {
        entry.alias = value;
        entry.newAlias = next;
      } else (entry.names ??= []).push({ key, from: value, to: next });
      s.config[key] = next;
    }
    renamed.push(entry);
  });
  for (const [from, to] of aliasMap) renameAlias(copy, from, to, { catalog });
  return { steps: copy, renamed };
}

// ---------- insertion targets ----------

/**
 * Where a new step goes when the user clicks a palette item (design 0003, "Quy tắc chèn mặc
 * định"): nothing selected → end of the root sequence; a container with an empty slot → the
 * first empty slot in declared order; otherwise → right after the selected step.
 */
export function defaultInsertTarget(wf, selectedId, slotKeys) {
  const at = selectedId ? findStep(wf, selectedId, slotKeys) : null;
  if (!at) return { parentId: null, slot: null, index: wf?.steps?.length ?? 0 };
  const empty = slotKeysOf(at.step, slotKeys).find((k) => !slotList(at.step, k).length);
  if (empty !== undefined) return { parentId: at.step.id, slot: empty, index: 0 };
  return { parentId: at.parentId, slot: at.slot, index: at.index + 1 };
}

/**
 * Every insertion point in reading order. Points inside `skip` steps (collapsed containers,
 * the step being moved) are left out.
 */
export function insertionPoints(wf, { slotKeys, skip = () => false } = {}) {
  const out = [];
  const visitList = (list, parentId, slot) => {
    for (let i = 0; i <= list.length; i++) {
      out.push({ parentId, slot, index: i });
      const step = list[i];
      if (!step || skip(step)) continue;
      for (const key of slotKeysOf(step, slotKeys)) visitList(slotList(step, key), step.id, key);
    }
  };
  visitList(wf?.steps ?? [], null, null);
  return out;
}

/**
 * Target for Alt+↑ (dir -1) / Alt+↓ (dir +1): the previous/next insertion point in reading
 * order, entering and leaving open containers; collapsed ones (ids in `collapsed`) are
 * jumped over like a plain step. The result is in before-move coordinates (for moveStep),
 * or null at the very top/bottom.
 */
export function neighbourTarget(wf, id, dir, collapsed = new Set(), slotKeys) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return null;
  // Work on the tree without the step, where its old spot is a single insertion point.
  const without = structuredClone(wf);
  removeStep(without, id, { slotKeys });
  const points = insertionPoints(without, { slotKeys, skip: (s) => collapsed.has(s.id) });
  const same = (p) => p.parentId === at.parentId && (p.parentId ? p.slot === at.slot : true);
  const here = points.findIndex((p) => same(p) && p.index === at.index);
  const next = points[here + dir];
  if (here < 0 || !next) return null;
  // Back to before-move coordinates: later points in the same list shift by one.
  return same(next) && next.index >= at.index ? { ...next, index: next.index + 1 } : next;
}

// ---------- groups of steps (design 0012 B: multi-select, copy / paste) ----------

const isStepObject = (s) => s && typeof s === 'object' && !Array.isArray(s);

/** id → { step, parentId, slot, index, list, ancestors } of every step, in one walk. */
function placesOf(wf, slotKeys) {
  const map = new Map();
  walkSteps(wf?.steps, (step, info) => {
    if (step.id !== undefined && !map.has(step.id)) {
      map.set(step.id, { step, parentId: info.parent?.id ?? null, slot: info.slot, index: info.index, list: info.list, ancestors: info.ancestors });
    }
  }, slotKeys);
  return map;
}

/**
 * The selection `ids` as group operations see it: the steps that exist, in reading order, without
 * the steps inside a selected container (they go with it). → { ids, contiguous, parentId, slot,
 * start, end, list }: `contiguous` when every step sits side by side in one sequence (a block that
 * can be wrapped or moved as one); the other keys then describe that block (start / end: indexes
 * in `list`, the sequence itself).
 */
export function normalizeSelection(wf, ids, slotKeys) {
  const want = new Set(ids ?? []);
  const out = [];
  walkSteps(wf?.steps, (step) => {
    if (!want.has(step.id)) return true;
    out.push(step.id);
    return false; // the steps inside go with it
  }, slotKeys);
  const result = { ids: out, contiguous: false, parentId: null, slot: null, start: -1, end: -1, list: null };
  if (!out.length) return result;
  const places = placesOf(wf, slotKeys);
  const first = places.get(out[0]);
  const all = out.map((id) => places.get(id));
  const contiguous = all.every((p, i) => p.list === first.list && p.index === first.index + i);
  return contiguous
    ? { ...result, contiguous, parentId: first.parentId, slot: first.slot, start: first.index, end: first.index + out.length - 1, list: first.list }
    : result;
}

/**
 * Shift+click range (design 0012 B): the steps from `anchorId` to `id` in their nearest common
 * sequence. Both ends are first lifted to their ancestor in that sequence, so the range is always a
 * block (anchor `con` in a loop body, Shift+click `opp` at the root ⇒ the loop … `opp`). → ids in
 * reading order ([id] when the anchor is gone).
 */
export function rangeBetween(wf, anchorId, id, slotKeys) {
  const places = placesOf(wf, slotKeys);
  const a = places.get(anchorId);
  const b = places.get(id);
  if (!b) return [];
  if (!a) return [id];
  const chain = (p) => [...p.ancestors.map((s) => places.get(s.id)), p];
  const ca = chain(a);
  const cb = chain(b);
  let d = 0; // both chains start in wf.steps
  while (d + 1 < ca.length && d + 1 < cb.length && ca[d + 1].list === cb[d + 1].list) d++;
  const lo = Math.min(ca[d].index, cb[d].index);
  const hi = Math.max(ca[d].index, cb[d].index);
  return ca[d].list.slice(lo, hi + 1).filter(isStepObject).map((s) => s.id);
}

/**
 * Replace a block of steps (normalizeSelection: contiguous) by `container`, holding them in its
 * first slot (or `slot`), in order. → the container, or null when `ids` is not one block.
 */
export function wrapSteps(wf, ids, container, { slot, slotKeys } = {}) {
  const sel = normalizeSelection(wf, ids, slotKeys);
  if (!sel.contiguous) return null;
  const key = slot ?? slotKeysOf(container, slotKeys)[0];
  container.slots ??= {};
  for (const k of slotKeysOf(container, slotKeys)) container.slots[k] ??= [];
  container.slots[key] = sel.list.slice(sel.start, sel.end + 1);
  sel.list.splice(sel.start, sel.end - sel.start + 1, container);
  return container;
}

/** Remove every selected step (with what is inside it). → the removed steps, in reading order. */
export function removeSteps(wf, ids, { slotKeys } = {}) {
  const { ids: order } = normalizeSelection(wf, ids, slotKeys);
  return order.map((id) => removeStep(wf, id, { slotKeys })).filter(Boolean);
}

/**
 * Move a block of steps to `target`, expressed in the tree before the move (like moveStep).
 * Refused (false) when `ids` is not one block, the target is inside the block, or the block is
 * already there.
 */
export function moveBlock(wf, ids, target, slotKeys) {
  const sel = normalizeSelection(wf, ids, slotKeys);
  if (!sel.contiguous) return false;
  const block = sel.list.slice(sel.start, sel.end + 1);
  if (target.parentId && block.some((s) => subtreeIds(s, slotKeys).has(target.parentId))) return false;
  const list = targetList(wf, target);
  if (!list) return false;
  let index = Math.max(0, Math.min(target.index ?? list.length, list.length));
  if (list === sel.list) {
    if (index >= sel.start && index <= sel.end + 1) return false; // already there
    if (index > sel.end) index -= block.length;
  }
  sel.list.splice(sel.start, block.length);
  list.splice(index, 0, ...block);
  return true;
}

/**
 * Alt+↑ / Alt+↓ for a block (neighbourTarget for several steps): the previous / next insertion
 * point in reading order, entering and leaving open containers, jumping over collapsed ones.
 * Before-move coordinates (for moveBlock), or null at the very top / bottom or when `ids` is not
 * one block.
 */
export function neighbourTargetBlock(wf, ids, dir, collapsed = new Set(), slotKeys) {
  const sel = normalizeSelection(wf, ids, slotKeys);
  if (!sel.contiguous) return null;
  const size = sel.end - sel.start + 1;
  const without = structuredClone(wf);
  removeSteps(without, sel.ids, { slotKeys });
  const points = insertionPoints(without, { slotKeys, skip: (s) => collapsed.has(s.id) });
  const same = (p) => p.parentId === sel.parentId && (p.parentId ? p.slot === sel.slot : true);
  const here = points.findIndex((p) => same(p) && p.index === sel.start);
  const next = points[here + dir];
  if (here < 0 || !next) return null;
  return same(next) && next.index >= sel.start ? { ...next, index: next.index + size } : next;
}

/** Loop variables of the loops that enclose a step inserted at `target` (paste, Ctrl+D). */
export function loopVarsAround(wf, target, slotKeys) {
  if (!target?.parentId) return new Set();
  const at = findStep(wf, target.parentId, slotKeys);
  if (!at) return new Set();
  return new Set([...at.ancestors, at.step].filter((s) => s.type === 'loop').map((s) => s.config?.alias || 'loop'));
}

/**
 * Paste copied steps at `target` (design 0012 B). Ids are always new; record / pool aliases (and
 * the record a Lặp `each` loops over) keep their name when it is free in `wf`, a taken one gets
 * the next free name and the references inside the pasted steps follow (cloneSteps keepFree). A
 * pasted loop's variable is renamed when it would shadow a loop enclosing the target or equals a
 * record alias (references inside its body follow). References to steps outside the paste keep
 * their text. Mutates `wf`. → { ids: top-level pasted ids, renamed: [{ from, to }], missing:
 * names referenced by the pasted steps that do not exist here, missingRefs: how many such
 * references (both with a catalogue) }.
 */
export function pasteSteps(wf, target, steps, { catalog, slotKeys } = {}) {
  const list = targetList(wf, target);
  if (!list) return null;
  // A pasted record must not take the name of a loop variable around the target either.
  const around = loopVarsAround(wf, target, slotKeys);
  const { steps: copy, renamed } = cloneSteps(steps, { ids: collectIds(wf), aliases: new Set([...collectAliases(wf, catalog), ...around]), catalog, keepFree: true });
  const changes = [];
  for (const e of renamed) {
    if (e.alias !== undefined && e.alias !== e.newAlias) changes.push({ from: e.alias, to: e.newAlias });
    for (const n of e.names ?? []) if (n.from !== n.to) changes.push({ from: n.from, to: n.to });
  }
  // Loop variables: no shadowing of an enclosing loop, no clash with a record name.
  const temp = { version: 2, steps: copy };
  const loops = [];
  walkSteps(copy, (s) => { if (s.type === 'loop') loops.push(s); }, slotKeys);
  const taken = new Set([...around, ...collectAliases({ steps: [...(wf.steps ?? []), ...copy] }, catalog)]);
  walkSteps([...(wf.steps ?? []), ...copy], (s) => { if (s.type === 'loop') taken.add(s.config?.alias || 'loop'); }, slotKeys);
  const names = collectAliases({ steps: [...(wf.steps ?? []), ...copy] }, catalog);
  for (const loopStep of loops) {
    const name = loopStep.config?.alias || 'loop';
    if (!around.has(name) && !names.has(name)) continue;
    const to = nextName(name, taken);
    taken.add(to);
    setStepAlias(temp, loopStep.id, to, { slotKeys, catalog });
    changes.push({ from: name, to });
  }
  const index = Math.max(0, Math.min(target.index ?? list.length, list.length));
  list.splice(index, 0, ...copy);
  let broken = [];
  if (catalog?.nodeTypes) {
    const inside = new Set();
    walkSteps(copy, (s) => { inside.add(s.id); }, slotKeys);
    broken = analyzeScope(wf, catalog).refs.filter((r) => inside.has(r.nodeId) && r.code === 'unknownName' && !r.hidden);
  }
  return { ids: copy.map((s) => s.id), renamed: changes, missing: [...new Set(broken.map((r) => r.name))], missingRefs: broken.length };
}

/** Number of steps in `steps`, everything inside included. Stops counting past `max`. */
export function countSteps(steps, max = Infinity) {
  let n = 0;
  const todo = [steps];
  while (todo.length && n <= max) {
    const list = todo.pop();
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      n++;
      if (isStepObject(s) && s.slots && typeof s.slots === 'object') for (const v of Object.values(s.slots)) todo.push(v);
    }
  }
  return n;
}
