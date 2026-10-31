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
// Minimap (design 0014 §5, minimap.js): a fixed set of SVG paths rebuilt after a render (one rAF,
// at most every 250 ms while typing in the inspector); pan / zoom only move its viewBox, the
// viewport rectangle and the overview thumb.

import { h, ico, icoTile } from './dom.js';
import { state, subscribe, select, nodeType, stepById, setCollapsed } from './store.js';
import { layout, START_ID } from './layout.js';
import {
  stepSummary, stepAlias, stepLabel, addPointLabel, issuesByStep, innerIssues, innerCount, emptySlotLabel,
  startEstimate,
} from './summary.js';
import * as ops from './ops.js';
import { openSheet } from './inspector.js';
import { openAddMenu, openStepMenu } from './menus.js';
import { refTargetId } from './ref-target.js';
import { paintCardRun, resultStale, noteText, stepsById } from './run-cards.js';
import { isSelected, clickSelect, toggleSelected, extendBy, inSelectMode } from './selection.js';
import { minimapModel, minimapPaths, mapToWorld, trackToWorld } from './minimap.js';

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
  // The viewport changes size (results panel, issues bar, sheet, window): a selected card that was
  // fully visible stays visible; otherwise only the elements are updated.
  let size = null;
  new ResizeObserver(() => {
    if (!active() || !lay) return;
    const was = size;
    size = { w: root.clientWidth, h: root.clientHeight };
    const r = rects.get(selectedId());
    if (r && was) {
      const sx = r.x * zoom + pan.x;
      const sy = r.y * zoom + pan.y;
      const seen = sx >= 0 && sy >= 0 && sx + Math.min(r.w, FOCUS_W) * zoom <= was.w && sy + r.h * zoom <= was.h;
      if (seen && showRect(r)) return;
    }
    cull();
  }).observe(root);

  document.getElementById('btn-zoom-in').onclick = () => zoomBy(ZOOM_STEP);
  document.getElementById('btn-zoom-out').onclick = () => zoomBy(1 / ZOOM_STEP);
  document.getElementById('btn-zoom-fit').onclick = fit;
  zoomLabel.onclick = () => zoomBy(1 / zoom);
  initMinimap();

  subscribe(({ kind, source }) => {
    if (!active()) return;
    // Another workflow (Mới, Mở…, Mẫu): start again at 100 % with its Start card at the left.
    if (kind === 'workflow' && source === 'replace') placed = false;
    // Typing in the inspector: one rebuild per frame at most, not one per keystroke (the minimap: per 250 ms).
    mmThrottle = kind === 'workflow' && source === 'inspector';
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
  mm?.el.classList.remove('show');
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
  staleStats = resultStale();
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
  mmDirty = true;
  applyNow(); // the elements exist before focus is put back on one of them
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
      // One tab stop for the whole tree (the selected card): its buttons and the "+" are reached
      // with the keys ("/", ContextMenu, ← →, F8), and the DOM order of culled elements is not
      // the reading order.
      for (const b of el.matches('button') ? [el] : el.querySelectorAll('button')) b.tabIndex = -1;
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
  updateMinimap();
}

const KEEP_VISIBLE = 120; // px of the diagram that panning always leaves on screen

/** Pan never loses the diagram: at least KEEP_VISIBLE px of its box stay in the viewport. */
function clampPan() {
  if (!lay) return;
  const W = root.clientWidth;
  const H = root.clientHeight;
  const w = lay.width * zoom;
  const hh = lay.height * zoom;
  const kx = Math.min(KEEP_VISIBLE, w, W);
  const ky = Math.min(KEEP_VISIBLE, hh, H);
  pan = { x: Math.min(W - kx, Math.max(kx - w, pan.x)), y: Math.min(H - ky, Math.max(ky - hh, pan.y)) };
}

let cullFrame = 0;
function applyTransform() {
  clampPan();
  world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  root.style.backgroundSize = `${20 * zoom}px ${20 * zoom}px`;
  root.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  zoomLabel.title = `Thu phóng ${Math.round(zoom * 100)}%. Bấm để về 100%.`;
  zoomLabel.setAttribute('aria-label', `Thu phóng ${Math.round(zoom * 100)}%, bấm để về 100%`);
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
  const est = startEstimate();
  return h(
    'div',
    {
      class: 'step-card start-card dg-card',
      'data-id': START_ID,
      'data-type': 'start',
      role: 'treeitem',
      'aria-level': '1',
      'aria-posinset': '1',
      'aria-setsize': String(lay.rootSize),
      tabindex: '-1',
      onclick: (e) => cardClick(e, START_ID),
    },
    h('div', { class: 'dg-row' }, h('span', { class: 'type' }, icoTile(), h('span', { class: 'type-label' }, 'Bắt đầu')), h('span', { class: 'badges' })),
    h('div', { class: 'sum dg-sum', title: wf.name || 'Workflow' }, wf.name || 'Workflow'),
    h('div', { class: 'dg-tags' },
      h('span', { class: 'dg-note', title: 'Ước tính từ cấu hình · giới hạn bản ghi mỗi lần chạy' }, est.text),
      est.over ? h('span', { class: 'tag-est-over', title: est.over.title }, est.over.label) : null),
  );
}

function cardClick(e, id) {
  if (e.target.closest('button')) return;
  if (id !== START_ID && inSelectMode()) toggleSelected(id); // narrow select mode (design 0012 B)
  else if (id !== START_ID && (e.shiftKey || e.ctrlKey || e.metaKey)) clickSelect(id, { range: e.shiftKey, toggle: !e.shiftKey });
  else {
    select(id === START_ID ? { kind: 'workflow' } : { kind: 'step', id });
    openSheet(); // narrow screens: a tap on the selected card shows the sheet a run (or ‹ Xong) closed
  }
  e.currentTarget.focus({ preventScroll: true });
}

function cardEl(n) {
  const step = n.step;
  const type = nodeType(step.type);
  const alias = stepAlias(step);
  const summary = stepSummary(step);
  const head = n.kind === 'frame';
  const parts = {
    type: h('span', { class: 'type' }, icoTile(), h('span', { class: 'type-label' }, typeLabel(step))),
    alias: alias ? h('span', { class: 'alias', title: alias }, alias) : null,
    sum: h('span', { class: `sum${head ? '' : ' dg-sum'}`, title: summary }, summary),
    badges: h('span', { class: 'badges' }),
    off: step.disabled ? h('span', { class: 'tag-off', title: 'Bước này đang tắt: không chạy và không được kiểm tra. Ctrl+/ để bật lại.' }, 'Đã tắt') : null,
    sample: type?.needsOrg && !state.org && !step.disabled ? h('span', { class: 'tag-sample', title: 'Chưa chọn org: Xem trước dùng bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.' }, 'chưa chọn org') : null,
    note: n.collapsed ? h('span', { class: 'dg-note', 'data-count': String(innerCount(step)) }) : null,
    menu: h('button', { class: 'icon menu-btn', title: 'Thao tác với bước', 'aria-label': `Thao tác với bước ${stepLabel(step)}`, onclick: (e) => openStepMenu(e.currentTarget, step.id) }, ico('more')),
    toggle: n.container
      ? h('button', { class: 'icon toggle', title: n.collapsed ? 'Mở khung' : 'Thu gọn khung', 'aria-label': n.collapsed ? 'Mở khung' : 'Thu gọn khung', onclick: () => setCollapsed([step.id], !n.collapsed) }, ico(n.collapsed ? 'chevron-right' : 'chevron-down'))
      : null,
  };
  const attrs = {
    class: `step-card dg-card${head ? ' dg-head' : ''}${step.disabled ? ' is-disabled' : ''}${n.collapsed ? ' is-collapsed' : ''}`,
    'data-id': step.id,
    'data-type': step.type,
    role: 'treeitem',
    'aria-level': String(n.level),
    'aria-posinset': String(n.posinset),
    'aria-setsize': String(n.setsize),
    'aria-expanded': n.container ? String(!n.collapsed) : undefined,
    tabindex: '-1',
    onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, // Shift+click: a range of cards, not text
    onclick: (e) => cardClick(e, step.id),
  };
  // A frame header is one row, like a Quy trình card; other cards have three short rows.
  // The stat chip and the insert-error tag are added by paintCardRun (decorateCard): before the
  // badges of a frame header, after the note in the tag row of other cards.
  if (head) return h('div', attrs, parts.type, parts.alias, parts.sum, parts.badges, parts.off, parts.sample, parts.menu, parts.toggle);
  // The alias goes on the summary row, so the type label keeps the first row ("Query (đọc org)").
  return h(
    'div',
    attrs,
    h('div', { class: 'dg-row' }, parts.type, parts.badges, parts.menu, parts.toggle),
    h('div', { class: 'dg-row' }, parts.alias, parts.sum),
    h('div', { class: 'dg-tags' }, parts.note, parts.off, parts.sample),
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
  }, ico('plus'));
  return el;
}

function emptyEl(e) {
  const target = { parentId: e.parentId, slot: e.slot, index: 0 };
  if (e.root) {
    return h('button', { class: 'add-first dg-empty', title: 'Thêm bước ở đây (/)', ...targetAttrs(null, null, 0), onclick: (ev) => openAddMenu(ev.currentTarget, target) }, ico('plus'), 'Thêm bước đầu tiên');
  }
  return h(
    'button',
    { class: 'slot-empty dg-empty', title: 'Thêm bước ở đây (/)', 'aria-label': emptySlotLabel(e.def), ...targetAttrs(e.parentId, e.slot, 0), onclick: (ev) => openAddMenu(ev.currentTarget, target) },
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
  mmDirty = true; // selected and error groups
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
  const primary = id === (selectedId() ?? null);
  // Every selected card has the selected style (design 0012 B); cards made again after cull too.
  const selected = primary || (id !== START_ID && isSelected(id));
  card.classList.toggle('selected', selected);
  card.classList.toggle('is-ref-target', id === refTargetId()); // 0012 I (a card made again by cull)
  card.setAttribute('aria-selected', String(selected));
  // Roving tab stop: the primary selected card, or the Start card when nothing is selected.
  card.tabIndex = primary || (id === START_ID && !selectedId()) ? 0 : -1;
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
    errors ? h('button', { class: 'badge', tabindex: '-1', title: `${errors} lỗi — bấm để xem`, onclick: jump }, String(errors)) : '',
    warnings ? h('button', { class: 'badge warn', tabindex: '-1', title: `${warnings} cảnh báo — bấm để xem`, onclick: jump }, String(warnings)) : '',
  );
  const note = card.querySelector('.dg-note[data-count]');
  if (note) {
    const parts = [`${note.dataset.count} bước bên trong`];
    if (inner.errors) parts.push(`${inner.errors} lỗi`);
    else if (inner.warnings) parts.push(`${inner.warnings} cảnh báo`);
    note.dataset.base = parts.join(' · ');
  }
  paintRun(card);
}

/** Chip, insert-error tag and the collapsed note's insert count of one card (design 0012 D, H). */
function paintRun(card, steps = stepsById()) {
  const step = steps.get(card.dataset.id);
  if (!step) return;
  const tags = card.querySelector(':scope > .dg-tags');
  const note = card.querySelector('.dg-note[data-count]');
  paintCardRun(card, step, tags
    ? { stale: staleStats, parent: tags, before: note ? note.nextSibling : tags.firstChild, tabindex: '-1' }
    : { stale: staleStats, parent: card, before: card.querySelector(':scope > .badges'), tabindex: '-1' });
  if (note) note.textContent = noteText(note.dataset.base ?? '', step);
}

/** Progress of a run (design 0012 D): patch the chip and tag of every card made, nothing else. */
export function paintRunInfo() {
  if (!lay || state.view !== 'canvas') return;
  staleStats = resultStale();
  const steps = stepsById();
  for (const el of els.values()) if (el.classList.contains('step-card')) paintRun(el, steps);
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
  return Math.max(0, Math.min(H, window.innerHeight - insp.offsetHeight - top));
}

/**
 * What floats over the viewport (viewport coordinates): the zoom bar (top right) and, when shown,
 * the minimap (bottom right). showRect keeps cards out from under both.
 */
function overlayRects() {
  const v = root.getBoundingClientRect();
  const rel = (z) => ({ left: z.left - v.left, top: z.top - v.top, right: z.right - v.left, bottom: z.bottom - v.top });
  const out = [];
  const bar = wrap.querySelector('.dg-zoom')?.getBoundingClientRect();
  if (bar?.width) out.push(rel(bar));
  if (minimapShown()) out.push(rel(mm.el.getBoundingClientRect()));
  return out;
}

/**
 * Pan so that a world rectangle is visible: inside the viewport, above the bottom sheet and not
 * under the zoom bar. `center`: centre it when it is not fully visible (switching views,
 * reveal); otherwise the smallest pan (keyboard moves). When the visible height is smaller than
 * the card (landscape phone with the sheet open), the card's top is shown.
 */
function showRect(r, { center = false } = {}) {
  const W = root.clientWidth;
  const H = visibleHeight();
  const w = Math.min(r.w, FOCUS_W);
  const sw = w * zoom;
  const sh = r.h * zoom;
  const M = Math.max(0, Math.min(EDGE_MARGIN, (H - sh) / 2, (W - sw) / 2));
  const overlays = overlayRects();
  const at = (p) => ({ sx: r.x * zoom + p.x, sy: r.y * zoom + p.y });
  const coveredBy = (p, o) => {
    const { sx, sy } = at(p);
    return sx < o.right + M && sx + sw > o.left - M && sy < o.bottom + M && sy + sh > o.top - M;
  };
  const covered = (p) => overlays.some((o) => coveredBy(p, o));
  const fits = (p) => {
    const { sx, sy } = at(p);
    return sx >= M && sx + sw <= W - M && (sh > H ? sy >= 0 && sy <= M : sy >= M && sy + sh <= H - M) && !covered(p);
  };
  if (fits(pan)) return false;
  let next;
  if (center) next = { x: W / 2 - (r.x + w / 2) * zoom, y: H / 2 - (r.y + r.h / 2) * zoom };
  else {
    let { x, y } = pan;
    const { sx, sy } = at(pan);
    if (sx + sw > W - M) x -= sx + sw - (W - M);
    if (r.x * zoom + x < M) x = M - r.x * zoom;
    if (sy + sh > H - M) y -= sy + sh - (H - M);
    if (r.y * zoom + y < M) y = M - r.y * zoom;
    next = { x, y };
  }
  if (sh > H) next.y = M - r.y * zoom; // taller than what is visible: show its top
  // Under the zoom bar or the minimap: move the card left of it, or (no room on the left) below the
  // bar / above the minimap.
  for (const o of overlays) {
    if (!coveredBy(next, o)) continue;
    if (o.left - M - sw >= M) next.x = o.left - M - sw - r.x * zoom;
    else if (o.top > H / 2) next.y = o.top - M - sh - r.y * zoom;
    else next.y = o.bottom + M - r.y * zoom;
  }
  pan = { x: Math.round(next.x), y: Math.round(next.y) };
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
  root.focus({ preventScroll: true }); // + / − / 0 keep working after a click on the background
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
  cull();
  cardElement(id)?.focus({ preventScroll: true });
}

/** Open collapsed ancestors, pan the card into view (centred), optionally focus and flash it. */
export function revealStep(id, { flash = false, focus = true, block = 'center' } = {}) {
  if (ops.expandAncestors(id)) setCollapsed([], false); // persists + re-renders
  if (!lay) return;
  ensureVisible(id, { center: block === 'center' });
  cull(); // the card exists even when no pan was needed (a render just replaced the elements)
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
  // Shift+↑ / Shift+↓: grow or shrink the range inside the anchor's sequence (design 0012 B).
  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (extendBy(e.key === 'ArrowUp' ? -1 : 1)) focusSelected();
    return;
  }
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
      // Only on the card itself: Enter on its ⋯ / ▾ or on a "+" activates that button.
      if (!e.target.matches('.step-card')) return undefined;
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

// ---------- minimap (design 0014 §5) ----------

const MM_KEY = 'sfdg.minimap';
const MM_THROTTLE = 250; // ms between two rebuilds while typing in the inspector
let mm = null; // { el, svg, gFrames, gCards, paths: Map, off, err, sel, halo, view, track, thumb, model, built }
let mmOn = true;
let mmDirty = true;
let mmThrottle = false;
let mmBuildFrame = 0;
let mmBuildTimer = 0;
let mmLastBuild = -Infinity;
let mmHold = null; // { x, y }: the window held still while dragging on the map

const svgEl = (tag, cls) => {
  const el = document.createElementNS(SVG, tag);
  if (cls) el.setAttribute('class', cls);
  return el;
};

function initMinimap() {
  const el = document.getElementById('dg-minimap');
  const svg = svgEl('svg', 'mm-map');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'none');
  const gFrames = svgEl('g');
  const gCards = svgEl('g');
  mm = {
    el, svg, gFrames, gCards, paths: new Map(),
    off: svgEl('path', 'mm-off'), err: svgEl('path', 'mm-err'), sel: svgEl('path', 'mm-sel'),
    halo: svgEl('rect', 'mm-view-halo'), view: svgEl('rect', 'mm-view'),
    track: el.querySelector('.mm-track'), thumb: el.querySelector('.mm-thumb'), model: null, built: null,
  };
  svg.append(gFrames, gCards, mm.off, mm.err, mm.sel, mm.halo, mm.view);
  el.prepend(svg);
  try { mmOn = localStorage.getItem(MM_KEY) !== '0'; } catch { /* storage blocked: on */ }
  const btn = document.getElementById('btn-minimap');
  btn.setAttribute('aria-pressed', String(mmOn));
  btn.onclick = () => {
    mmOn = !mmOn;
    try {
      if (mmOn) localStorage.removeItem(MM_KEY);
      else localStorage.setItem(MM_KEY, '0');
    } catch { /* not remembered */ }
    btn.setAttribute('aria-pressed', String(mmOn));
    updateMinimap();
  };
  // Map: a press centres the viewport there; a drag follows the pointer, the window held still.
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !mm.model) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    mmHold = { x: mm.model.window.x, y: mm.model.window.y };
    centreOnMap(e);
  });
  svg.addEventListener('pointermove', (e) => { if (mmHold) centreOnMap(e); });
  const release = () => {
    if (!mmHold) return;
    mmHold = null;
    updateMinimap(); // the window follows the viewport again
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  // Overview track: the viewport goes to that place of the whole diagram (same zoom, same height).
  let onTrack = false;
  mm.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !lay) return;
    e.preventDefault();
    mm.track.setPointerCapture(e.pointerId);
    onTrack = true;
    goToTrack(e);
  });
  mm.track.addEventListener('pointermove', (e) => { if (onTrack) goToTrack(e); });
  mm.track.addEventListener('pointerup', () => { onTrack = false; });
  mm.track.addEventListener('pointercancel', () => { onTrack = false; });
  // A wheel over the minimap does nothing (a slip of the wheel must not throw the diagram far away).
  el.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
}

/** Shown: switched on, in the Sơ đồ view, the diagram larger than the viewport, not hidden by CSS (phone, sheet). */
function minimapShown() {
  if (!mm?.el.classList.contains('show')) return false;
  return getComputedStyle(mm.el).visibility !== 'hidden';
}

const viewWorld = () => ({ x: -pan.x / zoom, y: -pan.y / zoom, w: root.clientWidth / zoom, h: visibleHeight() / zoom });

function minimapModelNow() {
  const w = mm.svg.clientWidth || mm.el.clientWidth;
  if (!lay || !w) return null;
  return minimapModel(lay, viewWorld(), { w }, mmHold ? { windowX: mmHold.x, windowY: mmHold.y } : {});
}

/** Every frame of a pan / zoom: O(1) (viewBox, the viewport rectangle, the thumb). */
function updateMinimap() {
  if (!mm) return;
  const overflows = lay && (lay.width * zoom > root.clientWidth || lay.height * zoom > root.clientHeight);
  const show = Boolean(mmOn && active() && overflows);
  mm.el.classList.toggle('show', show);
  if (!show) return;
  const model = minimapModelNow();
  if (!model) return;
  mm.model = model;
  const { window: win, viewRect: v, track } = model;
  mm.svg.style.height = `${Math.round(model.height)}px`;
  mm.svg.setAttribute('viewBox', `${win.x} ${win.y} ${win.w} ${win.h}`);
  for (const r of [mm.halo, mm.view]) {
    r.toggleAttribute('hidden', !v);
    if (!v) continue;
    r.setAttribute('x', v.x);
    r.setAttribute('y', v.y);
    r.setAttribute('width', v.w);
    r.setAttribute('height', v.h);
  }
  mm.track.hidden = !track;
  if (track) {
    mm.thumb.style.left = `${track.left}px`;
    mm.thumb.style.width = `${track.width}px`;
  }
  const b = mm.built;
  if (mmDirty || !b || win.x < b.x0 || win.x + win.w > b.x1) scheduleMinimapBuild();
}

function scheduleMinimapBuild() {
  if (mmBuildFrame || mmBuildTimer) return;
  const wait = mmThrottle ? MM_THROTTLE - (performance.now() - mmLastBuild) : 0;
  const go = () => { mmBuildTimer = 0; mmBuildFrame = requestAnimationFrame(buildMinimap); };
  if (wait > 0) mmBuildTimer = setTimeout(go, wait);
  else go();
}

/** The path groups for the window ± one window (a long diagram builds only what is near). */
function buildMinimap() {
  mmBuildFrame = 0;
  if (!lay || !mm.model || !active()) return;
  mmLastBuild = performance.now();
  mmDirty = false;
  const { window: win, scale } = mm.model;
  const range = { x0: win.x - win.w, x1: win.x + 2 * win.w };
  const errors = new Set([...issues].filter(([, v]) => v.errors?.length).map(([id]) => id));
  const p = minimapPaths(lay, { errors, selected: selectedId(), startId: START_ID, range, grow: 1.5 / scale });
  const used = new Set();
  const put = (key, parent, cls, type, d) => {
    used.add(key);
    let path = mm.paths.get(key);
    if (!path) {
      path = svgEl('path', cls);
      path.setAttribute('data-type', type);
      parent.append(path);
      mm.paths.set(key, path);
    }
    if (path.getAttribute('d') !== d) path.setAttribute('d', d);
  };
  for (const [type, d] of Object.entries(p.frames)) put(`f:${type}`, mm.gFrames, 'mm-frame', type, d);
  for (const [type, d] of Object.entries(p.cards)) put(`c:${type}`, mm.gCards, 'mm-card', type, d);
  for (const [key, path] of mm.paths) {
    if (used.has(key)) continue;
    path.remove();
    mm.paths.delete(key);
  }
  mm.off.setAttribute('d', p.off);
  mm.err.setAttribute('d', p.err);
  mm.sel.setAttribute('d', p.sel);
  mm.built = range;
}

function centreOnMap(e) {
  const model = minimapModelNow();
  if (!model) return;
  const box = mm.svg.getBoundingClientRect();
  const p = mapToWorld(model, e.clientX - box.left, e.clientY - box.top, box.width);
  const W = root.clientWidth;
  const H = visibleHeight();
  const vw = W / zoom;
  const vh = H / zoom;
  const win = model.window;
  // While dragging, the viewport stays inside the held window.
  if (vw < win.w) p.x = Math.min(win.x + win.w - vw / 2, Math.max(win.x + vw / 2, p.x));
  if (vh < win.h) p.y = Math.min(win.y + win.h - vh / 2, Math.max(win.y + vh / 2, p.y));
  pan = { x: Math.round(W / 2 - p.x * zoom), y: Math.round(H / 2 - p.y * zoom) };
  applyNow();
}

function goToTrack(e) {
  const box = mm.track.getBoundingClientRect();
  const x = trackToWorld(e.clientX - box.left, box.width, lay.width);
  pan = { x: Math.round(root.clientWidth / 2 - x * zoom), y: pan.y };
  applyNow();
}
