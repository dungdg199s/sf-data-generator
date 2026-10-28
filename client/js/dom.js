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

let toastTimer;
let toastGeneration = 0;
/**
 * Short status message at the bottom. With `action: { label, onClick }` the toast gets a
 * button (e.g. "Hoàn tác") and stays a little longer. Returns { removeAction() } to drop the
 * button later (no-op once another toast replaced this one).
 */
export function toast(message, ms = 2600, action = null) {
  const el = document.getElementById('toast');
  const generation = ++toastGeneration;
  el.replaceChildren(document.createTextNode(message));
  if (action) {
    el.append(' ', h('button', {
      class: 'toast-action',
      onclick: () => {
        el.classList.remove('show');
        action.onClick();
      },
    }, action.label));
  }
  el.classList.toggle('has-action', Boolean(action));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 6000) : ms);
  return {
    removeAction() {
      if (generation !== toastGeneration) return;
      el.querySelector('.toast-action')?.remove();
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
