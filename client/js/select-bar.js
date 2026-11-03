// "Chọn nhiều bước" on narrow screens and touch (design 0012 B): no Shift / Ctrl there, so ⋯ →
// "Chọn nhiều bước" turns taps on cards into toggles and shows this toolbar where the bottom sheet
// goes (the sheet stays closed). Xong, Esc or an empty selection leave the mode; the selection
// shrinks to the main step.

import { h, ico } from './dom.js';
import { subscribe, stepById } from './store.js';
import { selectedIds, selectionInfo, inSelectMode, setSelectMode, onSelectMode, collapseToMain } from './selection.js';
import { wrapItems } from './menus.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';
import { closeSheet } from './inspector.js';
import * as ops from './ops.js';

let bar = null;
let count;

export function initSelectBar() {
  onSelectMode((on) => {
    if (on) show();
    else hide();
  });
  subscribe(({ kind }) => {
    if (!inSelectMode() || (kind !== 'selection' && kind !== 'workflow' && kind !== 'all')) return;
    if (!selectedIds().length) {
      setSelectMode(false);
      return;
    }
    update();
  });
}

function show() {
  closeSheet();
  const menuBtn = (label, attrs, items) => {
    const b = h('button', {
      ...attrs,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: () => {
        if (popupAnchor() === b) return closePopup();
        b.setAttribute('aria-expanded', 'true');
        return openPopup(b, { title: `${selectedIds().length} bước đã chọn`, items: items(), onClose: () => b.setAttribute('aria-expanded', 'false') });
      },
    }, label);
    return b;
  };
  count = h('span', { class: 'sb-count', 'aria-live': 'polite' });
  bar = h('div', { class: 'select-bar', role: 'toolbar', 'aria-label': 'Thao tác với các bước đã chọn' },
    count,
    menuBtn(['Bọc', ico('chevron-down')], { class: 'sb-wrap' }, () => wrapItems(selectionInfo())),
    h('button', { class: 'danger sb-delete', onclick: () => ops.deleteSelection() }, 'Xóa'),
    menuBtn(ico('more'), { class: 'icon sb-more', title: 'Thao tác khác', 'aria-label': 'Thao tác khác' }, moreItems),
    h('button', { class: 'primary sb-done', onclick: done }, 'Xong'));
  document.body.append(bar);
  update();
  bar.querySelector('.sb-done').focus({ preventScroll: true });
}

function moreItems() {
  const info = selectionInfo();
  const run = info.contiguous;
  const allOff = info.ids.every(isOff);
  return [
    { label: 'Sao chép', onSelect: () => ops.copyFromMenu(false) },
    { label: 'Cắt', onSelect: () => ops.copyFromMenu(true) },
    { label: 'Dán sau các bước này', onSelect: () => ops.pasteFromMenu() },
    { label: 'Nhân bản', onSelect: () => ops.duplicateSelection() },
    { label: allOff ? 'Bật các bước' : 'Tắt các bước', onSelect: () => ops.toggleSelection() },
    { label: 'Lên', disabled: !run, title: run ? undefined : ops.SELECTION_TITLES.move, onSelect: () => ops.moveSelectionBy(-1) },
    { label: 'Xuống', disabled: !run, title: run ? undefined : ops.SELECTION_TITLES.move, onSelect: () => ops.moveSelectionBy(1) },
  ];
}

const isOff = (id) => Boolean(stepById(id)?.disabled);

function update() {
  if (count) count.textContent = `${selectedIds().length} đã chọn`;
}

function done() {
  setSelectMode(false);
  collapseToMain();
}

function hide() {
  bar?.remove();
  bar = null;
  count = null;
}
