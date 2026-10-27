// Tree operations on workflow JSON version 2 (design 0003). Shared by the server (Node) and
// the browser (served from /shared/), so it must stay pure: no DOM, no I/O, no imports.
//
// A workflow is { version: 2, steps: [step…] }. A step is { id, type, config, slots?, disabled? };
// container steps (loop, branch) hold child sequences in `slots: { <key>: [step…] }`.
// The order of slot keys comes from the step-type catalogue: pass `slotKeys(type) → string[]`
// (server: nodeTypeMap, client: state.meta). Without it, the keys present on the step are used.
//
// An insertion point ("target") is { parentId: null | stepId, slot: null | key, index }:
// parentId null means the root sequence `wf.steps`.

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

/** Aliases of record steps (the names other steps reference). */
export function collectAliases(wf) {
  const out = new Set();
  walkSteps(wf?.steps, (s) => { if (s.type === 'record' && s.config?.alias) out.add(s.config.alias); });
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

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A usable alias / loop variable name (same rule as server/workflow/schema.js). */
export const isAliasName = (name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'this';

/**
 * Rename a record alias (or a loop variable) inside `steps`: Lookup `ref`, `{{from.` in
 * templates and `from.` at the start of a branch `left`. Pass the loop body to rename a loop
 * variable only where it is visible.
 */
export function renameAlias(steps, from, to) {
  if (!from || from === to || !isAliasName(to)) return; // never move references to an unusable name
  const re = new RegExp(`\\{\\{(\\s*)${escapeRe(from)}\\.`, 'g');
  walkSteps(steps, (s) => {
    for (const f of s.config?.fields ?? []) {
      if (!f?.options) continue;
      if (f.options.ref === from) f.options.ref = to;
      if (typeof f.options.template === 'string') f.options.template = f.options.template.replace(re, `{{$1${to}.`);
    }
    if (s.type === 'branch' && typeof s.config?.left === 'string' && s.config.left.startsWith(`${from}.`)) {
      s.config.left = to + s.config.left.slice(from.length);
    }
  });
}

/**
 * Set the alias of a record step, or the variable of a loop step (empty = "loop"), to `value`
 * while the user types, and move references along — but only to a name that is valid and not
 * used by another step. While the field is empty, invalid or equal to another name (mid-typing),
 * references stay on the last good name, remembered in `memo` (Map stepId → name), and follow
 * again once the name is good. Record references are renamed in the whole workflow, loop
 * variables only inside the loop body. Returns true when references were moved.
 */
export function setStepAlias(wf, id, value, { memo = new Map(), slotKeys } = {}) {
  const at = findStep(wf, id, slotKeys);
  if (!at) return false;
  const step = at.step;
  const c = (step.config ??= {});
  const isLoop = step.type === 'loop';
  const effective = (v) => (isLoop ? v || 'loop' : v);
  const good = (name) => isAliasName(name) && !aliasTaken(wf, at, name, slotKeys);
  // References can follow from the current name when it is unambiguous. A loop variable that
  // shadows an enclosing one still owns the references inside its body.
  const owns = (name) => isAliasName(name) && (isLoop || !aliasTaken(wf, at, name, slotKeys));
  const current = effective(c.alias);
  if (good(current) || (!memo.has(id) && owns(current))) memo.set(id, current);
  const from = memo.get(id);
  const to = effective(value);
  c.alias = value;
  if (!from || from === to || !good(to) || !owns(from)) return false;
  renameAlias(isLoop ? step.slots?.body ?? [] : wf.steps, from, to);
  memo.set(id, to);
  return true;
}

/**
 * Is `name` used by another step in a way that clashes with step `at` (from findStep)?
 * Record alias: another record alias or any loop variable. Loop variable: a record alias, or
 * the variable of an enclosing loop or of a loop inside this one (shadowing).
 */
function aliasTaken(wf, at, name, slotKeys) {
  const self = at.step;
  let taken = false;
  walkSteps(wf.steps, (s) => {
    if (taken || s === self) return !taken;
    if (s.type === 'record' && s.config?.alias === name) taken = true;
    else if (s.type === 'loop' && self.type === 'record' && (s.config?.alias || 'loop') === name) taken = true;
    return !taken;
  }, slotKeys);
  if (taken || self.type !== 'loop') return taken;
  const nested = [];
  walkSteps(Object.values(self.slots ?? {}).flat(), (s) => { if (s.type === 'loop') nested.push(s); }, slotKeys);
  return [...at.ancestors, ...nested].some((s) => s.type === 'loop' && (s.config?.alias || 'loop') === name);
}

/**
 * Deep-copy steps with new ids, and new aliases for every record alias defined inside the
 * copy; references *inside the copy* follow the rename. `ids` and `aliases` (Sets) are the
 * names already taken and are updated. Returns { steps, renamed: [{ id, copyId, alias, newAlias }] }.
 */
export function cloneSteps(steps, { ids = new Set(), aliases = new Set(), makeId = nextId } = {}) {
  const copy = structuredClone(steps);
  const renamed = [];
  const aliasMap = new Map();
  walkSteps(copy, (s) => {
    const entry = { id: s.id, copyId: makeId(s.id, ids) };
    ids.add(entry.copyId);
    s.id = entry.copyId;
    if (s.type === 'record' && s.config?.alias) {
      const next = nextName(s.config.alias, aliases);
      aliases.add(next);
      aliasMap.set(s.config.alias, next);
      entry.alias = s.config.alias;
      entry.newAlias = next;
      s.config.alias = next;
    }
    renamed.push(entry);
  });
  for (const [from, to] of aliasMap) renameAlias(copy, from, to);
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
