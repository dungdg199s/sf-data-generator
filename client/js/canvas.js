// "Sơ đồ" view (design 0003, đợt B): the same step tree as the Quy trình view, drawn left to
// right by the pure auto-layout of layout.js, with pan / zoom. No free wiring and no positions:
// the picture is always computed from the tree. Editing is the same as in Quy trình: select (the
// shared inspector), "+" on every connector (the same menu), ⋯ menu, Delete, Ctrl+D, Ctrl+/,
// palette items dropped on a connector. Cards are not dragged (switch to Quy trình with M).
//
// Rendering: one SVG path holds every connector; cards, "+" buttons, empty-slot boxes and lane
// labels are absolutely positioned elements created only for the part of the world near the
// viewport (culling), so a workflow of thousands of steps pans smoothly. The selected card (and
// the Start card when nothing is selected) is always in the DOM, so it can hold focus.
// Workflow / view / result events rebuild; selection and issue events only re-decorate.
// While the Quy trình view is shown (views.js) this view is empty and does not render.

import { h, icoTile } from './dom.js';
import { state, subscribe, select, nodeType, stepById, setCollapsed } from './store.js';
import { layout, START_ID } from './layout.js';
import {
  stepSummary, stepAlias, statChip, stepLabel, addPointLabel, issuesByStep, innerIssues, innerCount,
} from './summary.js';
import * as ops from './ops.js';
import { openSheet } from './inspector.js';
import { openAddMenu, openStepMenu } from './menus.js';

const SVG = 'http://www.w3.org/2000/svg';
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;
const CULL_MARGIN = 400; // screen px kept rendered around the viewport
const EDGE_MARGIN = 24; // ensureVisible keeps cards this far from the edges
const FOCUS_W = 360; // the part of a wide frame header that must be visible

let wrap;
let root; // #canvas: role=tree, the viewport
let world;
let under;
let over;
let lines;
let dots;
let zoomLabel;

let lay = null; // last layout
let items = []; // [{ key, layer, rect, make }]
let itemsByKey = new Map();
let rects = new Map(); // step id / START_ID → card rectangle (world)
const els = new Map(); // key → element in the DOM
let pan = { x: 0, y: 0 };
let zoom = 1;
let placed = false; // pan / zoom chosen once (first show), then kept for the session
let staleStats = false;
let issues = new Map();

const active = () => state.view === 'canvas';

export function initCanvas() {
  wrap = document.getElementById('canvas-wrap');
  root = document.getElementById('canvas');
  lines = document.createElementNS(SVG, 'path');
  lines.setAttribute('class', 'dg-lines');
  dots = document.createElementNS(SVG, 'path');
  dots.setAttribute('class', 'dg-dots');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'dg-edges');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(lines, dots);
  under = h('div', { class: 'dg-under' });
  over = h('div', { class: 'dg-over' });
  world = h('div', { class: 'dg-world' }, under, svg, over);
  root.append(world);
  zoomLabel = document.getElementById('btn-zoom-reset');

  root.addEventListener('keydown', onKey);
  root.addEventListener('click', onBackgroundClick);
  root.addEventListener('click', swallowClickAfterPan, true);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('wheel', onWheel, { passive: false });
  // Focus moved by the browser (Tab) scrolls the overflow:hidden viewport: turn it into a pan.
  root.addEventListener('scroll', () => {
    if (!root.scrollLeft && !root.scrollTop) return;
    pan = { x: pan.x - root.scrollLeft, y: pan.y - root.scrollTop };
    root.scrollLeft = 0;
    root.scrollTop = 0;
    applyTransform();
  });
  root.addEventListener('dragover', onPaletteDragOver);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) highlightDrop(null); });
  root.addEventListener('drop', onPaletteDrop);
  new ResizeObserver(() => { if (active() && lay) cull(); }).observe(root);

  document.getElementById('btn-zoom-in').onclick = () => zoomBy(ZOOM_STEP);
  document.getElementById('btn-zoom-out').onclick = () => zoomBy(1 / ZOOM_STEP);
  document.getElementById('btn-zoom-fit').onclick = fit;
  zoomLabel.onclick = () => zoomBy(1 / zoom);

  subscribe(({ kind, source }) => {
    if (!active()) return;
    // Typing in the inspector: one rebuild per frame at most, not one per keystroke.
    if (kind === 'workflow' && source === 'inspector') scheduleRender();
    else if (kind === 'workflow' || kind === 'all' || kind === 'view' || kind === 'result') render();
    else if (kind === 'selection' || kind === 'issues') decorate();
  });
  ops.onReveal((id, opts) => { if (active()) revealStep(id, opts); });
}

let renderFrame = 0;
function scheduleRender() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
}

/** The Quy trình view took over: drop this view's DOM (no stale cards for document-wide queries). */
export function clearCanvas() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  for (const el of els.values()) el.remove();
  els.clear();
  lay = null;
}

// ---------- rendering ----------

function render() {
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (!active()) return;
  const focused = root.contains(document.activeElement) && !document.activeElement.closest('.popup') ? document.activeElement : null;
  const focusKey = focused?.closest('[data-key]')?.dataset.key ?? null;
  staleStats = state.lastRunSteps !== null && state.lastRunSteps !== JSON.stringify(state.workflow.steps);
  lay = layout(state.workflow.steps ?? [], { slotsOf: (type) => nodeType(type)?.slots ?? [], collapsed: state.collapsed });
  buildItems();
  lines.setAttribute('d', lay.edges.map((p) => `M${p[0]} ${p[1]}${pointsTail(p)}`).join(''));
  dots.setAttribute('d', lay.dots.map((d) => `M${d.x - 5} ${d.y}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`).join(''));
  const svg = lines.ownerSVGElement;
  svg.setAttribute('width', lay.width);
  svg.setAttribute('height', lay.height);
  for (const el of els.values()) el.remove();
  els.clear();
  issues = issuesByStep();
  if (!placed) placeInitial();
  applyTransform();
  if (focusKey) {
    const el = els.get(focusKey);
    if (el) (el.matches('button') ? el : el.closest('[tabindex]') ?? el).focus({ preventScroll: true });
    else focusSelected();
  }
}

function pointsTail(p) {
  let s = '';
  for (let i = 2; i < p.length; i += 2) s += `L${p[i]} ${p[i + 1]}`;
  return s;
}

const addKey = (parentId, slot, index) => `add:${parentId ?? ''}:${slot ?? ''}:${index}`;

function buildItems() {
  items = [];
  rects = new Map();
  const push = (key, layer, rect, make) => items.push({ key, layer, rect, make });
  for (const n of lay.nodes) if (n.kind === 'frame') push(`frame:${n.id}`, 'under', n, () => frameEl(n));
  const levels = new Map(lay.nodes.map((n) => [n.id, n.level]));
  for (const s of lay.slots) push(`slot:${s.parentId}:${s.key}`, 'under', s, () => slotEl(s, levels.get(s.parentId) ?? 1));
  push(`card:${START_ID}`, 'over', lay.start, startCard);
  rects.set(START_ID, lay.start);
  for (const n of lay.nodes) {
    const rect = n.head ?? n;
    if (n.kind === 'invalid') push(`invalid:${n.path}`, 'over', rect, () => invalidEl(n));
    else {
      push(`card:${n.id}`, 'over', rect, () => cardEl(n));
      rects.set(n.id, rect);
    }
  }
  // A "+" is drawn 22 px wide (its hit area is 34 px, CSS).
  for (const a of lay.adds) push(addKey(a.parentId, a.slot, a.index), 'over', { x: a.x - 11, y: a.y - 11, w: 22, h: 22 }, () => addEl(a));
  for (const e of lay.empties) push(addKey(e.parentId, e.slot, 0), 'over', e, () => emptyEl(e));
  for (const l of lay.labels) push(`label:${l.parentId}:${l.slot}`, 'over', { x: l.x, y: l.y, w: l.w, h: 16 }, () => labelEl(l));
  itemsByKey = new Map(items.map((it) => [it.key, it]));
}

/** Key of the card that must stay in the DOM: the selection, or the Start card. */
function pinnedKey() {
  const id = selectedId();
  return `card:${id ?? START_ID}`;
}

function selectedId() {
  const sel = state.selection;
  if (sel?.kind === 'step' && rects.has(sel.id)) return sel.id;
  if (sel?.kind === 'workflow') return START_ID;
  return null;
}

/** Creates the elements near the viewport and removes the others (focused one excepted). */
function cull() {
  if (!lay) return;
  const W = root.clientWidth;
  const H = root.clientHeight;
  const vx = (-pan.x - CULL_MARGIN) / zoom;
  const vy = (-pan.y - CULL_MARGIN) / zoom;
  const vw = (W + 2 * CULL_MARGIN) / zoom;
  const vh = (H + 2 * CULL_MARGIN) / zoom;
  const pinned = pinnedKey();
  const keep = new Set();
  for (const it of items) {
    const r = it.rect;
    if (it.key !== pinned && !(r.x < vx + vw && r.x + r.w > vx && r.y < vy + vh && r.y + r.h > vy)) continue;
    keep.add(it.key);
    if (!els.has(it.key)) {
      const el = it.make();
      el.dataset.key = it.key;
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      (it.layer === 'under' ? under : over).append(el);
      els.set(it.key, el);
      decorateEl(el);
    }
  }
  const focused = document.activeElement;
  for (const [key, el] of els) {
    if (keep.has(key) || el.contains(focused)) continue;
    el.remove();
    els.delete(key);
  }
}

let cullFrame = 0;
function applyTransform() {
  world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  root.style.backgroundSize = `${20 * zoom}px ${20 * zoom}px`;
  root.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  zoomLabel.title = `Thu phóng ${Math.round(zoom * 100)}%. Bấm để về 100%.`;
  if (!cullFrame) cullFrame = requestAnimationFrame(() => { cullFrame = 0; cull(); });
}

/** Pan / zoom now, and the elements of the new viewport at once (focus, menus anchor on them). */
function applyNow() {
  applyTransform();
  cancelAnimationFrame(cullFrame);
  cullFrame = 0;
  cull();
}

/** First show: 100 %, the Start card at the left, the diagram centred vertically when it fits. */
function placeInitial() {
  placed = true;
  zoom = 1;
  const H = root.clientHeight;
  pan = { x: 0, y: lay.height < H ? Math.round((H - lay.height) / 2) : 0 };
}

const typeLabel = (step) => nodeType(step.type)?.label ?? step.type;

function startCard() {
  const wf = state.workflow;
  const max = wf.settings?.maxRecords ?? state.meta?.limits.maxRecordsDefault;
  return h(
    'div',
    {
      class: 'step-card start-card dg-card',
      'data-id': START_ID,
      'data-type': 'start',
      role: 'treeitem',
      'aria-level': '1',
      tabindex: '-1',
      onclick: (e) => cardClick(e, START_ID),
    },
    h('div', { class: 'dg-row' }, h('span', { class: 'type' }, icoTile(), h('span', { class: 'type-label' }, 'Bắt đầu')), h('span', { class: 'badges' })),
    h('div', { class: 'sum dg-sum', title: wf.name || 'Workflow' }, wf.name || 'Workflow'),
    h('div', { class: 'dg-tags' }, h('span', { class: 'dg-note' }, `≤ ${Number(max).toLocaleString('vi-VN')} bản ghi`)),
  );
}

function cardClick(e, id) {
  if (e.target.closest('button')) return;
  select(id === START_ID ? { kind: 'workflow' } : { kind: 'step', id });
  openSheet(); // narrow screens: a tap on the selected card shows the sheet a run (or ‹ Xong) closed
  e.currentTarget.focus({ preventScroll: true });
}

function cardEl(n) {
  const step = n.step;
  const type = nodeType(step.type);
  const alias = stepAlias(step);
  const summary = stepSummary(step);
  const chip = state.result ? statChip(step, state.result.stats?.byStep) : null;
  const head = n.kind === 'frame';
  const parts = {
    type: h('span', { class: 'type' }, icoTile(), h('span', { class: 'type-label' }, typeLabel(step))),
    alias: alias ? h('span', { class: 'alias', title: alias }, alias) : null,
    sum: h('span', { class: `sum${head ? '' : ' dg-sum'}`, title: summary }, summary),
    chip: chip ? h('span', { class: `stat${staleStats ? ' stale' : ''}`, title: staleStats ? 'Số liệu của lần xem trước gần nhất; workflow đã đổi sau đó.' : 'Số liệu của lần xem trước gần nhất.' }, chip) : null,
    badges: h('span', { class: 'badges' }),
    off: step.disabled ? h('span', { class: 'tag-off', title: 'Bước này đang tắt: không chạy và không được kiểm tra. Ctrl+/ để bật lại.' }, 'Đã tắt') : null,
    sample: type?.needsOrg && !state.org && !step.disabled ? h('span', { class: 'tag-sample', title: 'Chưa chọn org: Xem trước dùng bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.' }, 'chưa chọn org') : null,
    note: n.collapsed ? h('span', { class: 'dg-note', 'data-count': String(innerCount(step)) }) : null,
    menu: h('button', { class: 'icon menu-btn', title: 'Thao tác với bước', 'aria-label': `Thao tác với bước ${stepLabel(step)}`, onclick: (e) => openStepMenu(e.currentTarget, step.id) }, '⋯'),
    toggle: n.container
      ? h('button', { class: 'icon toggle', title: n.collapsed ? 'Mở khung' : 'Thu gọn khung', 'aria-label': n.collapsed ? 'Mở khung' : 'Thu gọn khung', onclick: () => setCollapsed([step.id], !n.collapsed) }, n.collapsed ? '▸' : '▾')
      : null,
  };
  const attrs = {
    class: `step-card dg-card${head ? ' dg-head' : ''}${step.disabled ? ' is-disabled' : ''}${n.collapsed ? ' is-collapsed' : ''}`,
    'data-id': step.id,
    'data-type': step.type,
    role: 'treeitem',
    'aria-level': String(n.level),
    'aria-expanded': n.container ? String(!n.collapsed) : undefined,
    tabindex: '-1',
    onclick: (e) => cardClick(e, step.id),
  };
  // A frame header is one row, like a Quy trình card; other cards have three short rows.
  if (head) return h('div', attrs, parts.type, parts.alias, parts.sum, parts.chip, parts.badges, parts.off, parts.sample, parts.menu, parts.toggle);
  return h(
    'div',
    attrs,
    h('div', { class: 'dg-row' }, parts.type, parts.alias, parts.badges, parts.menu, parts.toggle),
    parts.sum,
    h('div', { class: 'dg-tags' }, parts.note, parts.chip, parts.off, parts.sample),
  );
}

function invalidEl(n) {
  return h('div', { class: 'invalid-card dg-invalid', role: 'note' },
    h('span', { class: 'type' }, 'Bước lỗi'),
    h('span', { class: 'sum' }, `Không phải một bước (${JSON.stringify(n.step) ?? String(n.step)}). Xóa mục này trong file JSON rồi mở lại.`));
}

function frameEl(n) {
  return h('div', {
    class: `dg-frame${n.step.disabled ? ' is-disabled' : ''}`,
    'data-type': n.step.type,
    'aria-hidden': 'true',
    style: { zIndex: String(n.level * 2) },
  });
}

function slotEl(s, level) {
  return h('div', { class: 'slot dg-slot', 'data-slot-of': s.parentId, 'data-slot-key': s.key, 'aria-hidden': 'true', style: { zIndex: String(level * 2 + 1) } });
}

function targetAttrs(parentId, slot, index) {
  return { 'data-parent': parentId ?? '', 'data-slot': slot ?? '', 'data-index': String(index) };
}

function addEl(a) {
  const target = { parentId: a.parentId, slot: a.slot, index: a.index };
  const el = h('button', {
    class: 'add-btn dg-add',
    title: 'Thêm bước ở đây (/)',
    'aria-label': addPointLabel([a.after, a.before], 1),
    ...targetAttrs(a.parentId, a.slot, a.index),
    onclick: (e) => openAddMenu(e.currentTarget, target),
  }, '+');
  return el;
}

function emptyEl(e) {
  const target = { parentId: e.parentId, slot: e.slot, index: 0 };
  if (e.root) {
    return h('button', { class: 'add-first dg-empty', title: 'Thêm bước ở đây (/)', ...targetAttrs(null, null, 0), onclick: (ev) => openAddMenu(ev.currentTarget, target) }, '+ Thêm bước đầu tiên');
  }
  const where = e.def?.label ? `vào nhánh ${e.def.label}` : 'vào vòng lặp';
  return h(
    'button',
    { class: 'slot-empty dg-empty', title: 'Thêm bước ở đây (/)', 'aria-label': `Thêm bước ${where}`, ...targetAttrs(e.parentId, e.slot, 0), onclick: (ev) => openAddMenu(ev.currentTarget, target) },
    h('span', {}, `+ ${e.def?.empty || 'Thêm bước'}`),
    e.def?.hint ? h('small', { class: 'slot-hint' }, e.def.hint) : null,
  );
}

function labelEl(l) {
  const type = stepById(l.parentId)?.type;
  return h('div', { class: `dg-lane-label slot-${l.slot}`, 'data-type': type, title: l.text, 'aria-hidden': 'true' }, l.text);
}

// ---------- decoration (selection, issues) without rebuilding ----------

function decorate() {
  if (!lay) return;
  issues = issuesByStep();
  cull(); // the selection is pinned: a newly selected card off screen exists from now on
  for (const el of els.values()) decorateEl(el);
}

function decorateEl(el) {
  if (el.classList.contains('step-card')) decorateCard(el);
  else if (el.classList.contains('dg-slot')) decorateSlot(el);
}

function decorateCard(card) {
  const id = card.dataset.id;
  const own = issues.get(id) ?? { errors: [], warnings: [] };
  let errors = own.errors.length;
  let warnings = own.warnings.length;
  // A collapsed frame shows the issues of the steps inside it.
  let inner = { errors: 0, warnings: 0, first: null };
  if (card.classList.contains('is-collapsed')) {
    inner = innerIssues(id, issues);
    errors += inner.errors;
    warnings += inner.warnings;
  }
  const selected = id === (selectedId() ?? null);
  card.classList.toggle('selected', selected);
  card.setAttribute('aria-selected', String(selected));
  // Roving tab stop: the selected card, or the Start card when nothing is selected.
  card.tabIndex = selected || (id === START_ID && !selectedId()) ? 0 : -1;
  card.classList.toggle('has-error', errors > 0);
  card.classList.toggle('has-warning', !errors && warnings > 0);
  const jump = (e) => {
    e.stopPropagation();
    const target = inner.first ?? id;
    if (target !== START_ID) {
      ops.expandAncestors(target);
      select({ kind: 'step', id: target });
      ops.reveal(target);
    } else select({ kind: 'workflow' });
  };
  card.querySelector('.badges').replaceChildren(
    errors ? h('button', { class: 'badge', title: `${errors} lỗi — bấm để xem`, onclick: jump }, String(errors)) : '',
    warnings ? h('button', { class: 'badge warn', title: `${warnings} cảnh báo — bấm để xem`, onclick: jump }, String(warnings)) : '',
  );
  const note = card.querySelector('.dg-note[data-count]');
  if (note) {
    const parts = [`${note.dataset.count} bước bên trong`];
    if (inner.errors) parts.push(`${inner.errors} lỗi`);
    else if (inner.warnings) parts.push(`${inner.warnings} cảnh báo`);
    note.textContent = parts.join(' · ');
  }
}

function decorateSlot(el) {
  const own = issues.get(el.dataset.slotOf) ?? { errors: [], warnings: [] };
  const field = `slots.${el.dataset.slotKey}`;
  const errs = own.errors.filter((i) => i.field === field);
  const warns = own.warnings.filter((i) => i.field === field);
  el.classList.toggle('slot-error', errs.length > 0);
  el.classList.toggle('slot-warning', !errs.length && warns.length > 0);
  // The message itself is in the issues bar; the box under the outline repeats it on hover.
  const box = els.get(addKey(el.dataset.slotOf, el.dataset.slotKey, 0));
  if (box?.classList.contains('dg-empty')) box.title = [...errs, ...warns].map((i) => i.message).join(' ') || 'Thêm bước ở đây (/)';
}

// ---------- viewport: pan, zoom, ensureVisible ----------

/** Height of the viewport not covered by the bottom sheet (narrow screens). */
function visibleHeight() {
  const H = root.clientHeight;
  if (!document.body.classList.contains('sheet-open')) return H;
  const insp = document.getElementById('inspector');
  const top = root.getBoundingClientRect().top;
  return Math.max(80, Math.min(H, window.innerHeight - insp.offsetHeight - top));
}

/**
 * Pan so that a world rectangle is visible. `center`: centre it when it is not fully visible
 * (switching views, reveal); otherwise the smallest pan (keyboard moves).
 */
function showRect(r, { center = false } = {}) {
  const W = root.clientWidth;
  const H = visibleHeight();
  const w = Math.min(r.w, FOCUS_W);
  const sx = r.x * zoom + pan.x;
  const sy = r.y * zoom + pan.y;
  const sw = w * zoom;
  const sh = r.h * zoom;
  const M = EDGE_MARGIN;
  const fully = sx >= M && sy >= M && sx + sw <= W - M && sy + sh <= H - M;
  if (fully) return false;
  if (center) {
    pan = { x: Math.round(W / 2 - (r.x + w / 2) * zoom), y: Math.round(H / 2 - (r.y + r.h / 2) * zoom) };
  } else {
    let { x, y } = pan;
    if (sx + sw > W - M) x -= sx + sw - (W - M);
    if (sx + (x - pan.x) < M) x = M - r.x * zoom;
    if (sy + sh > H - M) y -= sy + sh - (H - M);
    if (sy + (y - pan.y) < M) y = M - r.y * zoom;
    pan = { x: Math.round(x), y: Math.round(y) };
  }
  applyNow();
  return true;
}

export function ensureVisible(id, opts) {
  const r = rects.get(id);
  if (r) showRect(r, opts);
}

function zoomAt(next, cx, cy) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (z === zoom) return;
  const wx = (cx - pan.x) / zoom;
  const wy = (cy - pan.y) / zoom;
  zoom = z;
  pan = { x: cx - wx * z, y: cy - wy * z };
  applyTransform();
}

/** Zoom buttons and keys: around the selected card when it is on screen, else the centre. */
function zoomBy(factor) {
  let cx = root.clientWidth / 2;
  let cy = visibleHeight() / 2;
  const r = rects.get(selectedId());
  if (r) {
    const sx = (r.x + Math.min(r.w, FOCUS_W) / 2) * zoom + pan.x;
    const sy = (r.y + r.h / 2) * zoom + pan.y;
    if (sx > 0 && sy > 0 && sx < root.clientWidth && sy < visibleHeight()) [cx, cy] = [sx, sy];
  }
  zoomAt(zoom * factor, cx, cy);
}

/** ⤢: the whole diagram in the viewport (never above 100 %). */
function fit() {
  if (!lay) return;
  const W = root.clientWidth;
  const H = visibleHeight();
  zoom = Math.min(1, Math.max(ZOOM_MIN, Math.min((W - 32) / lay.width, (H - 32) / lay.height)));
  pan = { x: Math.round((W - lay.width * zoom) / 2), y: Math.round((H - lay.height * zoom) / 2) };
  applyTransform();
}

const pointers = new Map(); // pointerId → { x, y }
let gesture = null; // { kind: 'pan' | 'pinch', … }
let suppressClick = false;

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('button, a, input, select, textarea')) return;
  suppressClick = false;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { kind: 'pan', x0: e.clientX, y0: e.clientY, pan0: { ...pan }, moved: false, touch: e.pointerType !== 'mouse' };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const box = root.getBoundingClientRect();
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom0: zoom, mid0: { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top }, pan0: { ...pan }, moved: true };
    for (const id of pointers.keys()) root.setPointerCapture?.(id);
  }
}

function onPointerMove(e) {
  if (!gesture || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.kind === 'pan') {
    const dx = e.clientX - gesture.x0;
    const dy = e.clientY - gesture.y0;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < (gesture.touch ? 8 : 4)) return;
      gesture.moved = true;
      root.setPointerCapture(e.pointerId);
      root.classList.add('panning');
    }
    pan = { x: gesture.pan0.x + dx, y: gesture.pan0.y + dy };
    applyTransform();
    return;
  }
  const [a, b] = [...pointers.values()];
  const box = root.getBoundingClientRect();
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, gesture.zoom0 * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0)));
  const wx = (gesture.mid0.x - gesture.pan0.x) / gesture.zoom0;
  const wy = (gesture.mid0.y - gesture.pan0.y) / gesture.zoom0;
  const mid = { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top };
  zoom = z;
  pan = { x: mid.x - wx * z, y: mid.y - wy * z };
  applyTransform();
}

function onPointerUp(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (gesture?.moved) suppressClick = true;
  if (!pointers.size) {
    gesture = null;
    root.classList.remove('panning');
  } else if (gesture?.kind === 'pinch') {
    // One finger left after a pinch: go on panning from where it is.
    const [p] = [...pointers.values()];
    gesture = { kind: 'pan', x0: p.x, y0: p.y, pan0: { ...pan }, moved: true, touch: true };
  }
}

/** The click that ends a pan or a pinch is not a selection. */
function swallowClickAfterPan(e) {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}

function onBackgroundClick(e) {
  if (e.target.closest('.step-card, button, .dg-invalid')) return;
  select(null);
}

function onWheel(e) {
  e.preventDefault();
  const box = root.getBoundingClientRect();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1;
  // Ctrl + wheel (and trackpad pinch, which the browser reports as Ctrl + wheel): zoom at the pointer.
  if (e.ctrlKey || e.metaKey) {
    zoomAt(zoom * Math.exp(-e.deltaY * unit * 0.002), e.clientX - box.left, e.clientY - box.top);
    return;
  }
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
  pan = { x: pan.x - dx * unit, y: pan.y - dy * unit };
  applyTransform();
}

// ---------- selection helpers ----------

function cardElement(id) {
  return els.get(`card:${id}`) ?? null;
}

export function focusSelected() {
  if (!active() || !lay) return;
  const id = selectedId() ?? START_ID;
  ensureVisible(id);
  cardElement(id)?.focus({ preventScroll: true });
}

/** Open collapsed ancestors, pan the card into view (centred), optionally focus and flash it. */
export function revealStep(id, { flash = false, focus = true, block = 'center' } = {}) {
  if (ops.expandAncestors(id)) setCollapsed([], false); // persists + re-renders
  if (!lay) return;
  ensureVisible(id, { center: block === 'center' });
  const card = cardElement(id);
  if (!card) return;
  if (focus && !document.activeElement?.closest('#inspector input, #inspector textarea, #inspector select')) card.focus({ preventScroll: true });
  if (flash) {
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 700);
  }
}

// ---------- keyboard (same tree keys as the Quy trình view) ----------

function onKey(e) {
  if (e.target.closest('input, textarea, select, .popup') || e.altKey || e.ctrlKey || e.metaKey || !lay) return;
  // Zoom keys anywhere in the diagram.
  if (e.key === '+' || e.key === '=') return void (e.preventDefault(), zoomBy(ZOOM_STEP));
  if (e.key === '-') return void (e.preventDefault(), zoomBy(1 / ZOOM_STEP));
  if (e.key === '0') return void (e.preventDefault(), fit());
  const order = lay.order;
  const currentId = e.target.closest('.step-card')?.dataset.id ?? selectedId();
  const idx = order.findIndex((o) => o.id === currentId);
  const cur = order[idx];
  const go = (entry) => {
    if (!entry) return;
    e.preventDefault();
    select(entry.id === START_ID ? { kind: 'workflow' } : { kind: 'step', id: entry.id });
    ensureVisible(entry.id);
    cardElement(entry.id)?.focus({ preventScroll: true });
  };
  switch (e.key) {
    case 'ArrowDown':
      return go(order[idx + 1] ?? (idx < 0 ? order[0] : null));
    case 'ArrowUp':
      return go(order[idx - 1] ?? (idx < 0 ? order[0] : null));
    case 'Home':
      return go(order[0]);
    case 'End':
      return go(order.at(-1));
    case 'ArrowLeft':
      if (cur?.container && !cur.collapsed) {
        e.preventDefault();
        return setCollapsed([cur.id], true);
      }
      return go(cur?.parentId ? order.find((o) => o.id === cur.parentId) : null);
    case 'ArrowRight':
      if (!cur?.container) return undefined;
      e.preventDefault();
      if (cur.collapsed) return setCollapsed([cur.id], false);
      return go(order[idx + 1]?.parentId === cur.id ? order[idx + 1] : null);
    case 'Enter': {
      const input = document.querySelector('#inspector input, #inspector select, #inspector textarea');
      if (input && cur) {
        e.preventDefault();
        input.focus();
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------- "+" menu at the default position ("/") ----------

export function openAddMenuAtDefault() {
  const target = ops.defaultTarget();
  if (target.parentId && ops.expandAncestors(target.parentId)) setCollapsed([], false);
  if (target.parentId && state.collapsed.has(target.parentId)) setCollapsed([target.parentId], false);
  const key = addKey(target.parentId, target.slot, target.index);
  const it = itemsByKey.get(key);
  if (it) showRect(it.rect);
  cull();
  openAddMenu(els.get(key) ?? root, target);
}

// ---------- palette items dropped on a connector ----------

function dropPoints() {
  return [...over.querySelectorAll('.dg-add, .dg-empty')];
}

function nearestPoint(x, y) {
  let best = null;
  let bestD = 80; // px: farther than this from every "+" is no drop
  for (const p of dropPoints()) {
    const r = p.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function highlightDrop(el) {
  for (const p of over.querySelectorAll('.drop-active')) if (p !== el) p.classList.remove('drop-active');
  el?.classList.add('drop-active');
}

export function paletteDragStart(e, type) {
  e.dataTransfer.setData('text/x-node-type', type);
  e.dataTransfer.effectAllowed = 'copy';
  root.classList.add('dragging');
}

export function paletteDragEnd() {
  root?.classList.remove('dragging');
  if (over) highlightDrop(null);
}

function onPaletteDragOver(e) {
  if (!e.dataTransfer.types.includes('text/x-node-type')) return;
  e.preventDefault();
  root.classList.add('dragging');
  highlightDrop(nearestPoint(e.clientX, e.clientY));
}

function onPaletteDrop(e) {
  const type = e.dataTransfer.getData('text/x-node-type');
  if (!type) return;
  e.preventDefault();
  const point = nearestPoint(e.clientX, e.clientY);
  paletteDragEnd();
  if (point) ops.addStep(type, { parentId: point.dataset.parent || null, slot: point.dataset.slot || null, index: Number(point.dataset.index) });
}
