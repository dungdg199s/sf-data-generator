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
 * Action icon (design 0014 §1, docs/ui-design-system.md §5): a mask of `--ico-<name>`, coloured by
 * currentColor, hidden from screen readers (an icon-only button needs its own aria-label).
 */
export function ico(name) {
  return h('span', { class: 'ico', 'data-ico': name, 'aria-hidden': 'true' });
}

/**
 * Horizontal-scroll hint (design 0014 §4): sets `data-overflow="start" | "end" | "both"` on `el` while
 * it has hidden items on that side (CSS fades that edge), and removes it when nothing overflows.
 * Recomputed once per frame on scroll, resize and content changes. A vertical wheel over an
 * overflowing row scrolls it sideways, and only while it can still move that way (then the page
 * gets the wheel back). → a function that stops watching.
 */
export function watchOverflow(el) {
  let frame = 0;
  const update = () => {
    frame = 0;
    const max = el.scrollWidth - el.clientWidth;
    const start = max > 1 && el.scrollLeft > 1;
    const end = max > 1 && el.scrollLeft < max - 1;
    const v = start && end ? 'both' : start ? 'start' : end ? 'end' : null;
    if (!v) el.removeAttribute('data-overflow');
    else if (el.dataset.overflow !== v) el.dataset.overflow = v;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const onWheel = (e) => {
    if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) return;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
    if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max - 1)) return;
    e.preventDefault();
    el.scrollLeft += delta;
  };
  el.addEventListener('scroll', schedule, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: false });
  const resize = new ResizeObserver(schedule);
  resize.observe(el);
  const mutation = new MutationObserver(schedule);
  mutation.observe(el, { childList: true, characterData: true, subtree: true });
  update();
  return () => {
    cancelAnimationFrame(frame);
    el.removeEventListener('scroll', schedule);
    el.removeEventListener('wheel', onWheel);
    resize.disconnect();
    mutation.disconnect();
  };
}

let toastTimer;
let toastGeneration = 0;
/**
 * Short status message at the bottom. With `action: { label, onClick }` (or a list of them) the
 * toast gets buttons (e.g. "Hoàn tác") and stays a little longer; `ms: Infinity` keeps it until
 * a button is pressed or another toast replaces it. Returns { removeAction(), hide() } (no-ops
 * once another toast replaced this one).
 */
export function toast(message, ms = 2600, action = null) {
  const el = document.getElementById('toast');
  const generation = ++toastGeneration;
  const actions = Array.isArray(action) ? action : action ? [action] : [];
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
  if (Number.isFinite(ms)) toastTimer = setTimeout(() => el.classList.remove('show'), actions.length ? Math.max(ms, 6000) : ms);
  return {
    removeAction() {
      if (generation !== toastGeneration) return;
      for (const b of el.querySelectorAll('.toast-action')) b.remove();
      el.classList.remove('has-action');
    },
    hide() {
      if (generation === toastGeneration) el.classList.remove('show');
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
