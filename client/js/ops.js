// Step operations used by the process view, the palette, the inspector and shortcuts.
// Thin wrappers around shared/workflow-tree.js that go through updateWorkflow (undo,
// autosave, events) and keep the selection sensible.

import { h, toast } from './dom.js';
import {
  state, subscribe, updateWorkflow, select, undo, nodeType, slotKeys, locate, stepById, newId, suggestAlias, workflowRevision, currentScope,
  suggestPoolAlias, suggestPickAlias,
} from './store.js';
import { analyzeScope, refChoices, sourceStep } from '/shared/scope.js';
import {
  insertStep, removeStep, moveStep, wrapStep, cloneSteps, collectIds, collectAliases,
  defaultInsertTarget, neighbourTarget, findStep, walkSteps, slotList, subtreeIds,
} from '/shared/workflow-tree.js';
import { stepLabel } from './summary.js';
import { placesText } from './variables.js';

/** Listeners that want to scroll to / flash a step after an operation (the process view). */
const revealers = new Set();
export function onReveal(fn) {
  revealers.add(fn);
}
export function reveal(id, opts = {}) {
  for (const fn of revealers) fn(id, opts);
}

const isContainer = (step) => slotKeys(step?.type).length > 0;
const childCount = (step) => {
  let n = 0;
  walkSteps(Object.values(step.slots ?? {}).flat(), () => { n++; }, slotKeys);
  return n;
};

export function selectedId() {
  return state.selection?.kind === 'step' ? state.selection.id : null;
}

export function defaultTarget() {
  return defaultInsertTarget(state.workflow, selectedId(), slotKeys);
}

/** Loop variables of the loops that would enclose a step inserted at `target`. */
function enclosingLoopVars(target) {
  if (!target?.parentId) return new Set();
  const at = locate(target.parentId);
  if (!at) return new Set();
  return new Set([...at.ancestors, at.step].filter((s) => s.type === 'loop').map((s) => s.config?.alias || 'loop'));
}

/** Loop variables used by `steps` and everything inside them. */
function loopVarsIn(steps) {
  const out = new Set();
  walkSteps(steps, (s) => { if (s.type === 'loop') out.add(s.config?.alias || 'loop'); }, slotKeys);
  return out;
}

/**
 * Default fields of a Record step for `sobject` (design 0012 G): meta.recordPresets (Task →
 * Subject, Contact → FirstName + LastName…), else meta.recordDefaultFields (`Name`, Họ tên). A
 * fresh copy.
 */
export function recordPresetFields(sobject) {
  return structuredClone(recordPreset(sobject)?.fields ?? state.meta?.recordDefaultFields ?? []);
}

/** The meta.recordPresets entry of `sobject` (API names ignore case), or null. */
export function recordPreset(sobject) {
  const presets = state.meta?.recordPresets ?? {};
  const key = Object.keys(presets).find((k) => k.toLowerCase() === String(sobject ?? '').toLowerCase());
  return key ? presets[key] : null;
}

/**
 * A new step of `type` with the catalogue defaults, ready to insert at `target`.
 * `around`: steps the new step will contain (wrapIn), whose loop variables it must not shadow.
 */
export function newStep(type, target, around = []) {
  const def = nodeType(type);
  const step = {
    id: newId({ record: 'r', loop: 'l', branch: 'b', query: 'q', pick: 'p' }[type] ?? 's'),
    type,
    // `initial` (a new step's value) wins over `default` (the value used when the key is missing).
    config: Object.fromEntries((def?.options ?? []).map((o) => [o.key, o.initial ?? o.default]).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, structuredClone(v)])),
  };
  if (def?.slots?.length) step.slots = Object.fromEntries(def.slots.map((s) => [s.key, []]));
  if (type === 'record') {
    step.config.alias = suggestAlias(step.config.sobject);
    step.config.fields = recordPresetFields(step.config.sobject);
  }
  if (type === 'query') step.config.alias = suggestPoolAlias(step.config.sobject);
  if (type === 'loop') {
    // Do not shadow the variable of an enclosing loop: loop, loop2, loop3…
    // …nor a loop inside the steps it wraps, nor a record alias.
    const taken = new Set([...enclosingLoopVars(target), ...loopVarsIn(around), ...collectAliases(state.workflow, state.meta)]);
    const base = step.config.alias || 'loop';
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    step.config.alias = name;
  }
  return step;
}

/**
 * A new Chọn bản ghi picks from the selected step if it is a pool (Query, Record, Chọn bản ghi)
 * usable at the new position, else from the nearest pool above; its alias follows (accs → acc).
 */
function fillPick(wf, step, selected) {
  const pools = refChoices(analyzeScope(wf, state.meta), step.id, { pool: true }).filter((c) => c.usable);
  const from = pools.find((c) => c.source === selected?.id) ?? pools[0];
  if (!from) return;
  step.config.from = from.name;
  step.config.alias = suggestPickAlias(from.name);
}

/**
 * "⋯ → Lặp qua từng bản ghi" on a Record, Query or Chọn bản ghi card (design 0010): a Lặp
 * `each` right after the step, over its records, with the record named after the pool
 * (accs → acc, acc → acc2) and a loop variable that does not shadow an enclosing one. One undo
 * step; the new loop is selected and flashed.
 */
export function addEachLoopAfter(id) {
  const at = locate(id);
  const from = at?.step.config?.alias;
  if (!from) return null;
  const target = { parentId: at.parentId, slot: at.slot, index: at.index + 1 };
  const step = newStep('loop', target);
  Object.assign(step.config, { mode: 'each', from, itemAlias: suggestPickAlias(from, undefined, 'itemAlias') });
  if (updateWorkflow((wf) => insertStep(wf, target, step)) === false) return null;
  select({ kind: 'step', id: step.id });
  reveal(step.id, { flash: true });
  return step;
}

/**
 * Lặp switched to "Mỗi bản ghi trong pool" (design 0010): fill an empty `from` with the nearest
 * usable pool above (the rule of a new Chọn bản ghi) and an empty `itemAlias` from it.
 * → the names filled, { from?, itemAlias? }.
 */
export function fillEach(wf, step) {
  const c = (step.config ??= {});
  const filled = {};
  if (!c.from) {
    const pools = refChoices(analyzeScope(wf, state.meta), step.id, { pool: true }).filter((x) => x.usable);
    if (pools[0]) c.from = filled.from = pools[0].name;
  }
  if (!c.itemAlias && c.from) c.itemAlias = filled.itemAlias = suggestPickAlias(c.from, step.id, 'itemAlias');
  return filled;
}

/** Insert a new step (default target: the "first free slot" rule) and select it. */
export function addStep(type, target = defaultTarget()) {
  const step = newStep(type, target);
  const selected = stepById(selectedId());
  const ok = updateWorkflow((wf) => {
    if (!insertStep(wf, target, step)) return false;
    if (type === 'pick') fillPick(wf, step, selected);
    return true;
  });
  if (ok === false) return null;
  select({ kind: 'step', id: step.id });
  reveal(step.id, { flash: true });
  return step;
}

/** References from outside `step` to variables it (or a step inside it) provides. */
function outsideRefs(step) {
  const inside = subtreeIds(step, slotKeys);
  const scope = currentScope();
  return scope.refs.filter((r) => inside.has(sourceStep(scope, r.source)) && !inside.has(r.nodeId));
}

/** The step to select after removing `id`: next sibling, else previous, else the parent. */
function selectionAfterRemove(at) {
  return at.list[at.index + 1]?.id ?? at.list[at.index - 1]?.id ?? at.parentId ?? null;
}

export function deleteStep(id = selectedId()) {
  const at = locate(id);
  if (!at) return;
  const n = childCount(at.step);
  if (isContainer(at.step) && n > 0) return confirmDeleteContainer(at, n);
  doRemove(at, false);
}

/**
 * Toast with "Hoàn tác" that undoes only this edit: as soon as anything else changes the
 * workflow (another edit, undo or redo), the button is removed — Ctrl+Z still works.
 */
let dropUndoWatch = null;
function toastWithUndo(message) {
  dropUndoWatch?.();
  const rev = workflowRevision();
  const t = toast(message, 4000, {
    label: 'Hoàn tác',
    onClick: () => {
      if (workflowRevision() === rev) undo();
      else toast('Đã có thay đổi khác sau thao tác này. Dùng Ctrl+Z để hoàn tác từng bước.', 4000);
    },
  });
  const off = subscribe(({ kind }) => {
    if (kind !== 'workflow' || workflowRevision() === rev) return;
    t.removeAction();
    off();
    dropUndoWatch = null;
  });
  dropUndoWatch = off;
}

function doRemove(at, keepChildren) {
  const step = at.step;
  const nextSel = keepChildren ? (slotKeys(step.type).flatMap((k) => slotList(step, k))[0]?.id ?? selectionAfterRemove(at)) : selectionAfterRemove(at);
  const scope = currentScope();
  // Bỏ vỏ: references to what the container provided (its loop variable, the record a Lặp
  // `each` loops over) break.
  const refs = keepChildren ? scope.refs.filter((r) => sourceStep(scope, r.source) === step.id && r.nodeId !== step.id) : outsideRefs(step);
  const srcName = refs.length ? scope.sources[refs[0].source]?.name ?? refs[0].source : '';
  updateWorkflow((wf) => removeStep(wf, step.id, { keepChildren, slotKeys }));
  select(nextSel ? { kind: 'step', id: nextSel } : null);
  if (nextSel) reveal(nextSel);
  const places = placesText(refs);
  const sources = new Set(refs.map((r) => r.source));
  const used = places.length
    ? ` ${sources.size === 1 ? `Bước "${srcName}"` : 'Các bước vừa xóa'} đang được dùng ở ${places.length} chỗ: ${places.join(', ')}. ${places.length > 1 ? 'Các chỗ đó' : 'Chỗ đó'} sẽ báo lỗi cho tới khi sửa.`
    : '';
  toastWithUndo(keepChildren ? `Đã bỏ vỏ ${stepLabel(step)}.${used}` : `Đã xóa bước ${stepLabel(step)}.${used}`);
}

/** "Bỏ vỏ" is only possible when at most one slot has steps. */
export function canUnwrap(step) {
  return isContainer(step) && slotKeys(step.type).filter((k) => slotList(step, k).length).length <= 1;
}

function confirmDeleteContainer(at, n) {
  const modal = document.getElementById('modal');
  const step = at.step;
  const close = () => modal.close();
  modal.replaceChildren(
    h('h2', {}, `Xóa ${stepLabel(step)} và ${n} bước bên trong?`),
    h('p', { class: 'hint' }, 'Có thể hoàn tác bằng Ctrl+Z.'),
    h(
      'div',
      { class: 'actions' },
      h('button', { onclick: close }, 'Hủy'),
      canUnwrap(step) ? h('button', { onclick: () => { close(); doRemove(locate(step.id), true); } }, `Chỉ xóa vỏ, giữ ${n} bước`) : null,
      h('button', { class: 'danger solid', onclick: () => { close(); doRemove(locate(step.id), false); } }, 'Xóa tất cả'),
    ),
  );
  modal.onclose = null;
  modal.showModal();
  modal.querySelector('.actions .danger')?.focus();
}

export function unwrap(id = selectedId()) {
  const at = locate(id);
  if (!at || !canUnwrap(at.step)) return;
  doRemove(at, true);
}

/** Ctrl+D: copy right after the step; aliases defined inside the copy get new names. */
export function duplicateStep(id = selectedId()) {
  const at = locate(id);
  if (!at) return;
  let copyId = null;
  updateWorkflow((wf) => {
    const { steps: [copy] } = cloneSteps([at.step], { ids: collectIds(wf), aliases: collectAliases(wf, state.meta), catalog: state.meta });
    copyId = copy.id;
    insertStep(wf, { parentId: at.parentId, slot: at.slot, index: at.index + 1 }, copy);
  });
  select({ kind: 'step', id: copyId });
  reveal(copyId, { flash: true });
}

/** Ctrl+/: turn a step (and everything inside it) off or back on. */
export function toggleDisabled(id = selectedId()) {
  const step = stepById(id);
  if (!step) return;
  updateWorkflow(() => {
    if (step.disabled) delete step.disabled;
    else step.disabled = true;
  });
  toast(step.disabled ? `Đã tắt bước ${stepLabel(step)}. Bấm Ctrl+/ để bật lại.` : `Đã bật lại bước ${stepLabel(step)}.`);
}

export function wrapIn(id, type) {
  const at = locate(id);
  if (!at) return;
  const container = newStep(type, { parentId: at.parentId, slot: at.slot, index: at.index }, [at.step]);
  updateWorkflow((wf) => wrapStep(wf, id, container, { slotKeys }));
  select({ kind: 'step', id: container.id });
  reveal(container.id, { flash: true });
}

/** Alt+↑ / Alt+↓. Consecutive presses for one step are one undo step. */
export function moveBy(id, dir) {
  const target = neighbourTarget(state.workflow, id, dir, state.collapsed, slotKeys);
  if (!target) return false;
  updateWorkflow((wf) => moveStep(wf, id, target, slotKeys), { coalesceKey: `move:${id}` });
  reveal(id);
  return true;
}

/** Drag and drop: `target` is in the tree as displayed (before the move). */
export function moveTo(id, target) {
  const moved = updateWorkflow((wf) => moveStep(wf, id, target, slotKeys));
  if (moved) reveal(id, { flash: true });
  return moved;
}

/** Open every collapsed container around a step (so it can be shown and selected). */
export function expandAncestors(id) {
  const at = findStep(state.workflow, id, slotKeys);
  if (!at) return false;
  let changed = false;
  for (const a of at.ancestors) if (state.collapsed.delete(a.id)) changed = true;
  return changed;
}
