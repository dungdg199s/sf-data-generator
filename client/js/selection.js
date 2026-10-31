// Multi-select (design 0012 B), shared by both views: a "primary" step (state.selection.id: the
// inspector's step, the roving tab stop, what one-step keys act on) plus other steps
// (state.selection.ids, primary included; `anchor`: where a Shift range starts). Two kinds:
// a range of side-by-side steps in one sequence (Shift: wrap / move work), and scattered steps
// (Ctrl/⌘: delete / turn off / copy work). Selection changes are not undoable.
// Also: the narrow-screen select mode (body.select-mode, the .select-bar of select-bar.js) and
// the hidden live region that reads "Đã chọn 3 bước.".

import { state, select, subscribe, slotKeys, stepsById, locate } from './store.js';
import { normalizeSelection, rangeBetween, subtreeIds } from '/shared/workflow-tree.js';

// Lookups go through the id → step map of the workflow revision (store.stepsById), not a walk of
// the tree per card (0012 review).
const stepById = (id) => stepsById().get(id) ?? null;

/** Ids of the selected steps (the primary one included), as stored; [] when no step is selected. */
export function selectedIds() {
  const s = state.selection;
  if (s?.kind !== 'step' || !stepById(s.id)) return [];
  return s.ids?.length ? s.ids.filter((id) => stepById(id)) : [s.id];
}

const idSets = new WeakMap(); // selection object → Set of its ids (a selection is replaced, never mutated)

export const isMulti = () => selectedIds().length > 1;

/** Is the step `id` in the selection (primary or not)? */
export function isSelected(id) {
  const s = state.selection;
  if (s?.kind !== 'step') return false;
  if (s.id === id) return true;
  if (!s.ids) return false;
  let set = idSets.get(s);
  if (!set) idSets.set(s, (set = new Set(s.ids)));
  return set.has(id);
}

/**
 * The selection as group operations see it (shared normalizeSelection): reading order, steps
 * inside a selected frame dropped; `contiguous` when it is one block that can be wrapped / moved.
 */
export function selectionInfo() {
  return normalizeSelection(state.workflow, selectedIds(), slotKeys);
}

/** Select `ids` with `primary` (in `ids`) and `anchor`. One id: a plain selection. */
export function selectMany(ids, primary = ids[0], anchor = primary) {
  const list = [...new Set(ids)].filter((id) => stepById(id));
  if (!list.length) return select(null);
  if (!list.includes(primary)) primary = list[0];
  if (list.length === 1) return select({ kind: 'step', id: primary, anchor });
  return select({ kind: 'step', id: primary, ids: list, anchor });
}

/** Esc (first press while several are selected): keep only the primary step. */
export function collapseToPrimary() {
  const s = state.selection;
  if (s?.kind === 'step') select({ kind: 'step', id: s.id });
}

/**
 * Click on a card: plain = select one; Shift = range from the anchor (lifted to the nearest
 * common sequence); Ctrl/⌘ (or a tap in select mode) = add / remove that card.
 */
export function clickSelect(id, { range = false, toggle = false } = {}) {
  const s = state.selection;
  const current = s?.kind === 'step' && stepById(s.id) ? s : null;
  if (range && current) {
    const anchor = stepById(current.anchor) ? current.anchor : current.id;
    const ids = rangeBetween(state.workflow, anchor, id, slotKeys);
    // The clicked card may have been lifted to its ancestor in the common sequence.
    const primary = ids.find((x) => x === id || subtreeIds(stepById(x), slotKeys).has(id)) ?? id;
    return selectMany(ids, primary, anchor);
  }
  if (toggle && current) return toggleSelected(id);
  return select({ kind: 'step', id });
}

/**
 * Add `id` to the selection, or remove it. A frame and a step inside it: the step inside is
 * dropped (it goes with the frame). Removing the primary makes the last one left primary.
 */
export function toggleSelected(id) {
  const ids = selectedIds();
  if (ids.includes(id)) {
    const rest = ids.filter((x) => x !== id);
    if (!rest.length) return select(null);
    const s = state.selection;
    return selectMany(rest, rest.includes(s.id) ? s.id : rest.at(-1), rest.at(-1));
  }
  const all = normalizeSelection(state.workflow, [...ids, id], slotKeys).ids;
  // A step inside a selected frame is the frame's: the frame becomes primary. In the narrow select
  // mode the card it started from stays primary (Xong goes back to it).
  const added = all.includes(id) ? id : all.find((x) => subtreeIds(stepById(x), slotKeys).has(id));
  const keep = mode && all.includes(state.selection?.id) ? state.selection.id : null;
  return selectMany(all, keep ?? added, keep ?? added);
}

/**
 * Shift+↑ / Shift+↓: grow or shrink the range from the anchor, inside the anchor's sequence
 * (never into or out of a frame). At either end of the sequence: nothing. → true when it changed.
 */
export function extendBy(dir) {
  const s = state.selection;
  if (s?.kind !== 'step' || !stepById(s.id)) return false;
  const anchorAt = locate(stepById(s.anchor) ? s.anchor : s.id);
  const list = anchorAt.list;
  const at = (id) => list.findIndex((x) => x?.id === id);
  const from = at(s.id) >= 0 ? at(s.id) : anchorAt.index;
  let next = from + dir;
  while (next >= 0 && next < list.length && !list[next]?.id) next += dir; // skip broken entries
  if (next < 0 || next >= list.length) return false;
  const lo = Math.min(anchorAt.index, next);
  const hi = Math.max(anchorAt.index, next);
  selectMany(list.slice(lo, hi + 1).filter((x) => x?.id).map((x) => x.id), list[next].id, anchorAt.step.id);
  return true;
}

/** Ctrl+A in the tree: every step of the primary step's sequence. */
export function selectAllInSequence() {
  const s = state.selection;
  const at = s?.kind === 'step' ? locate(s.id) : null;
  const list = at ? at.list : state.workflow.steps ?? [];
  const ids = list.filter((x) => x?.id).map((x) => x.id);
  if (!ids.length) return;
  selectMany(ids, at ? s.id : ids[0], ids[0]);
}

// ---------- narrow-screen select mode ----------

let mode = false;
const modeListeners = new Set();
export const inSelectMode = () => mode;
export function onSelectMode(fn) {
  modeListeners.add(fn);
}

export function setSelectMode(on) {
  if (mode === on) return;
  mode = on;
  document.body.classList.toggle('select-mode', on);
  for (const fn of modeListeners) fn(on);
}

// ---------- "Đã chọn 3 bước." for screen readers ----------

let lastCount = 0;
export function initSelection() {
  subscribe(({ kind }) => {
    if (kind !== 'selection' && kind !== 'workflow' && kind !== 'all') return;
    const n = selectedIds().length;
    if (n !== lastCount && n > 1) {
      const live = document.getElementById('sel-live');
      if (live) live.textContent = `Đã chọn ${n} bước.`;
    }
    lastCount = n;
    // Select mode ends when nothing is selected any more.
    if (mode && n === 0) setSelectMode(false);
  });
}
