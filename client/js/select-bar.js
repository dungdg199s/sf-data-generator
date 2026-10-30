// Narrow screens and touch (design 0012 B): no Shift / Ctrl, so "⋯ → Chọn nhiều bước" starts a
// select mode (selection.js) where a tap adds or removes a card, and this bar, docked where the
// bottom sheet would be, acts on the selection: [n đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong].

import { h } from './dom.js';
import { subscribe } from './store.js';
import { selectedIds, inSelectMode, onSelectMode, setSelectMode, collapseToPrimary } from './selection.js';
import { wrapItems, editItems, moveItems, offDeleteItems } from './menus.js';
import { openPopup, popupAnchor, closePopup } from './popup.js';
import { closeSheet } from './inspector.js';
import * as ops from './ops.js';

let bar;

export function initSelectBar() {
  bar = h('div', { class: 'select-bar', role: 'toolbar', 'aria-label': 'Thao tác với các bước đã chọn', hidden: true });
  document.body.append(bar);
  onSelectMode((on) => {
    bar.hidden = !on;
    if (on) {
      closeSheet();
      render();
      bar.querySelector('button')?.focus({ preventScroll: true });
    } else closePopup();
  });
  subscribe(({ kind }) => {
    if (inSelectMode() && (kind === 'selection' || kind === 'workflow' || kind === 'all')) render();
  });
}

/** Xong / Esc: leave the select mode; the selection shrinks to the primary step, the sheet stays closed. */
export function exitSelectMode() {
  if (!inSelectMode()) return;
  setSelectMode(false);
  collapseToPrimary();
  closeSheet();
}

function toggleMenu(button, title, items) {
  if (popupAnchor() === button) return closePopup();
  button.setAttribute('aria-expanded', 'true');
  return openPopup(button, { title, items, onClose: () => button.setAttribute('aria-expanded', 'false') });
}

function render() {
  const n = selectedIds().length;
  bar.replaceChildren(
    h('span', { class: 'sb-count' }, `${n} đã chọn`),
    h('button', { class: 'sb-wrap', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: !n, onclick: (e) => toggleMenu(e.currentTarget, 'Bọc', wrapItems()) }, 'Bọc ▾'),
    h('button', { class: 'danger', disabled: !n, onclick: () => ops.deleteSelection() }, 'Xóa'),
    h('button', {
      class: 'icon',
      title: 'Thao tác khác',
      'aria-label': 'Thao tác khác với các bước đã chọn',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      disabled: !n,
      onclick: (e) => toggleMenu(e.currentTarget, `${n} bước đã chọn`, [...editItems({ pasteLabel: 'Dán' }), offDeleteItems()[0], ...moveItems()]),
    }, '⋯'),
    h('button', { class: 'primary', onclick: exitSelectMode }, 'Xong'),
  );
}
