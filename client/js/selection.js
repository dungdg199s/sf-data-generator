// Several selected steps (design 0012 B), shared by both views. The selection in the store is
// `{ kind: 'step', id, ids?, anchor? }`: `id` is the main step (focus, inspector, the keys of
// one step: its meaning of before), `ids` the whole selection when there are several, `anchor`
// where Shift ranges start. Two kinds of selection:
//   run    Shift: neighbours of one sequence (lifted to the nearest common sequence), so it can
//          always be wrapped or moved;
//   loose  Ctrl/⌘: any steps; a step inside a selected frame is dropped (it is in it already).
// Selection changes are not undo steps.

import { state, select, slotKeys, locate, stepById } from './store.js';
import { normalizeSelection, rangeBetween } from '/shared/workflow-tree.js';

const current = () => (state.selection?.kind === 'step' && stepById(state.selection.id) ? state.selection : null);

/** Every selected step id in reading order (normalized), [] when none. */
export function selectedIds() {
  const s = current();
  if (!s) return [];
  const ids = s.ids?.length ? s.ids : [s.id];
  return normalizeSelection(state.workflow, ids, slotKeys).ids;
}

/** normalizeSelection of the current selection: { ids, contiguous, parentId, slot, index }. */
export function selectionInfo() {
  return normalizeSelection(state.workflow, selectedIds(), slotKeys);
}

export const isMulti = () => selectedIds().length > 1;

/** Select steps `ids` with `id` as the main one (one id: an ordinary selection). */
export function selectMany(ids, id = ids[0], anchor = state.selection?.anchor ?? id) {
  const list = normalizeSelection(state.workflow, ids, slotKeys).ids;
  if (!list.length) return select(null);
  const main = list.includes(id) ? id : list[0];
  if (list.length === 1) return select({ kind: 'step', id: main, anchor: main });
  return select({ kind: 'step', id: main, ids: list, anchor });
}

/** Shift+click: the run from the anchor (the main step before) to `id`. */
export function extendTo(id) {
  const s = current();
  const anchor = s ? s.anchor ?? s.id : null;
  if (!anchor || !stepById(anchor)) return selectMany([id], id, id);
  const run = rangeBetween(state.workflow, anchor, id, slotKeys);
  // The clicked end, or its ancestor in the run (a range lifted to a common sequence).
  const at = locate(id);
  const main = run.includes(id) ? id : at?.ancestors.map((a) => a.id).find((x) => run.includes(x)) ?? run.at(-1);
  return selectMany(run, main, anchor);
}

/** Ctrl/⌘+click: toggle `id`; the last one removed clears the selection. */
export function toggleOne(id) {
  const ids = selectedIds();
  if (ids.includes(id)) {
    const rest = ids.filter((x) => x !== id);
    if (!rest.length) return select(null);
    return selectMany(rest, rest.includes(state.selection.id) ? state.selection.id : rest.at(-1), rest.at(-1));
  }
  return selectMany([...ids, id], id, id);
}

/**
 * Shift+↑ / Shift+↓: grow or shrink the run within the anchor's sequence (never into or out of a
 * frame); nothing at either end of it. → true when the selection changed.
 */
export function extendBy(dir) {
  const s = current();
  if (!s) return false;
  const anchorAt = locate(s.anchor && stepById(s.anchor) ? s.anchor : s.id);
  const mainAt = locate(s.id);
  // The main step must be in the anchor's sequence; otherwise start again from it.
  const list = anchorAt.list;
  const head = mainAt.list === list ? mainAt.index : anchorAt.index;
  const next = head + dir;
  if (next < 0 || next >= list.length || !list[next] || typeof list[next] !== 'object') return false;
  const [i, j] = anchorAt.index <= next ? [anchorAt.index, next] : [next, anchorAt.index];
  selectMany(list.slice(i, j + 1).map((x) => x.id), list[next].id, anchorAt.step.id);
  return true;
}

/** Ctrl+A in the tree: every step of the main step's sequence. */
export function selectSiblings() {
  const s = current();
  if (!s) return false;
  const at = locate(s.id);
  selectMany(at.list.filter((x) => x && typeof x === 'object').map((x) => x.id), s.id, at.list[0]?.id);
  return true;
}

/** Esc with several selected: keep only the main step. → true when there were several. */
export function collapseToMain() {
  if (!isMulti()) return false;
  const id = state.selection.id;
  select({ kind: 'step', id, anchor: id });
  return true;
}

// ---------- narrow screens: "Chọn nhiều bước" mode (≤ 900 px or touch) ----------

let selectMode = false;
const modeListeners = new Set();
export const inSelectMode = () => selectMode;
export function onSelectMode(fn) {
  modeListeners.add(fn);
}
export function setSelectMode(on) {
  if (selectMode === on) return;
  selectMode = on;
  document.body.classList.toggle('select-mode', on);
  for (const fn of modeListeners) fn(on);
}
