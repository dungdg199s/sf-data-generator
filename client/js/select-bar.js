// Narrow screens and touch (design 0012 B): no Shift / Ctrl, so "⋯ → Chọn nhiều bước" starts a
// select mode (selection.js) where a tap adds or removes a card, and this bar, docked where the
// bottom sheet would be, acts on the selection: [n đã chọn] [Bọc ▾] [Xóa] [⋯] [Xong].

import { h, ico } from './dom.js';
import { subscribe } from './store.js';
import { selectedIds, inSelectMode, onSelectMode, setSelectMode, collapseToPrimary } from './selection.js';
import { wrapItems, editItems, moveItems, offDeleteItems } from './menus.js';
import { openPopup, popupAnchor, closePopup } from './popup.js';
import { closeSheet } from './inspector.js';
import * as ops from './ops.js';

let bar;
let parts = null; // { count, wrap, del, more, done }: built once, then only patched (focus stays put)

export function initSelectBar() {
  const n = () => selectedIds().length;
  parts = {
    count: h('span', { class: 'sb-count' }),
    wrap: h('button', { class: 'sb-wrap', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => toggleMenu(e.currentTarget, 'Bọc', wrapItems()) }, 'Bọc', ico('chevron-down')),
    del: h('button', { class: 'danger', onclick: () => ops.deleteSelection() }, 'Xóa'),
    more: h('button', {
      class: 'icon',
      title: 'Thao tác khác',
      'aria-label': 'Thao tác khác với các bước đã chọn',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: (e) => toggleMenu(e.currentTarget, `${n()} bước đã chọn`, [...editItems({ pasteLabel: 'Dán' }), offDeleteItems()[0], ...moveItems()]),
    }, ico('more')),
    done: h('button', { class: 'primary', onclick: exitSelectMode }, 'Xong'),
  };
  bar = h('div', { class: 'select-bar', role: 'toolbar', 'aria-label': 'Thao tác với các bước đã chọn', hidden: true },
    parts.count, parts.wrap, parts.del, parts.more, parts.done);
  // role=toolbar: one tab stop, ← / → (Home / End) move between the buttons.
  bar.addEventListener('keydown', (e) => {
    const buttons = [...bar.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    focusButton(buttons[(next + buttons.length) % buttons.length]);
  });
  bar.addEventListener('focusin', (e) => { if (e.target.matches('button')) focusButton(e.target, false); });
  document.body.append(bar);
  onSelectMode((on) => {
    bar.hidden = !on;
    if (on) {
      closeSheet();
      update();
      focusButton(parts.wrap.disabled ? parts.done : parts.wrap);
    } else closePopup();
  });
  subscribe(({ kind }) => {
    if (inSelectMode() && (kind === 'selection' || kind === 'workflow' || kind === 'all')) update();
  });
}

/** Roving tabindex of the toolbar: `b` is its only tab stop. */
function focusButton(b, move = true) {
  for (const x of bar.querySelectorAll('button')) x.tabIndex = x === b ? 0 : -1;
  if (move) b.focus({ preventScroll: true });
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

/** Count text and disabled flags only: the buttons stay, and so does focus. */
function update() {
  const n = selectedIds().length;
  const text = `${n} đã chọn`;
  if (parts.count.textContent !== text) parts.count.textContent = text;
  for (const b of [parts.wrap, parts.del, parts.more]) b.disabled = !n;
  // A disabled button cannot keep the tab stop, nor focus: when focus was on it (it falls to
  // <body>), it goes to Xong so the keyboard stays in the bar.
  if (!bar.querySelector('button[tabindex="0"]:not(:disabled)')) {
    const move = bar.contains(document.activeElement) || document.activeElement === document.body;
    focusButton(parts.done, move);
  }
}
