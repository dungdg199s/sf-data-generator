// Step operations used by the process view, the palette, the inspector and shortcuts.
// Thin wrappers around shared/workflow-tree.js that go through updateWorkflow (undo,
// autosave, events) and keep the selection sensible.

import { h, toast } from './dom.js';
import {
  state, subscribe, updateWorkflow, select, undo, nodeType, slotKeys, locate, stepById, newId, suggestAlias, workflowRevision, currentScope,
  suggestPoolAlias, suggestPickAlias, recordDefaultFields,
} from './store.js';
import { analyzeScope, refChoices, sourceStep } from '/shared/scope.js';
import {
  insertStep, removeStep, moveStep, wrapStep, cloneSteps, collectIds, collectAliases,
  defaultInsertTarget, neighbourTarget, findStep, walkSteps, slotList, subtreeIds,
  wrapSteps, removeSteps, moveBlock, neighbourTargetBlock, pasteSteps,
} from '/shared/workflow-tree.js';
import { selectedIds, selectionInfo, selectMany } from './selection.js';
import { toClipboard, parseClipboard } from './clipboard.js';
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
    // The server's preset for the sObject (meta.recordPresets, design 0012 G); Account ⇒ Name (company).
    step.config.fields = recordDefaultFields(step.config.sobject);
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
 * "Lọc" just turned to "Chỉ bản ghi thỏa điều kiện" (design 0013, Lặp `each` and Chọn bản ghi):
 * with filterField and filterValue still empty, a pool read from the org (`from`) whose fields
 * include `<S>Id` is filtered by the nearest usable record read from the org of sObject S that is
 * a current record (the record looped over, or a pick): AccountId = {{acc.Id}}. The `<S>Id` naming
 * is Salesforce's convention; it is only a suggestion (validation and runs do not depend on it).
 * → { field, name } when filled, else null.
 */
export function fillParentFilter(wf, step) {
  const c = (step.config ??= {});
  if (String(c.filterField ?? '').trim() || String(c.filterValue ?? '').trim()) return null;
  const scope = analyzeScope(wf, state.meta);
  const here = scope.at[step.id];
  const visible = (here?.visible ?? []).map((v) => scope.sources[v.source]).filter(Boolean);
  const pool = visible.find((s) => s.kind === 'record' && s.pool && s.name === c.from);
  if (!pool || pool.origin !== 'org') return null;
  const fields = pool.members.filter((m) => !m.builtin).map((m) => m.key);
  for (const s of visible) {
    if (s.kind !== 'record' || s.origin !== 'org' || !['item', 'picked'].includes(s.current) || !s.sobject) continue;
    const want = `${s.sobject}Id`.toLowerCase();
    const field = fields.find((k) => k.toLowerCase() === want);
    if (!field) continue;
    c.filterField = field;
    c.filterOp = 'eq';
    c.filterValue = `{{${s.name}.Id}}`;
    return { field, name: s.name };
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

/**
 * Where "Bọc trong Lặp qua từng bản ghi" (design 0012 C) would loop for the steps `ids` (one step
 * or a run of siblings, in order): the pools usable at the new loop's position, and the one the
 * wrapped steps refer to most (Lookup ref, Chọn bản ghi from, {{accs.…}}); a tie or none: the
 * nearest. → { from, pools } or null when no pool is usable there.
 */
export function eachWrapPlan(ids) {
  const at = locate(ids[0]);
  if (!at) return null;
  const wf = structuredClone(state.workflow);
  const steps = ids.map((id) => findStep(wf, id, slotKeys)?.step).filter(Boolean);
  if (steps.length !== ids.length) return null;
  const loop = newStep('loop', { parentId: at.parentId, slot: at.slot, index: at.index }, steps);
  loop.config.mode = 'each';
  if (!wrapSteps(wf, ids, loop, { slotKeys })) return null;
  const scope = analyzeScope(wf, state.meta);
  const pools = refChoices(scope, loop.id, { pool: true }).filter((c) => c.usable);
  if (!pools.length) return null;
  const inside = new Set(steps.flatMap((st) => [...subtreeIds(st, slotKeys)]));
  const names = new Set(pools.map((p) => p.name));
  const count = new Map();
  for (const r of scope.refs) {
    if (!inside.has(r.nodeId) || r.disabled) continue;
    const src = scope.sources[r.source];
    if (!src) continue;
    // A Chọn bản ghi counts for the pool it picks from (the loop replaces the pick).
    const name = src.current === 'picked' && names.has(src.from) ? src.from : names.has(src.name) ? src.name : null;
    if (name) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const best = Math.max(0, ...count.values());
  const top = pools.filter((p) => count.get(p.name) === best);
  return { from: best > 0 && top.length === 1 ? top[0].name : pools[0].name, pools };
}

/**
 * ⋯ → "Bọc trong Lặp qua từng bản ghi" (design 0012 C): a Lặp `each` around the steps `ids` (one
 * step or a run of siblings), over the pool of eachWrapPlan, the record named after it
 * (accs → acc). One undo step; the loop is selected and flashed. Lookups of the wrapped steps that
 * pick at random from that pool (or point at a Chọn bản ghi from it) are offered a switch to the
 * record looped over by a toast [Đổi] (a separate undo step), never changed silently.
 */
export function wrapInEach(ids) {
  const plan = eachWrapPlan(ids);
  const at = locate(ids[0]);
  if (!plan || !at) return null;
  const around = ids.map((id) => stepById(id));
  const loop = newStep('loop', { parentId: at.parentId, slot: at.slot, index: at.index }, around);
  Object.assign(loop.config, { mode: 'each', from: plan.from, itemAlias: suggestPickAlias(plan.from, undefined, 'itemAlias') });
  if (!updateWorkflow((wf) => Boolean(wrapSteps(wf, ids, loop, { slotKeys })))) return null;
  select({ kind: 'step', id: loop.id });
  reveal(loop.id, { flash: true });
  offerRelink(loop.id);
  return loop;
}

/** Toast [Đổi] for the Lookups inside a new Lặp `each` that could use the record looped over. */
function offerRelink(loopId) {
  const loop = stepById(loopId);
  const { from, itemAlias } = loop?.config ?? {};
  if (!from || !itemAlias) return;
  const pickAliases = new Set();
  walkSteps(state.workflow.steps, (s) => { if (s.type === 'pick' && !s.disabled && s.config?.from === from && s.config?.alias) pickAliases.add(s.config.alias); }, slotKeys);
  const hits = [];
  walkSteps(loop.slots?.body ?? [], (s) => {
    if (s.type !== 'record' || s.disabled) return;
    for (const f of s.config?.fields ?? []) {
      if (!['lookup', 'masterdetail'].includes(f?.type)) continue;
      const mode = f.options?.mode ?? 'current';
      if ((f.options?.ref === from && mode === 'random') || (pickAliases.has(f.options?.ref) && mode !== 'fixed')) hits.push({ stepId: s.id, field: f.name, alias: s.config?.alias || s.id });
    }
  }, slotKeys);
  if (!hits.length) return;
  const text = hits.length === 1
    ? `Đổi Lookup ${hits[0].field} (${hits[0].alias}) sang bản ghi đang lặp "${itemAlias}"?`
    : `Đổi ${hits.length} Lookup sang bản ghi đang lặp "${itemAlias}"?`;
  const rev = workflowRevision();
  toast(text, 8000, {
    label: 'Đổi',
    onClick: () => {
      if (workflowRevision() !== rev) {
        toast('Workflow đã thay đổi sau khi bọc. Đổi Lookup trong bảng cấu hình của bước.', 5000);
        return;
      }
      updateWorkflow(() => {
        for (const hit of hits) {
          const f = (stepById(hit.stepId)?.config?.fields ?? []).find((x) => x?.name === hit.field);
          if (f) f.options = { ...(f.options ?? {}), ref: itemAlias, mode: 'current' };
        }
      }, { source: 'inspector-structure' });
      toast(`Đã đổi ${hits.length === 1 ? `Lookup ${hits[0].field}` : `${hits.length} Lookup`} sang bản ghi đang lặp "${itemAlias}". Ctrl+Z để hoàn tác.`, 4000);
    },
  });
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

// ---------- several steps (design 0012 B) ----------

const RUN_ONLY_MOVE = 'Chỉ di chuyển được các bước liền nhau trong cùng một dãy.';
const RUN_ONLY_WRAP = 'Chỉ bọc được các bước liền nhau trong cùng một dãy.';
export const SELECTION_TITLES = { move: RUN_ONLY_MOVE, wrap: RUN_ONLY_WRAP };

/** "3 bước" / "Record "acc"" for toasts about the selection. */
const countText = (ids) => (ids.length === 1 ? stepLabel(stepById(ids[0])) : `${ids.length} bước`);

/** Delete: one step as before; several at once (one undo step), asking when frames hold steps. */
export function deleteSelection() {
  const ids = selectedIds();
  if (ids.length <= 1) return ids[0] ? deleteStep(ids[0]) : undefined;
  const inner = ids.reduce((n, id) => n + childCount(stepById(id)), 0);
  if (inner > 0) return confirmDeleteMany(ids, inner);
  return doRemoveMany(ids);
}

function doRemoveMany(ids) {
  const scope = currentScope();
  const inside = new Set(ids.flatMap((id) => [...subtreeIds(stepById(id), slotKeys)]));
  const refs = scope.refs.filter((r) => inside.has(sourceStep(scope, r.source)) && !inside.has(r.nodeId));
  const first = locate(ids[0]);
  const lastAt = locate(ids.at(-1));
  const next = lastAt.list[lastAt.index + 1]?.id ?? first.list[first.index - 1]?.id ?? first.parentId ?? null;
  updateWorkflow((wf) => removeSteps(wf, ids, { slotKeys }));
  select(next && stepById(next) ? { kind: 'step', id: next } : null);
  if (next && stepById(next)) reveal(next);
  const places = placesText(refs);
  const used = places.length ? ` Các bước vừa xóa đang được dùng ở ${places.length} chỗ: ${places.join(', ')}. ${places.length > 1 ? 'Các chỗ đó' : 'Chỗ đó'} sẽ báo lỗi cho tới khi sửa.` : '';
  toastWithUndo(`Đã xóa ${ids.length} bước.${used}`);
}

function confirmDeleteMany(ids, inner) {
  const modal = document.getElementById('modal');
  const close = () => modal.close();
  modal.replaceChildren(
    h('h2', {}, `Xóa ${ids.length} bước và ${inner} bước bên trong?`),
    h('p', { class: 'hint' }, 'Có thể hoàn tác bằng Ctrl+Z.'),
    h('div', { class: 'actions' },
      h('button', { onclick: close }, 'Hủy'),
      h('button', { class: 'danger solid', onclick: () => { close(); doRemoveMany(ids.filter((id) => stepById(id))); } }, 'Xóa tất cả')),
  );
  modal.onclose = null;
  modal.showModal();
  modal.querySelector('.actions .danger')?.focus();
}

/** Ctrl+/ on the selection: off when one of them is on, else all back on (one undo step). */
export function toggleSelection() {
  const ids = selectedIds();
  if (ids.length <= 1) return ids[0] ? toggleDisabled(ids[0]) : undefined;
  const steps = ids.map(stepById);
  const off = steps.some((st) => !st.disabled);
  updateWorkflow(() => {
    for (const st of steps) {
      if (off) st.disabled = true;
      else delete st.disabled;
    }
  });
  toast(off ? `Đã tắt ${ids.length} bước. Bấm Ctrl+/ để bật lại.` : `Đã bật lại ${ids.length} bước.`);
  return undefined;
}

/** Ctrl+D: a run is copied right after the run; loose steps each right after itself. */
export function duplicateSelection() {
  const info = selectionInfo();
  if (info.ids.length <= 1) return info.ids[0] ? duplicateStep(info.ids[0]) : undefined;
  const copies = [];
  updateWorkflow((wf) => {
    const ids = collectIds(wf);
    const aliases = collectAliases(wf, state.meta);
    if (info.contiguous) {
      const at = findStep(wf, info.ids[0], slotKeys);
      const run = at.list.slice(at.index, at.index + info.ids.length);
      const { steps } = cloneSteps(run, { ids, aliases, catalog: state.meta });
      at.list.splice(at.index + run.length, 0, ...steps);
      copies.push(...steps.map((x) => x.id));
    } else {
      // From the last one up, so earlier positions do not move.
      for (const id of [...info.ids].reverse()) {
        const at = findStep(wf, id, slotKeys);
        const { steps: [copy] } = cloneSteps([at.step], { ids, aliases, catalog: state.meta });
        at.list.splice(at.index + 1, 0, copy);
        copies.unshift(copy.id);
      }
    }
  });
  selectMany(copies, copies[0], copies[0]);
  reveal(copies[0], { flash: true });
  return undefined;
}

/** Bọc trong Lặp / Rẽ nhánh for a run (one undo step); a loose selection cannot be wrapped. */
export function wrapSelection(type) {
  const info = selectionInfo();
  if (info.ids.length <= 1) return info.ids[0] ? wrapIn(info.ids[0], type) : undefined;
  if (!info.contiguous) return toast(RUN_ONLY_WRAP);
  const container = newStep(type, { parentId: info.parentId, slot: info.slot, index: info.index }, info.ids.map(stepById));
  if (!updateWorkflow((wf) => Boolean(wrapSteps(wf, info.ids, container, { slotKeys })))) return undefined;
  select({ kind: 'step', id: container.id });
  reveal(container.id, { flash: true });
  return undefined;
}

/** Alt+↑ / Alt+↓ on a run: it moves as a block; consecutive presses are one undo step. */
export function moveSelectionBy(dir) {
  const info = selectionInfo();
  if (info.ids.length <= 1) return info.ids[0] ? moveBy(info.ids[0], dir) : false;
  if (!info.contiguous) {
    toast(RUN_ONLY_MOVE);
    return false;
  }
  const target = neighbourTargetBlock(state.workflow, info.ids, dir, state.collapsed, slotKeys);
  if (!target) return false;
  const keep = state.selection;
  updateWorkflow((wf) => moveBlock(wf, info.ids, target, slotKeys), { coalesceKey: `move:${info.ids.join(',')}` });
  select(keep);
  reveal(state.selection.id);
  return true;
}

// ---------- copy / cut / paste (system clipboard, design 0012 B) ----------

let clipMemory = null; // the last copy of this tab (for "Dán sau bước này" without clipboard access)

/** The JSON of the selection for the clipboard, or null. Remembered for the menu's Dán. */
export function selectionClipboard() {
  const ids = selectedIds();
  if (!ids.length) return null;
  const text = toClipboard(ids.map((id) => structuredClone(stepById(id))), state.workflow.name);
  clipMemory = text;
  return { text, count: ids.length };
}

/** After a copy event wrote the clipboard (or the menu fell back to memory). */
export function copied(count) {
  toast(`Đã sao chép ${count} bước.`);
}

/** Cut: the selection is removed (one undo step); paste is another. */
export function cutSelection() {
  const ids = selectedIds();
  if (!ids.length) return;
  const first = locate(ids[0]);
  const lastAt = locate(ids.at(-1));
  const next = lastAt.list[lastAt.index + 1]?.id ?? first.list[first.index - 1]?.id ?? first.parentId ?? null;
  updateWorkflow((wf) => removeSteps(wf, ids, { slotKeys }));
  select(next && stepById(next) ? { kind: 'step', id: next } : null);
  toast(`Đã cắt ${ids.length} bước. Bấm Ctrl+V để dán.`);
}

/** Where a paste goes: the "+" rule for one step; after the last one (reading order) for several. */
function pasteTarget() {
  const info = selectionInfo();
  if (info.ids.length > 1) {
    const at = locate(info.ids.at(-1));
    return { parentId: at.parentId, slot: at.slot, index: at.index + 1 };
  }
  return defaultTarget();
}

/**
 * Paste clipboard text. `fromTree`: the user pasted with focus on the steps (only then is
 * "not our steps" said). → true when steps were pasted.
 */
export function pasteText(text, { fromTree = true } = {}) {
  const parsed = parseClipboard(text, state.meta);
  if (parsed.error) {
    if (parsed.error !== 'notSteps' || fromTree) toast(parsed.message, 6000);
    return false;
  }
  const target = pasteTarget();
  let res = null;
  updateWorkflow((wf) => { res = pasteSteps(wf, target, structuredClone(parsed.steps), { catalog: state.meta, slotKeys }); return res; });
  if (!res?.ids.length) return false;
  selectMany(res.ids, res.ids[0], res.ids[0]);
  reveal(res.ids[0], { flash: true });
  const parts = [`Đã dán ${res.ids.length} bước.`];
  if (res.renamed.length) parts.push(`Đổi tên alias: ${res.renamed.map((x) => `${x.from} → ${x.to}`).join(', ')}.`);
  // References to steps that are not here (another workflow): the ordinary errors say where.
  const scope = currentScope();
  const inside = new Set(res.ids.flatMap((id) => [...subtreeIds(stepById(id), slotKeys)]));
  const missing = [...new Set(scope.refs.filter((r) => inside.has(r.nodeId) && r.code === 'unknownName' && !r.hidden).map((r) => String(r.path ?? r.name ?? '').split('.')[0]).filter(Boolean))];
  if (missing.length) parts.push(`${missing.length} tham chiếu tới bước không có ở đây (${missing.join(', ')}): xem thanh lỗi (F8).`);
  toast(parts.join(' '), res.renamed.length || missing.length ? 7000 : 3000);
  return true;
}

/** Menu "Sao chép" / "Cắt": the browser's copy command (fires the copy event), else this tab's memory. */
export function copyFromMenu(cut = false) {
  let ok = false;
  try {
    ok = document.execCommand(cut ? 'cut' : 'copy');
  } catch {
    ok = false;
  }
  if (ok) return;
  const c = selectionClipboard();
  if (!c) return;
  if (cut) cutSelection();
  else toast(`Đã sao chép ${c.count} bước (trong tab này). Dán bằng mục "Dán sau bước này".`);
}

/** Menu "Dán sau bước này": the clipboard when the browser lets us read it, else the last copy of this tab. */
export async function pasteFromMenu() {
  let text = null;
  try {
    text = await navigator.clipboard?.readText();
  } catch {
    text = null;
  }
  if (text && !parseClipboard(text, state.meta).error) return pasteText(text);
  if (clipMemory) return pasteText(clipMemory);
  if (text) return pasteText(text);
  toast('Không đọc được bộ nhớ tạm. Chọn bước rồi bấm Ctrl+V để dán.', 5000);
  return false;
}
