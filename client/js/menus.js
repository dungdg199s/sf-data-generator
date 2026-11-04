// Step popups shared by both views (Quy trình and Sơ đồ, design 0003): the "+" menu of an
// insertion point and the ⋯ menu of a step. Rendering is popup.js; the actions are ops.js.

import { state, select, nodeType, slotKeys, stepById } from './store.js';
import { selectedIds, selectionInfo, isSelected, setSelectMode } from './selection.js';
import { exposesOf } from '/shared/scope.js';
import { stepLabel } from './summary.js';
import * as ops from './ops.js';
import { openPopup } from './popup.js';

/** "+" menu: step types grouped by `category` (catalogue order), inserted at `target`. */
export function openAddMenu(anchor, target) {
  const types = state.meta.nodeTypes;
  const items = [];
  const row = (t) => ({ type: t.type, label: t.label, desc: t.description.split('.')[0], onSelect: () => ops.addStep(t.type, target) });
  for (const cat of state.meta.stepCategories ?? []) {
    const inCat = types.filter((t) => t.category === cat.key);
    if (!inCat.length) continue;
    items.push({ group: cat.label }, ...inCat.map(row));
  }
  const rest = types.filter((t) => !(state.meta.stepCategories ?? []).some((c) => c.key === t.category));
  items.push(...rest.map(row));
  openPopup(anchor, { title: 'Thêm bước', items, search: types.length > 6 });
}

/** A step whose records a Lặp `each` can loop over: a pool (`exposes.pool`) named by `alias` (catalogue). */
const isPoolStep = (step) => exposesOf(nodeType(step.type), step.config).some(({ ex }) => ex.pool === true && ex.name?.key === 'alias');

/** Wide pointer-less screens have no Shift / Ctrl: "Chọn nhiều bước" starts the select mode there. */
const SELECT_MODE_MQ = window.matchMedia('(max-width: 900px), (pointer: coarse)');

/**
 * Wrap rows of the selection (menu ⋯, the narrow select bar's "Bọc ▾", the inspector's multi
 * panel): Lặp, Lặp qua từng bản ghi (C), Rẽ nhánh; locked with the reason when the selection is
 * not one block, or when no pool is usable.
 */
export function wrapItems() {
  const block = selectionInfo().contiguous;
  const each = block ? ops.selectionEachPlan() : null;
  const locked = block ? null : { disabled: true, title: ops.NOT_BLOCK_WRAP };
  const n = selectedIds().length;
  const what = n > 1 ? `${n} bước này` : 'bước này';
  return [
    { label: 'Bọc trong Lặp', ...locked, onSelect: () => ops.wrapSelection('loop') },
    // Design 0012 C: a Lặp `each` around the steps, over the pool they refer to (else the nearest).
    locked
      ? { label: 'Bọc trong Lặp qua từng bản ghi', ...locked, onSelect: () => {} }
      : each
        ? { label: 'Bọc trong Lặp qua từng bản ghi', title: `Bọc ${what} trong Lặp chạy một lần cho mỗi bản ghi của "${each.from}".`, onSelect: () => ops.wrapSelectionEach() }
        : { label: 'Bọc trong Lặp qua từng bản ghi', disabled: true, title: ops.NO_POOL, onSelect: () => {} },
    { label: 'Bọc trong Rẽ nhánh', ...locked, onSelect: () => ops.wrapSelection('branch') },
  ];
}

/** Sao chép, Cắt, Dán, Nhân bản of the selection. */
export function editItems({ pasteLabel = 'Dán sau bước này' } = {}) {
  return [
    { label: 'Sao chép', kbd: 'Ctrl+C', onSelect: () => ops.clipboardCommand(false) },
    { label: 'Cắt', kbd: 'Ctrl+X', onSelect: () => ops.clipboardCommand(true) },
    { label: pasteLabel, kbd: 'Ctrl+V', onSelect: () => ops.pasteCommand() },
    { label: 'Nhân bản', kbd: 'Ctrl+D', onSelect: () => ops.duplicateSelection() },
  ];
}

/** Lên / Xuống of the selection (locked for scattered steps). */
export function moveItems() {
  const locked = selectionInfo().contiguous ? null : { disabled: true, title: ops.NOT_BLOCK_MOVE };
  return [
    { label: 'Lên', kbd: 'Alt+↑', ...locked, onSelect: () => ops.moveSelectionBy(-1) },
    { label: 'Xuống', kbd: 'Alt+↓', ...locked, onSelect: () => ops.moveSelectionBy(1) },
  ];
}

/** Tắt / Bật and Xóa of the selection. */
export function offDeleteItems() {
  const ids = selectedIds();
  const steps = ids.map(stepById);
  const n = ids.length;
  const off = steps.some((s) => !s.disabled);
  return [
    { label: n > 1 ? `${off ? 'Tắt' : 'Bật'} ${n} bước` : off ? 'Tắt bước' : 'Bật bước', kbd: 'Ctrl+/', onSelect: () => ops.toggleSelectionDisabled() },
    { label: n > 1 ? `Xóa ${n} bước` : 'Xóa', kbd: 'Delete', danger: true, onSelect: () => ops.deleteSelection() },
  ];
}

/**
 * ⋯ menu of a step (also ContextMenu / Shift+F10 on the selected step), grouped (design 0012 B).
 * On a card of a multi-selection it acts on the whole selection; on any other card the selection
 * becomes that card.
 */
export function openStepMenu(anchor, id) {
  const step = stepById(id);
  if (!step) return;
  if (!isSelected(id) || selectedIds().length < 2) select({ kind: 'step', id });
  const n = selectedIds().length;
  const items = [{ group: 'Chỉnh sửa' }, ...editItems(), { group: 'Di chuyển' }, ...moveItems(), { group: 'Bọc' }, ...wrapItems()];
  if (n === 1) {
    const container = slotKeys(step.type).length > 0;
    // Design 0010: a Lặp over each record of this step's pool, right after it.
    if (isPoolStep(step)) {
      items.push(step.config?.alias
        ? { label: 'Lặp qua từng bản ghi', title: `Thêm bước Lặp ngay sau bước này, chạy một lần cho mỗi bản ghi của "${step.config.alias}".`, onSelect: () => ops.addEachLoopAfter(id) }
        : { label: 'Lặp qua từng bản ghi', disabled: true, title: 'Đặt alias cho bước này trước.', onSelect: () => {} });
    }
    if (container) {
      items.push({ label: 'Bỏ vỏ (giữ các bước bên trong)', disabled: !ops.canUnwrap(step), title: ops.canUnwrap(step) ? undefined : 'Chỉ bỏ vỏ được khi một nhánh trống.', onSelect: () => ops.unwrap(id) });
    }
    if (SELECT_MODE_MQ.matches) {
      items.push({ group: 'Chọn' }, { label: 'Chọn nhiều bước', title: 'Chạm các thẻ khác để chọn thêm; thao tác ở thanh dưới đáy.', onSelect: () => setSelectMode(true) });
    }
  }
  items.push({ separator: true }, ...offDeleteItems());
  openPopup(anchor, { title: n > 1 ? `${n} bước đã chọn` : stepLabel(step), items });
}
