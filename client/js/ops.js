// Step operations used by the process view, the palette, the inspector and shortcuts.
// Thin wrappers around shared/workflow-tree.js that go through updateWorkflow (undo,
// autosave, events) and keep the selection sensible.

import { h, toast } from './dom.js';
import {
  state, subscribe, updateWorkflow, select, undo, nodeType, slotKeys, locate, stepById, newId, suggestAlias, workflowRevision,
} from './store.js';
import {
  insertStep, removeStep, moveStep, wrapStep, cloneSteps, collectIds, collectAliases,
  defaultInsertTarget, neighbourTarget, findStep, walkSteps, slotList,
} from '/shared/workflow-tree.js';
import { stepLabel } from './summary.js';

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
 * A new step of `type` with the catalogue defaults, ready to insert at `target`.
 * `around`: steps the new step will contain (wrapIn), whose loop variables it must not shadow.
 */
export function newStep(type, target, around = []) {
  const def = nodeType(type);
  const step = {
    id: newId(type === 'record' ? 'r' : type === 'loop' ? 'l' : type === 'branch' ? 'b' : 's'),
    type,
    config: Object.fromEntries((def?.options ?? []).filter((o) => o.default !== '' && o.default !== undefined).map((o) => [o.key, structuredClone(o.default)])),
  };
  if (def?.slots?.length) step.slots = Object.fromEntries(def.slots.map((s) => [s.key, []]));
  if (type === 'record') {
    step.config.alias = suggestAlias(step.config.sobject);
    step.config.fields = [{ name: 'Name', type: 'text', options: { mode: step.config.sobject === 'Account' ? 'company' : 'name' } }];
  }
  if (type === 'loop') {
    // Do not shadow the variable of an enclosing loop: loop, loop2, loop3…
    // …nor a loop inside the steps it wraps, nor a record alias.
    const taken = new Set([...enclosingLoopVars(target), ...loopVarsIn(around), ...collectAliases(state.workflow)]);
    const base = step.config.alias || 'loop';
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    step.config.alias = name;
  }
  return step;
}

/** Insert a new step (default target: the "first free slot" rule) and select it. */
export function addStep(type, target = defaultTarget()) {
  const step = newStep(type, target);
  const ok = updateWorkflow((wf) => insertStep(wf, target, step));
  if (ok === false) return null;
  select({ kind: 'step', id: step.id });
  reveal(step.id, { flash: true });
  return step;
}

function refsTo(alias) {
  let n = 0;
  if (!alias) return 0;
  walkSteps(state.workflow.steps, (s) => {
    for (const f of s.config?.fields ?? []) if (f.options?.ref === alias) n++;
  }, slotKeys);
  return n;
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
  updateWorkflow((wf) => removeStep(wf, step.id, { keepChildren, slotKeys }));
  select(nextSel ? { kind: 'step', id: nextSel } : null);
  if (nextSel) reveal(nextSel);
  if (keepChildren) {
    toastWithUndo(`Đã bỏ vỏ ${stepLabel(step)}.`);
    return;
  }
  const alias = step.type === 'record' ? step.config?.alias : null;
  const refs = refsTo(alias);
  toastWithUndo(`Đã xóa bước ${stepLabel(step)}.${refs ? ` ${refs} field đang tham chiếu "${alias}" sẽ báo lỗi.` : ''}`);
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
    const { steps: [copy] } = cloneSteps([at.step], { ids: collectIds(wf), aliases: collectAliases(wf) });
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
