// Shared popup menu (docs/ui-design-system.md §6.7, design 0009): the "+" menu, the step menu,
// the "⋯" menu of the top bar and the "⤓ Tải" menu of the results panel. One popup at a time.
//
// Items:
//   { group }                                   group header
//   { separator: true }                         ends the group; the next rows stand alone under a line
//   { type, label, desc, kbd, disabled, title, danger, onSelect }   a menu row (`type`: step-type icon tile)
//   { label, checked, onSelect }                a radio row (role=menuitemradio, ✓ when checked)
//   { field: { label, value, placeholder, title, onInput, onEnter } }  a label + text input row
// Arrow keys move between rows and inputs; a printable key jumps to the next row starting with
// it (not while an input has focus); Esc and Tab / Shift+Tab close it and put focus back on the
// anchor. ARIA: role=menu holds only menu items and role=group (one per group header, named by
// it); the title and headers are aria-hidden text, inputs always sit in a group.

import { h, icoTile } from './dom.js';

let popup = null; // { el, anchor, onClose }

export const isPopupOpen = () => Boolean(popup);
/** The element the open popup belongs to (a second click on it closes the popup). */
export const popupAnchor = () => popup?.anchor ?? null;

export function closePopup(refocus = false) {
  if (!popup) return;
  const { el, anchor, onClose } = popup;
  popup = null;
  el.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  onClose?.();
  if (refocus && anchor?.isConnected) anchor.focus();
}

function onOutside(e) {
  if (popup && !popup.el.contains(e.target) && !popup.anchor?.contains(e.target)) closePopup();
}

function fieldRow(f) {
  const input = h('input', {
    type: 'text',
    class: 'popup-input',
    value: f.value ?? '',
    placeholder: f.placeholder,
    title: f.title,
    'aria-label': f.label,
    oninput: (e) => f.onInput?.(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        f.onEnter?.(input.value);
      }
    },
  });
  if (f.id) input.dataset.field = f.id;
  return { row: h('label', { class: 'popup-field', title: f.title }, h('span', { class: 'pf-label' }, f.label), input), input };
}

/**
 * Opens a popup under (or above, if there is no room) `anchor`.
 * opts: { title, items, search, searchLabel, onClose, focus } — `focus`: data-field of an input to focus first.
 */
export function openPopup(anchor, { title, items, search = false, searchLabel = 'Tìm loại bước…', onClose = null, focus = null }) {
  closePopup();
  const list = h('div', { class: 'popup-items', role: 'none' });
  const focusables = []; // enabled rows and inputs, in order
  const build = (q = '') => {
    focusables.length = 0;
    const needle = q.trim().toLowerCase();
    // `searchOnly` rows (the library's older entries) only show up as search results.
    const shown = items.filter((it) => it.group || it.separator || it.field || (!needle ? !it.searchOnly : `${it.label} ${it.desc ?? ''}`.toLowerCase().includes(needle)));
    const out = [];
    let group = null; // the role=group rows go into, after a group header
    for (const [i, it] of shown.entries()) {
      if (it.separator) {
        // Ends the current group: the rows after it stand alone, under a line.
        group = null;
        if (out.length && shown[i + 1] && !shown[i + 1].group) out.push(h('div', { class: 'popup-sep', role: 'separator' }));
        continue;
      }
      if (it.group) {
        if (!shown[i + 1] || shown[i + 1].group || shown[i + 1].separator) continue; // empty after filtering
        group = h('div', { class: 'popup-groupbox', role: 'group', 'aria-label': it.group }, h('div', { class: 'popup-group', 'aria-hidden': 'true' }, it.group));
        out.push(group);
        continue;
      }
      let el;
      if (it.field) {
        const { row, input } = fieldRow(it.field);
        focusables.push(input);
        el = row;
      } else el = item(it);
      if (group) group.append(el);
      else if (it.field) out.push(h('div', { role: 'group', 'aria-label': it.field.label }, el));
      else out.push(el);
    }
    list.replaceChildren(...out);
  };
  const item = (it) => {
    const radio = it.checked !== undefined;
    const b = h('button', {
      class: `popup-item${it.danger ? ' danger' : ''}`,
      role: radio ? 'menuitemradio' : 'menuitem',
      'aria-checked': radio ? String(Boolean(it.checked)) : undefined,
      'data-type': it.type,
      disabled: it.disabled,
      title: it.title,
      onclick: () => {
        closePopup();
        it.onSelect();
      },
    },
    h('span', { class: 'pi-label' }, it.type ? icoTile() : null, radio ? h('span', { class: 'pi-check', 'aria-hidden': 'true' }, it.checked ? '✓' : '') : null, it.label),
    it.desc ? h('small', {}, it.desc) : null,
    it.kbd ? h('kbd', {}, it.kbd) : null);
    if (!it.disabled) focusables.push(b);
    return b;
  };
  build();
  const searchInput = search ? h('input', { class: 'popup-search', placeholder: searchLabel, 'aria-label': searchLabel.replace(/…$/, ''), oninput: (e) => build(e.target.value) }) : null;
  const el = h('div', { class: 'popup', role: 'menu', 'aria-label': title },
    title ? h('div', { class: 'popup-title', 'aria-hidden': 'true' }, title) : null,
    searchInput ? h('div', { role: 'group', 'aria-label': searchLabel.replace(/…$/, '') }, searchInput) : null,
    list);
  el.addEventListener('keydown', (e) => {
    const i = focusables.indexOf(document.activeElement);
    const inInput = e.target.matches('input');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = focusables.length;
      if (n) focusables[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
    } else if (e.key === 'Tab') {
      // Leaving the menu: back to its button (not to either end of the page).
      e.preventDefault();
      closePopup(true);
    } else if (!inInput && e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const buttons = focusables.filter((x) => x.matches('button'));
      const at = buttons.indexOf(document.activeElement);
      const order = [...buttons.slice(at + 1), ...buttons.slice(0, at + 1)];
      order.find((b) => b.textContent.replace(/^✓/, '').trim().toLowerCase().startsWith(k))?.focus();
    }
  });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  popup = { el, anchor, onClose };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  const first = focus ? el.querySelector(`[data-field="${CSS.escape(focus)}"]`) : null;
  (first ?? searchInput ?? focusables[0])?.focus();
  return el;
}
