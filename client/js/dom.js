// Tiny DOM helper: h('div', { class: 'x', onclick }, child, 'text').

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * Step-type icon tile (docs/ui-design-system.md §5, §6.1). Colour and icon come from the
 * nearest `[data-type]` ancestor in CSS, so callers only set `data-type`.
 */
export function icoTile() {
  return h('span', { class: 'ico-tile', 'aria-hidden': 'true' }, h('span', { class: 'ico' }));
}

/**
 * Action icon (design 0014 §1): `<span class="ico" data-ico="name" aria-hidden="true">`. The SVG is the
 * `--ico-<name>` token, picked by one `.ico[data-ico="<name>"]` rule in app.css; the colour is the
 * text colour of the button around it. A button with only an icon needs an `aria-label` in words.
 */
export function ico(name) {
  return h('span', { class: 'ico', 'data-ico': name, 'aria-hidden': 'true' });
}

let toastTimer;
let toastGeneration = 0;
let toastEl = null;
/**
 * Short status message at the bottom. With `action: { label, onClick }` (or a list of them) the
 * toast gets buttons (e.g. "Hoàn tác") and stays a little longer; `ms` Infinity: until a button is
 * used or another toast replaces it. Returns { removeAction() } to drop the buttons later (no-op
 * once another toast replaced this one).
 */
export function toast(message, ms = 2600, action = null) {
  toastEl ??= document.getElementById('toast');
  const el = toastEl;
  // One action, or several (design 0012 A: "Dùng bản ở tab kia" / "Giữ bản của tab này").
  const actions = Array.isArray(action) ? action : action ? [action] : [];
  // Over a modal dialog (Quản lý thư viện, design 0012 A) a toast with a button must be in the
  // dialog's top layer to be clickable; other toasts stay on the page.
  const host = (actions.length && document.querySelector('dialog[open]')) || document.body;
  if (el.parentElement !== host) host.append(el);
  const generation = ++toastGeneration;
  el.replaceChildren(document.createTextNode(message));
  for (const a of actions) {
    el.append(' ', h('button', {
      class: 'toast-action',
      onclick: () => {
        el.classList.remove('show');
        a.onClick();
      },
    }, a.label));
  }
  el.classList.toggle('has-action', actions.length > 0);
  el.classList.add('show');
  clearTimeout(toastTimer);
  // ms Infinity: stays until an action is chosen (or another toast replaces it).
  if (ms !== Infinity) toastTimer = setTimeout(() => el.classList.remove('show'), actions.length ? Math.max(ms, 6000) : ms);
  return {
    removeAction() {
      if (generation !== toastGeneration) return;
      for (const b of el.querySelectorAll('.toast-action')) b.remove();
      el.classList.remove('has-action');
    },
  };
}

/** Saves `content` (a string, or a Blob as returned by /api/export) as a file. */
export function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A dialog re-rendered its content: keep a toast shown over it (its "Hoàn tác" button). */
export function keepToast(dialog) {
  if (toastEl?.classList.contains('show') && toastEl.parentElement !== dialog) dialog.append(toastEl);
}

/** The dialog closed: the toast goes back to the page. */
export function releaseToast() {
  if (toastEl && toastEl.parentElement !== document.body) document.body.append(toastEl);
}
