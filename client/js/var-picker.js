// Variable picker (design 0005): a popup that lists the variables usable at the field being
// edited, grouped by source step, with type and sample values, and inserts the chosen one.
// Attached by forms.js to every option that declares `vars` ('template': insert {{path}} at the
// caret; 'path': replace the whole value). Opens with the {x} button, Ctrl+Space, typing "{{"
// (template) or focusing an empty / pressing ↓ in a path field.
//
// The input keeps the raw text; a read-only chip strip under it shows each {{…}} token, red
// when validation reports it, grey while it matches no source. Insertions go through
// execCommand('insertText') so the field's native undo still works, and each one is its own
// undo step in the store (unique coalesceKey).

import { h, icoTile } from './dom.js';
import { state, subscribe, stepById, currentScope } from './store.js';
import { groupsFor, matchScore, tokenize, refAt, previewOf, formatSample, typeLabel, MAX_ROWS } from './variables.js';

let uid = 0;
let open = null; // { el, input, opts, mode, query, items, active, replace, render }
const strips = new Set(); // live chip strips, refreshed on validation and run results

// Strips are redrawn at most once per animation frame, however many events arrive.
const dirty = new Set();
let frame = 0;
function schedule(strip) {
  dirty.add(strip);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  for (const s of dirty) {
    if (!s.input.isConnected) strips.delete(s);
    else s.refresh();
  }
  dirty.clear();
}

subscribe(({ kind }) => {
  if (kind !== 'issues' && kind !== 'result' && kind !== 'workflow') return;
  for (const s of strips) schedule(s);
  if (open && kind === 'result') open.render();
  if (open && !open.input.isConnected) closePicker();
});

/**
 * Wire the picker to `input` (an <input type=text> rendered by forms.js).
 * opts: { mode: 'template' | 'path', stepId, fieldIndex?, field, option, fieldName?, unsaved }
 * → { wrap (input + {x} button), strip (chips + preview line) }
 */
export function attachVarPicker(input, opts) {
  const listId = `vp-list-${++uid}`;
  input.classList.add('var-field');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false'); // aria-controls is set only while the list exists
  input.spellcheck = false;
  let unsaved = Boolean(opts.unsaved);
  const state0 = { listId, opts, get unsaved() { return unsaved; }, set unsaved(v) { unsaved = v; } };
  input._varPicker = state0;

  const btn = h('button', {
    type: 'button',
    class: 'var-btn',
    title: opts.mode === 'template' ? 'Chèn biến (gõ {{ hoặc Ctrl+Space)' : 'Chọn biến (Ctrl+Space)',
    'aria-label': 'Chèn biến',
    onmousedown: (e) => e.preventDefault(), // keep the caret/selection of the input
    onclick: () => (open?.input === input && !open.auto ? closePicker() : openPicker(input, { focusSearch: true })),
  }, '{x}');
  const wrap = h('div', { class: 'var-input' }, input, btn);

  // One tab stop for the whole strip; ←/→ (Home/End) move between chips (roving tabindex).
  const chips = h('div', { class: 'var-chips', role: 'toolbar', 'aria-label': 'Biến đã chèn', onkeydown: (e) => chipKey(e, chips) });
  const preview = h('div', { class: 'var-preview', hidden: true });
  const strip = h('div', { class: 'var-strip' }, chips, preview);
  const entry = { input, refresh: () => renderStrip(input, opts, chips, preview) };
  strips.add(entry);
  entry.refresh();

  input.addEventListener('input', () => {
    if (!input._varInsert) unsaved = false;
    schedule(entry);
    if (opts.mode === 'template') autocomplete(input);
    else if (open?.input === input && !open.searchFocused) {
      open.auto = pathRange(input);
      open.query = open.auto.query;
      open.touched = true;
      open.render();
    }
  });
  input.addEventListener('keydown', (e) => onFieldKey(e, input));
  // Path fields open like a combobox on a click (or ↓ / Ctrl+Space), never on focus alone, so
  // tabbing through the form cannot pick a variable.
  input.addEventListener('click', () => {
    if (opts.mode === 'template') autocomplete(input, { onlyUpdate: true });
    else if (open?.input !== input) openPicker(input, { auto: pathRange(input) });
  });
  input.addEventListener('blur', () => {
    // Autocomplete mode lives in the field: leaving it closes the list (clicks inside the
    // popup do not blur it, see onmousedown there).
    setTimeout(() => { if (open?.input === input && !open.el.contains(document.activeElement) && document.activeElement !== input) closePicker(); }, 0);
  });
  return { wrap, strip };
}

// ---------- chip strip ----------

function renderStrip(input, opts, chips, preview) {
  const parts = opts.mode === 'template' ? tokenize(input.value) : (input.value.trim() ? [{ kind: 'token', path: stripPathLocal(input.value), start: 0, end: input.value.length }] : []);
  const issues = [...state.issues.errors, ...state.issues.warnings].filter((i) => i.nodeId === opts.stepId && i.field === opts.field);
  const hasToken = parts.some((p) => p.kind === 'token');
  chips.hidden = !hasToken;
  const focused = chips.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  chips.replaceChildren(...(hasToken ? parts.map((p) => (p.kind === 'text' ? h('span', { class: 'var-text' }, JSON.stringify(p.text)) : chip(p, input, opts, issues))) : []));
  const list = [...chips.querySelectorAll('.var-chip')];
  const keep = list.find((c) => c.dataset.path === focused) ?? list[0];
  if (keep) keep.tabIndex = 0;
  if (focused && keep) keep.focus();
  const value = opts.fieldName !== undefined ? previewOf(opts.stepId, opts.fieldName) : null;
  preview.hidden = value === null;
  preview.textContent = value === null ? '' : `Lần xem trước: ${formatSample(value)}`;
}

const stripPathLocal = (v) => v.trim().replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();

function chipKey(e, chips) {
  const all = [...chips.querySelectorAll('.var-chip')];
  const i = all.indexOf(document.activeElement);
  if (i === -1) return;
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = all[Math.max(0, Math.min(all.length - 1, to))];
  for (const c of all) c.tabIndex = c === next ? 0 : -1;
  next.focus();
}

function chip(part, input, opts, issues) {
  const issue = issues.find((i) => i.path === part.path && (!i.option || i.option === opts.option));
  const ref = refAt(opts.stepId, opts.field, opts.option, part.path);
  const scope = currentScope();
  const src = ref?.source !== undefined ? scope.sources[ref.source] : null;
  const [name, ...rest] = part.path.split('.');
  const known = Boolean(src) && ref.code !== 'unknownName';
  // Built-ins ($n) are neutral (start colour, docs/ui-design-system.md §3); this.* takes the step's colour.
  const type = rest[0]?.startsWith('$') ? 'start' : ref?.viaThis ? stepById(opts.stepId)?.type : src?.nodeType;
  let title;
  if (issue) title = issue.message;
  else if (!known) title = `Chưa khớp biến nào: ${part.path}`;
  else {
    const member = src.members.find((m) => m.key === rest[0]);
    const owner = src.kind === 'vars' ? `${src.name}` : src.sobject || src.name;
    title = `${owner}.${rest.join('.')}${member ? ` · ${typeLabel(member)}` : ''}`;
  }
  const el = h(
    'button',
    {
      type: 'button',
      class: `var-chip${issue ? (state.issues.errors.includes(issue) ? ' has-error' : ' has-warning') : ''}${known ? '' : ' unknown'}`,
      'data-type': known ? type : undefined,
      'data-path': part.path,
      tabindex: '-1',
      title,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        input.focus();
        input.setSelectionRange(part.start, part.end);
        openPicker(input, { focusSearch: true, replace: { start: part.start, end: part.end } });
      },
    },
    known ? h('span', { class: 'ico', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'var-src' }, name),
    rest.length ? ` · ${rest.join('.')}` : '',
  );
  return el;
}

// ---------- opening ----------

function onFieldKey(e, input) {
  const vp = input._varPicker;
  if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) {
    e.preventDefault();
    const auto = vp.opts.mode === 'template' ? autocompleteRange(input) : null; // path: search box, like {x}
    openPicker(input, { focusSearch: !auto, auto });
    return;
  }
  if (open?.input === input && !open.searchFocused) {
    if (listKey(e)) return;
  }
  if (vp.opts.mode === 'path' && e.key === 'ArrowDown' && !open) {
    e.preventDefault();
    openPicker(input, { auto: pathRange(input) });
  }
}

/** Path fields filter by their whole value while the list is open from the field (combobox). */
const pathRange = (input) => ({ start: 0, end: input.value.length, query: stripPathLocal(input.value) });

/** [start of "{{", caret] when the caret is inside an unfinished "{{query" in a template field. */
function autocompleteRange(input) {
  const caret = input.selectionStart ?? 0;
  if (caret !== input.selectionEnd) return null;
  const before = input.value.slice(0, caret);
  const at = before.lastIndexOf('{{');
  if (at === -1) return null;
  const q = before.slice(at + 2);
  if (!/^\s*[\w.$]*$/.test(q)) return null;
  return { start: at, end: caret, query: q.trim() };
}

function autocomplete(input, { onlyUpdate = false } = {}) {
  const range = autocompleteRange(input);
  const mine = open?.input === input;
  if (!range) {
    if (mine && open.auto) closePicker();
    return;
  }
  if (mine) {
    open.auto = range;
    open.query = range.query;
    if (!onlyUpdate) open.touched = true;
    open.render();
    return;
  }
  if (!onlyUpdate) openPicker(input, { auto: range, touched: true });
}

function openPicker(input, { focusSearch = false, auto = null, replace = null, touched = false } = {}) {
  if (open && open.input !== input) closePicker();
  const vp = input._varPicker;
  const selection = { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length };
  if (open) {
    Object.assign(open, { auto, replace: replace ?? open.replace, query: auto?.query ?? open.query });
    if (focusSearch) open.search.focus();
    open.render();
    return;
  }
  const search = h('input', {
    class: 'popup-search var-search',
    placeholder: 'Tìm biến: tên field, alias, kiểu…',
    'aria-label': 'Tìm biến',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': vp.listId,
    'aria-autocomplete': 'list',
  });
  // The listbox holds only groups and options; the empty message and the "not usable" list
  // sit next to it in the same scroll area. No role=dialog: it is a combobox popup, focus stays
  // in the field or the search box.
  const list = h('div', { role: 'listbox', id: vp.listId, 'aria-label': 'Biến dùng được' });
  const extra = h('div');
  const scroll = h('div', { class: 'vp-list' }, list, extra);
  const foot = h('div', { class: 'vp-foot' }, '↑↓ chọn · Enter chèn · Esc đóng');
  const hint = h('div', { class: 'vp-foot vp-hint', hidden: Boolean(state.result) }, 'Bấm ▶ Xem trước (Ctrl+Enter) để thấy giá trị mẫu.');
  const el = h('div', { class: 'var-picker' }, search, scroll, foot, hint);
  el.addEventListener('mousedown', (e) => { if (e.target !== search) e.preventDefault(); });
  document.body.append(el);
  // `touched`: the user typed (e.g. "{{" in a template) or moved the selection; only then may
  // Tab accept the active row.
  open = { el, input, search, list, extra, scroll, hint, opts: vp.opts, auto, replace, selection, query: auto?.query ?? '', active: null, items: [], searchFocused: false, hiddenOpen: false, touched, render: null };
  open.render = () => renderList(open);
  search.addEventListener('input', () => { open.query = search.value; open.active = null; open.touched = true; open.render(); });
  search.addEventListener('keydown', (e) => { listKey(e); }); // Ctrl+Enter falls through to the global preview shortcut
  search.addEventListener('focus', () => { open && (open.searchFocused = true); });
  search.addEventListener('blur', () => {
    if (!open) return;
    open.searchFocused = false;
    setTimeout(() => { if (open && !open.el.contains(document.activeElement) && document.activeElement !== open.input) closePicker(); }, 0);
  });
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', vp.listId);
  open.render();
  position(open);
  if (focusSearch) search.focus();
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
}

const reposition = () => open && position(open);
function outside(e) {
  if (open && !open.el.contains(e.target) && e.target !== open.input && !e.target.closest?.('.var-btn')) closePicker();
}

export function closePicker({ focus = false } = {}) {
  if (!open) return;
  const { el, input } = open;
  open = null;
  el.remove();
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-controls');
  input.removeAttribute('aria-activedescendant');
  document.removeEventListener('mousedown', outside, true);
  window.removeEventListener('resize', reposition);
  document.removeEventListener('scroll', reposition, true);
  if (focus && input.isConnected) input.focus();
}

function position(p) {
  const r = p.input.closest('.var-input')?.getBoundingClientRect() ?? p.input.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  const below = window.innerHeight - r.bottom - 8;
  const height = Math.min(360, p.el.scrollHeight || 360);
  p.el.style.width = `${width}px`;
  p.el.style.left = `${left}px`;
  if (below < Math.min(height, 240) && r.top > below) {
    p.el.style.top = '';
    p.el.style.bottom = `${window.innerHeight - r.top + 4}px`;
  } else {
    p.el.style.bottom = '';
    p.el.style.top = `${r.bottom + 4}px`;
  }
}

// ---------- list ----------

function renderList(p) {
  const { groups, hidden } = groupsFor(p.opts.stepId, p.opts.fieldIndex);
  const q = p.query.trim();
  if (p.search.value !== p.query && document.activeElement !== p.search) p.search.value = p.query;
  p.hint.hidden = Boolean(state.result);
  const scored = groups.map((g, gi) => {
    const items = g.items.map((it, ii) => ({ it, s: matchScore(it, g, q), ii })).filter((x) => x.s !== null).sort((a, b) => a.s - b.s || a.ii - b.ii);
    return { g, gi, items, best: items.length ? items[0].s : Infinity };
  }).filter((x) => x.items.length).sort((a, b) => a.best - b.best || a.gi - b.gi);
  p.items = [];
  const nodes = [];
  for (const { g, items } of scored) {
    const shown = items.slice(0, MAX_ROWS);
    const rows = shown.map(({ it }) => {
      const id = `${p.opts.stepId}-vp-${++uid}`;
      const row = h(
        'div',
        { class: 'vp-item', role: 'option', id, 'data-path': it.path, 'aria-selected': 'false', onclick: () => insert(it.path) },
        h('code', { class: 'vp-key' }, it.key),
        h('span', { class: 'vp-type' }, it.typeLabel),
        h('span', { class: `vp-sample${it.sample?.stale ? ' stale' : ''}`, title: it.sample?.title ?? '' }, it.sample?.text ?? ''),
        it.help ? h('small', { class: 'vp-help' }, it.help) : null,
      );
      p.items.push({ path: it.path, row, id });
      return row;
    });
    nodes.push(h(
      'div',
      { class: 'vp-group', role: 'group', 'aria-label': `${g.name} · ${g.label}`, 'data-type': g.nodeType },
      h('div', { class: 'vp-head' }, icoTile(), h('code', { class: 'vp-name' }, g.name), h('span', { class: 'vp-label' }, g.label),
        g.note ? h('small', { class: 'vp-note' }, g.note) : null,
        g.badge ? h('span', { class: 'vp-badge', title: g.badgeTitle ?? '' }, g.badge) : null),
      rows,
      items.length > MAX_ROWS ? h('div', { class: 'vp-more' }, `Còn ${items.length - MAX_ROWS} field, gõ để lọc.`) : null,
    ));
  }
  const hiddenShown = q ? hidden.filter((x) => x.text.toLowerCase().includes(q.toLowerCase())) : hidden;
  const after = [];
  if (!nodes.length) {
    after.push(h('div', { class: 'vp-empty' }, q
      ? `Không có biến nào khớp "${q}".`
      : 'Chưa có biến nào dùng được ở đây. Biến đến từ: field phía trên trong bước này (this), bước Record chạy trước, hoặc bước Lặp bao quanh.'));
  }
  if (hiddenShown.length) {
    const det = h('details', { class: 'vp-hidden', open: p.hiddenOpen }, h('summary', {}, `Không dùng được ở đây (${hiddenShown.length})`), hiddenShown.map((x) => h('div', { class: 'vp-off' }, x.text)));
    det.addEventListener('toggle', () => { p.hiddenOpen = det.open; });
    after.push(det);
  }
  p.list.replaceChildren(...nodes);
  p.extra.replaceChildren(...after);
  if (!p.items.some((x) => x.path === p.active)) p.active = p.items[0]?.path ?? null;
  highlight(p);
}

function highlight(p) {
  for (const x of p.items) {
    const on = x.path === p.active;
    x.row.classList.toggle('active', on);
    x.row.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) {
      p.input.setAttribute('aria-activedescendant', x.id);
      p.search.setAttribute('aria-activedescendant', x.id);
      x.row.scrollIntoView?.({ block: 'nearest' });
    }
  }
  if (!p.active) {
    p.input.removeAttribute('aria-activedescendant');
    p.search.removeAttribute('aria-activedescendant');
  }
}

/** Keys while the list is open. Returns true when handled. */
function listKey(e) {
  if (!open) return false;
  const p = open;
  const i = p.items.findIndex((x) => x.path === p.active);
  const go = (n) => {
    if (!p.items.length) return;
    p.touched = true;
    p.active = p.items[Math.max(0, Math.min(p.items.length - 1, n))].path;
    highlight(p);
  };
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  switch (e.key) {
    case 'ArrowDown': stop(); go(i + 1); return true;
    case 'ArrowUp': stop(); go(i - 1); return true;
    case 'PageDown': stop(); go(i + 8); return true;
    case 'PageUp': stop(); go(i - 8); return true;
    case 'Home': if (!p.searchFocused && !p.auto) return false; stop(); go(0); return true;
    case 'End': if (!p.searchFocused && !p.auto) return false; stop(); go(p.items.length - 1); return true;
    case 'Enter':
    case 'Tab':
      // Enter always accepts; Tab only after typing or moving the selection, Shift+Tab never.
      if (e.ctrlKey || e.metaKey || !p.active || (e.key === 'Tab' && (e.shiftKey || !p.touched))) {
        if (e.key === 'Tab') closePicker();
        return false;
      }
      stop();
      insert(p.active);
      return true;
    case 'Escape':
      stop();
      closePicker({ focus: true });
      return true;
    default:
      return false;
  }
}

// ---------- insertion ----------

function insert(path) {
  if (!open) return;
  const p = open;
  const { input } = p;
  const vp = input._varPicker;
  const v = input.value;
  let start;
  let end;
  let text;
  if (vp.opts.mode === 'path') {
    [start, end, text] = [0, v.length, path];
  } else if (p.replace) {
    [start, end] = [p.replace.start, p.replace.end];
    text = `{{${path}}}`;
  } else if (vp.unsaved) {
    [start, end, text] = [0, v.length, `{{${path}}}`]; // the shown default is only an example
  } else if (p.auto) {
    start = p.auto.start;
    end = v.slice(p.auto.end).startsWith('}}') ? p.auto.end + 2 : p.auto.end;
    text = `{{${path}}}`;
  } else {
    [start, end] = [p.selection.start, p.selection.end];
    text = `{{${path}}}`;
  }
  closePicker();
  replaceRange(input, start, end, text);
  vp.unsaved = false;
}

/** Replace [start, end) by `text` as typing would (native undo), then one store undo step. */
function replaceRange(input, start, end, text) {
  input.focus();
  input.setSelectionRange(start, end);
  input._varInsert = true;
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok || input.value.slice(start, start + text.length) !== text) {
    input.setRangeText(text, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input._varInsert = false;
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
}

/** Apply a validation suggestion { option, from, to } to a value of mode `mode`. */
export function applySuggestion(mode, value, { from, to }) {
  if (mode === 'ref') return to;
  if (mode === 'path') return to;
  const t = tokenize(value ?? '').find((x) => x.kind === 'token' && x.path === from);
  if (!t) return value;
  return `${value.slice(0, t.start)}{{${to}}}${value.slice(t.end)}`;
}
