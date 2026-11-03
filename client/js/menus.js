// Step popups shared by both views (Quy trình and Sơ đồ, design 0003): the "+" menu of an
// insertion point and the ⋯ menu of a step. Rendering is popup.js; the actions are ops.js.

import { state, select, nodeType, slotKeys, stepById } from './store.js';
import { selectedIds, selectionInfo, inSelectMode, setSelectMode } from './selection.js';
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

const NO_POOL = 'Chưa có pool nào phía trên (bước Query, Record hoặc Chọn bản ghi có alias). Thêm một bước như vậy ở phía trên trước.';

/** "Bọc trong Lặp qua từng bản ghi" (design 0012 C) for the steps `ids`: disabled without a usable pool. */
export function eachItem(ids, { disabled = false, title } = {}) {
  const plan = disabled ? null : ops.eachWrapPlan(ids);
  if (disabled || !plan) return { label: 'Bọc trong Lặp qua từng bản ghi', disabled: true, title: title ?? NO_POOL };
  return { label: 'Bọc trong Lặp qua từng bản ghi', title: `Thêm bước Lặp quanh ${ids.length > 1 ? 'các bước này' : 'bước này'}, chạy một lần cho mỗi bản ghi của "${plan.from}".`, onSelect: () => ops.wrapInEach(ids) };
}

const COARSE = window.matchMedia('(max-width: 900px), (pointer: coarse)');

/**
 * ⋯ menu of a step (also ContextMenu / Shift+F10 on the selected step), in groups (design 0012 B):
 * Chỉnh sửa, Di chuyển, Bọc, Chọn (narrow / touch), then Tắt and Xóa. On a card of a selection of
 * several steps the items act on all of them (title "3 bước đã chọn"; move and wrap only for a
 * run); on another card the selection shrinks to that card first.
 */
export function openStepMenu(anchor, id) {
  const step = stepById(id);
  if (!step) return;
  const ids = selectedIds();
  const many = ids.length > 1 && ids.includes(id);
  if (!many) select({ kind: 'step', id, anchor: id });
  else if (state.selection.id !== id) select({ ...state.selection, id });
  openPopup(anchor, { title: many ? `${ids.length} bước đã chọn` : stepLabel(step), items: stepMenuItems(id, many) });
}

/** Items of the ⋯ menu for step `id` (or the selection of several steps when `many`). */
export function stepMenuItems(id, many = false) {
  const step = stepById(id);
  const info = many ? selectionInfo() : { ids: [id], contiguous: true };
  const run = info.contiguous;
  const runOnly = (item, title) => (run ? item : { ...item, disabled: true, title, onSelect: undefined });
  const container = slotKeys(step.type).length > 0;
  const allOff = info.ids.every((x) => stepById(x)?.disabled);
  const items = [
    { group: 'Chỉnh sửa' },
    { label: 'Sao chép', kbd: 'Ctrl+C', onSelect: () => ops.copyFromMenu(false) },
    { label: 'Cắt', kbd: 'Ctrl+X', onSelect: () => ops.copyFromMenu(true) },
    { label: many ? 'Dán sau các bước này' : 'Dán sau bước này', kbd: 'Ctrl+V', onSelect: () => ops.pasteFromMenu() },
    { label: 'Nhân bản', kbd: 'Ctrl+D', onSelect: () => ops.duplicateSelection() },
    { group: 'Di chuyển' },
    runOnly({ label: 'Lên', kbd: 'Alt+↑', onSelect: () => ops.moveSelectionBy(-1) }, ops.SELECTION_TITLES.move),
    runOnly({ label: 'Xuống', kbd: 'Alt+↓', onSelect: () => ops.moveSelectionBy(1) }, ops.SELECTION_TITLES.move),
    { group: 'Bọc' },
    ...wrapItems(info),
    // Design 0010: a Lặp over each record of this step's pool, right after it.
    !many && isPoolStep(step)
      ? step.config?.alias
        ? { label: 'Lặp qua từng bản ghi', title: `Thêm bước Lặp ngay sau bước này, chạy một lần cho mỗi bản ghi của "${step.config.alias}".`, onSelect: () => ops.addEachLoopAfter(id) }
        : { label: 'Lặp qua từng bản ghi', disabled: true, title: 'Đặt alias cho bước này trước.' }
      : null,
    !many && container
      ? { label: 'Bỏ vỏ (giữ các bước bên trong)', disabled: !ops.canUnwrap(step), title: ops.canUnwrap(step) ? undefined : 'Chỉ bỏ vỏ được khi một nhánh trống.', onSelect: () => ops.unwrap(id) }
      : null,
    COARSE.matches && !inSelectMode() ? { group: 'Chọn' } : null,
    COARSE.matches && !inSelectMode() ? { label: 'Chọn nhiều bước', title: 'Chạm các thẻ khác để chọn thêm; thao tác ở thanh dưới.', onSelect: () => startSelectMode(id) } : null,
    { group: 'Tắt / xóa' },
    { label: many ? (allOff ? `Bật ${info.ids.length} bước` : `Tắt ${info.ids.length} bước`) : step.disabled ? 'Bật bước' : 'Tắt bước', kbd: 'Ctrl+/', onSelect: () => ops.toggleSelection() },
    { label: many ? `Xóa ${info.ids.length} bước` : 'Xóa', kbd: 'Delete', danger: true, onSelect: () => ops.deleteSelection() },
  ];
  return items.filter(Boolean);
}

/** The three kinds of wrapping for the selection `info` (only a run of neighbours can be wrapped). */
export function wrapItems(info) {
  const title = info.contiguous ? undefined : ops.SELECTION_TITLES.wrap;
  return [
    { label: 'Bọc trong Lặp', disabled: !info.contiguous, title, onSelect: () => ops.wrapSelection('loop') },
    info.contiguous ? eachItem(info.ids) : eachItem(info.ids, { disabled: true, title }),
    { label: 'Bọc trong Rẽ nhánh', disabled: !info.contiguous, title, onSelect: () => ops.wrapSelection('branch') },
  ];
}

/** ⋯ → "Chọn nhiều bước" (narrow screens, touch): the card is the first one selected. */
function startSelectMode(id) {
  select({ kind: 'step', id, anchor: id });
  setSelectMode(true);
}
