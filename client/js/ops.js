// Step operations used by the process view, the palette, the inspector and shortcuts.
// Thin wrappers around shared/workflow-tree.js that go through updateWorkflow (undo,
// autosave, events) and keep the selection sensible.

import { h, toast } from './dom.js';
import {
  state, subscribe, updateWorkflow, select, undo, nodeType, slotKeys, locate, stepById, newId, suggestAlias, workflowRevision, currentScope,
  suggestPoolAlias, suggestPickAlias,
} from './store.js';
import { analyzeScope, refChoices, sourceStep } from '/shared/scope.js';
import { eachWrapPlan as planEachWrap, applyEachRewire } from '/shared/each-wrap.js';
import {
  insertStep, removeStep, moveStep, wrapStep, cloneSteps, collectIds, collectAliases,
  defaultInsertTarget, neighbourTarget, findStep, walkSteps, slotList, subtreeIds,
  normalizeSelection, wrapSteps, removeSteps, moveBlock, neighbourTargetBlock, pasteSteps, loopVarsAround,
} from '/shared/workflow-tree.js';
import { stepLabel } from './summary.js';
import { placesText } from './variables.js';
import { selectionInfo, selectMany } from './selection.js';
import { toClipboard, parseClipboard } from './clipboard.js';

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

/**
 * "Lọc" just became "Chỉ bản ghi thỏa điều kiện" on a Lặp `each` or a Chọn bản ghi (design 0013):
 * with Field and "So với" still empty and a pool read from the org (`from`, its fields known), the
 * nearest usable record read from the org (the record looped over, or picked) whose sObject S
 * gives the pool a field `${S}Id` (Salesforce naming: AccountId, ContactId; any case) makes the
 * parent–child condition `<S>Id = {{<record>.Id}}`. Generated records have no Id yet, so they are
 * never suggested. Mutates `step` (inside the caller's updateWorkflow: the same undo step).
 * → { field, value, parent } or null when nothing was filled.
 */
export function fillParentFilter(wf, step) {
  const c = (step.config ??= {});
  if ((c.filterField ?? '') !== '' || (c.filterValue ?? '') !== '') return null;
  const scope = analyzeScope(wf, state.meta);
  const here = scope.at[step.id];
  if (!here || !c.from) return null;
  const visible = here.visible.map((v) => scope.sources[v.source]).filter(Boolean);
  const pool = visible.find((s) => s.pool && s.name === c.from);
  if (!pool || pool.origin !== 'org') return null;
  const fields = new Map(pool.members.filter((m) => !m.builtin).map((m) => [m.key.toLowerCase(), m.key]));
  for (const s of visible) {
    if (s.origin !== 'org' || (s.current !== 'item' && s.current !== 'picked') || !s.sobject || !s.name) continue;
    if (!s.open && !s.members.some((m) => m.key === 'Id')) continue;
    const field = fields.get(`${s.sobject}id`.toLowerCase());
    if (!field) continue;
    c.filterField = field;
    c.filterOp = 'eq';
    c.filterValue = `{{${s.name}.Id}}`;
    return { field, value: c.filterValue, parent: s.name };
  }
  return null;
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
    // As in paste: the copy must not take the name of a loop variable around it either.
    const around = loopVarsAround(wf, { parentId: at.parentId }, slotKeys);
    const aliases = new Set([...collectAliases(wf, state.meta), ...around]);
    const { steps: [copy] } = cloneSteps([at.step], { ids: collectIds(wf), aliases, catalog: state.meta });
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

/**
 * Plan of "Bọc trong Lặp qua từng bản ghi" (design 0012 C) around step `id`: see
 * shared/each-wrap.js. → { from, rewire } or null (no usable pool).
 */
export function eachWrapPlan(id) {
  return planEachWrap(state.workflow, state.meta, id, { slotKeys, scope: currentScope() });
}

/**
 * "Bọc trong Lặp qua từng bản ghi" (design 0012 C): a Lặp `each` takes the step's place with the
 * step in its body, over the pool of eachWrapPlan, the record named after it (accs → acc). One
 * undo step; the loop is selected and flashed. Lookups to that pool (random) or to a Chọn bản
 * ghi from it are not changed: a toast offers [Đổi] (another undo step), as that changes the data.
 */
export function wrapInEach(id) {
  // One step, or a block of steps side by side (design 0012 B: a list of ids).
  const sel = normalizeSelection(state.workflow, Array.isArray(id) ? id : [id], slotKeys);
  if (!sel.contiguous) return null;
  const plan = eachWrapPlan(sel.ids.length === 1 ? sel.ids[0] : sel.ids);
  if (!plan) return null;
  const container = newStep('loop', { parentId: sel.parentId, slot: sel.slot, index: sel.start }, sel.ids.map(stepById));
  const itemAlias = suggestPickAlias(plan.from, undefined, 'itemAlias');
  Object.assign(container.config, { mode: 'each', from: plan.from, itemAlias });
  if (!updateWorkflow((wf) => wrapSteps(wf, sel.ids, container, { slotKeys }))) return null;
  select({ kind: 'step', id: container.id });
  reveal(container.id, { flash: true });
  if (plan.rewire.length) {
    const one = plan.rewire[0];
    const question = plan.rewire.length === 1
      ? `Đổi Lookup ${one.fieldName} (${one.alias}) sang bản ghi đang lặp "${itemAlias}"?`
      : `Đổi ${plan.rewire.length} Lookup sang bản ghi đang lặp "${itemAlias}"?`;
    toast(question, 8000, { label: 'Đổi', onClick: () => rewireLookups(plan.rewire, container.id, itemAlias) });
  }
  return container;
}

/**
 * [Đổi] of wrapInEach: only while the Lặp still exists with the same record name and the Lookups
 * are still inside it, unchanged (shared/each-wrap.js); another undo step.
 */
function rewireLookups(rewire, loopId, itemAlias) {
  let n = null;
  updateWorkflow((wf) => { n = applyEachRewire(wf, rewire, { loopId, itemAlias, slotKeys }); });
  if (n === null) toast('Không đổi được: Lặp qua từng bản ghi đã bị hoàn tác hoặc sửa.');
  else toast(n ? `Đã đổi ${n} Lookup sang bản ghi đang lặp "${itemAlias}".` : 'Không đổi được: các Lookup đó đã được sửa sau khi bọc.');
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

// ---------- the selection, one or several steps (design 0012 B) ----------

export const NOT_BLOCK_MOVE = 'Chỉ di chuyển được các bước liền nhau trong cùng một dãy.';
export const NOT_BLOCK_WRAP = 'Chỉ bọc được các bước liền nhau trong cùng một dãy.';
export const NO_POOL = 'Chưa có pool nào phía trên (bước Query, Record hoặc Chọn bản ghi có alias). Thêm một bước như vậy ở phía trên trước.';

const many = (n) => `${n} bước`;

/** Delete key, menu and inspector: the selected steps (one step: deleteStep, with its own dialog). */
export function deleteSelection() {
  const sel = selectionInfo();
  if (sel.ids.length <= 1) return deleteStep(sel.ids[0] ?? selectedId());
  const inner = sel.ids.reduce((n, id) => n + childCount(stepById(id)), 0);
  if (inner > 0) return confirmDeleteMany(sel.ids, inner);
  return removeMany(sel.ids);
}

function confirmDeleteMany(ids, inner) {
  const modal = document.getElementById('modal');
  const close = () => modal.close();
  modal.replaceChildren(
    h('h2', {}, `Xóa ${many(ids.length)} và ${many(inner)} bên trong?`),
    h('p', { class: 'hint' }, 'Có thể hoàn tác bằng Ctrl+Z.'),
    h('div', { class: 'actions' },
      h('button', { onclick: close }, 'Hủy'),
      h('button', { class: 'danger solid', onclick: () => { close(); removeMany(ids); } }, 'Xóa tất cả')),
  );
  modal.onclose = null;
  modal.showModal();
  modal.querySelector('.actions .danger')?.focus();
}

/** Remove a normalised selection: one undo step, toast with "Hoàn tác" and the broken references. */
function removeMany(ids, { cut = false } = {}) {
  ids = ids.filter((id) => stepById(id));
  if (!ids.length) return;
  const inside = new Set(ids.flatMap((id) => [...subtreeIds(stepById(id), slotKeys)]));
  const scope = currentScope();
  const refs = scope.refs.filter((r) => inside.has(sourceStep(scope, r.source)) && !inside.has(r.nodeId));
  const first = locate(ids[0]);
  const last = locate(ids.at(-1));
  const nextSel = last.list.slice(last.index + 1).find((s) => s?.id && !inside.has(s.id))?.id
    ?? first.list.slice(0, first.index).reverse().find((s) => s?.id && !inside.has(s.id))?.id
    ?? first.parentId;
  updateWorkflow((wf) => removeSteps(wf, ids, { slotKeys }));
  select(nextSel ? { kind: 'step', id: nextSel } : null);
  if (nextSel) reveal(nextSel);
  if (cut) {
    toast(`Đã cắt ${many(ids.length)}. Bấm Ctrl+V để dán.`, 4000);
    return;
  }
  const places = placesText(refs);
  const used = places.length
    ? ` Các bước vừa xóa đang được dùng ở ${places.length} chỗ: ${places.join(', ')}. ${places.length > 1 ? 'Các chỗ đó' : 'Chỗ đó'} sẽ báo lỗi cho tới khi sửa.`
    : '';
  toastWithUndo(`Đã xóa ${many(ids.length)}.${used}`);
}

/** Ctrl+/: one step on / off; several: off when one of them is on, else all back on. */
export function toggleSelectionDisabled() {
  const sel = selectionInfo();
  if (sel.ids.length <= 1) return toggleDisabled(sel.ids[0] ?? selectedId());
  const steps = sel.ids.map(stepById);
  const off = steps.some((s) => !s.disabled);
  updateWorkflow(() => {
    for (const s of steps) {
      if (off) s.disabled = true;
      else delete s.disabled;
    }
  });
  toast(off ? `Đã tắt ${many(steps.length)}. Bấm Ctrl+/ để bật lại.` : `Đã bật lại ${many(steps.length)}.`);
  return undefined;
}

/** Ctrl+D: a block is copied as a whole right after it; scattered steps each right after itself. */
export function duplicateSelection() {
  const sel = selectionInfo();
  if (sel.ids.length <= 1) return duplicateStep(sel.ids[0] ?? selectedId());
  const copies = [];
  updateWorkflow((wf) => {
    const ids = collectIds(wf);
    const aliases = collectAliases(wf, state.meta);
    const groups = sel.contiguous ? [sel.ids] : sel.ids.map((id) => [id]);
    for (const group of groups) {
      const at = findStep(wf, group.at(-1), slotKeys);
      const block = group.map((id) => findStep(wf, id, slotKeys).step);
      // One cloneSteps per block: references between the copied steps follow their copies.
      const { steps } = cloneSteps(block, { ids, aliases, catalog: state.meta });
      at.list.splice(at.index + 1, 0, ...steps);
      copies.push(...steps.map((s) => s.id));
    }
  });
  selectMany(copies, copies[0], copies[0]);
  reveal(copies[0], { flash: true });
  return undefined;
}

/** Bọc trong Lặp / Rẽ nhánh: the selected block (a scattered selection cannot be wrapped). */
export function wrapSelection(type) {
  const sel = selectionInfo();
  if (sel.ids.length <= 1) return wrapIn(sel.ids[0] ?? selectedId(), type);
  if (!sel.contiguous) return toast(NOT_BLOCK_WRAP);
  const container = newStep(type, { parentId: sel.parentId, slot: sel.slot, index: sel.start }, sel.ids.map(stepById));
  updateWorkflow((wf) => wrapSteps(wf, sel.ids, container, { slotKeys }));
  select({ kind: 'step', id: container.id });
  reveal(container.id, { flash: true });
  return undefined;
}

/** Bọc trong Lặp qua từng bản ghi of the selection (one step or a block). */
export function wrapSelectionEach() {
  const sel = selectionInfo();
  if (!sel.contiguous) return toast(NOT_BLOCK_WRAP);
  return wrapInEach(sel.ids.length === 1 ? sel.ids[0] : sel.ids);
}

/** The each-wrap plan of the selection (C), or null: not one block / no usable pool. */
export function selectionEachPlan() {
  const sel = selectionInfo();
  if (!sel.contiguous) return null;
  return eachWrapPlan(sel.ids.length === 1 ? sel.ids[0] : sel.ids);
}

/** Alt+↑ / Alt+↓ of the selection: a block moves as one; repeated presses are one undo step. */
export function moveSelectionBy(dir) {
  const sel = selectionInfo();
  if (sel.ids.length <= 1) return moveBy(sel.ids[0] ?? selectedId(), dir);
  if (!sel.contiguous) {
    toast(NOT_BLOCK_MOVE);
    return false;
  }
  const target = neighbourTargetBlock(state.workflow, sel.ids, dir, state.collapsed, slotKeys);
  if (!target) return false;
  updateWorkflow((wf) => moveBlock(wf, sel.ids, target, slotKeys), { coalesceKey: `move:${sel.ids.join(',')}` });
  reveal(state.selection.id);
  return true;
}

/** Drag and drop of a selected block (`target` as displayed, before the move). */
export function moveBlockTo(ids, target) {
  const moved = updateWorkflow((wf) => moveBlock(wf, ids, target, slotKeys));
  if (moved) reveal(state.selection?.id ?? ids[0], { flash: true });
  return moved;
}

// ---------- copy / cut / paste (system clipboard; main.js wires the events) ----------

let copied = null; // text of this tab's last copy: "Dán" from a menu when the clipboard cannot be read

/** Clipboard text of the selection, or null. → { text, count } */
export function selectionClipboard() {
  const sel = selectionInfo();
  if (!sel.ids.length) return null;
  const text = toClipboard(sel.ids.map((id) => structuredClone(stepById(id))), state.workflow.name);
  copied = text;
  return { text, count: sel.ids.length };
}

/** After a cut event put the text on the clipboard: remove the steps (one undo step). */
export function removeCut() {
  removeMany(selectionInfo().ids, { cut: true });
}

/**
 * Menu "Sao chép" / "Cắt": the browser's copy / cut command, so the same events (and the system
 * clipboard) are used. Without clipboard access the copy stays in this tab only.
 */
export function clipboardCommand(cut = false) {
  let ok = false;
  try {
    ok = document.execCommand(cut ? 'cut' : 'copy');
  } catch {
    ok = false;
  }
  if (ok) return;
  const clip = selectionClipboard();
  if (!clip) return;
  if (cut) removeCut();
  else toast(`Đã sao chép ${many(clip.count)} (chỉ dán được trong tab này: trình duyệt không cho ghi bộ nhớ tạm).`, 5000);
}

/** Menu "Dán sau bước này": the clipboard if the browser lets us read it, else this tab's last copy. */
export async function pasteCommand() {
  let text = null;
  try {
    // A permission prompt that never gets an answer must not leave the menu doing nothing.
    text = await Promise.race([navigator.clipboard.readText(), new Promise((res) => { setTimeout(() => res(null), 1500); })]);
  } catch {
    text = null;
  }
  if (text && parseClipboard(text, state.meta).steps) return pasteText(text);
  if (copied) return pasteText(copied);
  if (text) return pasteText(text);
  toast('Không đọc được bộ nhớ tạm. Chọn bước rồi bấm Ctrl+V để dán.', 5000);
  return false;
}

/**
 * Where a paste goes: one step selected (or none): the rule of "+" and the palette (a frame's
 * first empty slot, else right after it); several: right after the last one in reading order.
 */
function pasteTarget() {
  const sel = selectionInfo();
  if (sel.ids.length < 2) return defaultInsertTarget(state.workflow, sel.ids[0] ?? null, slotKeys);
  const at = locate(sel.ids.at(-1));
  return { parentId: at.parentId, slot: at.slot, index: at.index + 1 };
}

/**
 * Paste clipboard text (design 0012 B). Refusals are toasts; `quiet`: say nothing when the text is
 * not steps at all (a paste outside the tree). One undo step; the pasted steps are selected.
 */
export function pasteText(text, { quiet = false } = {}) {
  const parsed = parseClipboard(text, state.meta);
  if (parsed.error) {
    if (!(quiet && parsed.kind === 'notSteps')) toast(parsed.error, 6000);
    return false;
  }
  const target = pasteTarget();
  let res = null;
  updateWorkflow((wf) => { res = pasteSteps(wf, target, parsed.steps, { catalog: state.meta, slotKeys }); });
  if (!res?.ids.length) return false;
  selectMany(res.ids, res.ids[0], res.ids[0]);
  reveal(res.ids[0], { flash: true });
  const parts = [`Đã dán ${many(res.ids.length)}.`];
  if (res.renamed.length) parts.push(`Đổi tên alias: ${res.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}.`);
  if (res.missingRefs) parts.push(`${res.missingRefs} tham chiếu tới bước không có ở đây (${res.missing.join(', ')}): xem thanh lỗi (F8).`);
  toast(parts.join(' '), parts.length > 1 ? 8000 : 3000);
  return true;
}
