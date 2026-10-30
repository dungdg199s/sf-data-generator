// Step popups shared by both views (Quy trình and Sơ đồ, design 0003): the "+" menu of an
// insertion point and the ⋯ menu of a step. Rendering is popup.js; the actions are ops.js.

import { state, select, nodeType, slotKeys, stepById } from './store.js';
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

/** ⋯ menu of a step (also ContextMenu / Shift+F10 on the selected step). */
export function openStepMenu(anchor, id) {
  const step = stepById(id);
  if (!step) return;
  const container = slotKeys(step.type).length > 0;
  const each = ops.eachWrapPlan(id);
  const items = [
    { label: 'Nhân bản', kbd: 'Ctrl+D', onSelect: () => ops.duplicateStep(id) },
    { label: 'Lên', kbd: 'Alt+↑', onSelect: () => ops.moveBy(id, -1) },
    { label: 'Xuống', kbd: 'Alt+↓', onSelect: () => ops.moveBy(id, 1) },
    { label: 'Bọc trong Lặp', onSelect: () => ops.wrapIn(id, 'loop') },
    // Design 0012 C: a Lặp `each` around the step, over the pool it refers to (else the nearest).
    each
      ? { label: 'Bọc trong Lặp qua từng bản ghi', title: `Bọc bước này trong Lặp chạy một lần cho mỗi bản ghi của "${each.from}".`, onSelect: () => ops.wrapInEach(id) }
      : { label: 'Bọc trong Lặp qua từng bản ghi', disabled: true, title: 'Chưa có pool nào phía trên (bước Query, Record hoặc Chọn bản ghi có alias). Thêm một bước như vậy ở phía trên trước.' },
    { label: 'Bọc trong Rẽ nhánh', onSelect: () => ops.wrapIn(id, 'branch') },
    // Design 0010: a Lặp over each record of this step's pool, right after it.
    isPoolStep(step)
      ? step.config?.alias
        ? { label: 'Lặp qua từng bản ghi', title: `Thêm bước Lặp ngay sau bước này, chạy một lần cho mỗi bản ghi của "${step.config.alias}".`, onSelect: () => ops.addEachLoopAfter(id) }
        : { label: 'Lặp qua từng bản ghi', disabled: true, title: 'Đặt alias cho bước này trước.' }
      : null,
    container
      ? { label: 'Bỏ vỏ (giữ các bước bên trong)', disabled: !ops.canUnwrap(step), title: ops.canUnwrap(step) ? undefined : 'Chỉ bỏ vỏ được khi một nhánh trống.', onSelect: () => ops.unwrap(id) }
      : null,
    { label: step.disabled ? 'Bật bước' : 'Tắt bước', kbd: 'Ctrl+/', onSelect: () => ops.toggleDisabled(id) },
    { label: 'Xóa', kbd: 'Delete', danger: true, onSelect: () => ops.deleteStep(id) },
  ].filter(Boolean);
  select({ kind: 'step', id });
  openPopup(anchor, { title: stepLabel(step), items });
}
