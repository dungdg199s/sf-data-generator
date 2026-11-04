// "Quy trình" view (design 0003): the workflow as a vertical list of step cards, with
// Lặp / Rẽ nhánh drawn as nested frames, "+" insertion points between steps, drag and drop,
// and tree keyboard navigation. Configuration is edited in the inspector only; cards show
// summaries and read-only details.
//
// Rendering: workflow / view / result events rebuild the DOM (keeping scroll and focus);
// selection and issue events only update classes and badges (decorate()), so focus and
// scroll position survive. While the Sơ đồ view is shown (views.js) this view is empty and
// does not render.

import { h, ico, icoTile } from './dom.js';
import { state, subscribe, select, nodeType, fieldType, slotKeys, stepById, setCollapsed, currentScope } from './store.js';
import { allSteps, slotList } from '/shared/workflow-tree.js';
import {
  stepSummary, stepAlias, stepLabel, addPointLabel, issuesByStep, innerIssues, innerCount, emptySlotLabel,
  startEstimate,
} from './summary.js';
import * as ops from './ops.js';
import { openField, openSheet } from './inspector.js';
import { openAddMenu, openStepMenu } from './menus.js';
import { START_ID } from './layout.js';
import { bindRefTarget, refSourceStep, sourceTitle, refTargetId } from './ref-target.js';
import { paintCardRun, resultStale, noteText, stepsById } from './run-cards.js';
import { isSelected, clickSelect, toggleSelected, extendBy, inSelectMode, selectionInfo } from './selection.js';

const MAX_FIELD_CHIPS = 12;

let root;
const detailsOpen = new Set(); // record steps showing their field chips

export function initProcess() {
  root = document.getElementById('process');
  root.addEventListener('keydown', onTreeKey);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.classList.contains('seq')) select(null);
  });
  root.addEventListener('dragover', onPaletteDragOver);
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) highlightDrop(null); });
  root.addEventListener('drop', onPaletteDrop);
  document.getElementById('btn-collapse-all').onclick = () => setCollapsed(containerIds(), true);
  document.getElementById('btn-expand-all').onclick = () => setCollapsed(containerIds(), false);
  subscribe(({ kind, source }) => {
    if (!active()) return;
    // Typing in the inspector: one rebuild per frame at most, not one per keystroke.
    if (kind === 'workflow' && source === 'inspector') scheduleRender();
    else if (kind === 'workflow' || kind === 'all' || kind === 'view' || kind === 'result') render();
    else if (kind === 'selection' || kind === 'issues') decorate();
  });
  ops.onReveal((id, opts) => { if (active()) revealStep(id, opts); });
  // The first render is done by main.js (emit 'all'), which can recover from a broken autosave.
}

const active = () => state.view !== 'canvas';

/** The Sơ đồ view took over: drop this view's DOM (no stale cards for document-wide queries). */
export function clearProcess() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  root.replaceChildren();
}

let renderFrame = 0;
function scheduleRender() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
}

// Per-render values shared by every card (computed once in render()).
let staleStats = false;

const containerIds = () => allSteps(state.workflow, slotKeys).filter((s) => slotKeys(s.type).length).map((s) => s.id);

// ---------- rendering ----------

function render() {
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (!active()) return;
  staleStats = resultStale();
  const scroll = root.scrollTop;
  const hadFocus = root.contains(document.activeElement) && !document.activeElement.closest('.popup');
  const steps = state.workflow.steps ?? [];
  root.replaceChildren(
    h('div', { class: 'seq seq-root' },
      startCard(steps.filter(isStep).length + 1),
      steps.length
        ? renderSeq(steps, null, null, 1)
        : h('div', { class: 'add-point big', ...targetAttrs({ parentId: null, slot: null, index: 0 }) },
          h('button', { class: 'add-first', title: 'Thêm bước ở đây (/)', onclick: (e) => openAddMenu(e.currentTarget, { parentId: null, slot: null, index: 0 }) }, ico('plus'), 'Thêm bước đầu tiên')),
    ),
  );
  root.scrollTop = scroll;
  decorate();
  if (hadFocus) focusSelected();
}

function targetAttrs(t) {
  return { 'data-parent': t.parentId ?? '', 'data-slot': t.slot ?? '', 'data-index': String(t.index) };
}

function targetOf(el) {
  return { parentId: el.dataset.parent || null, slot: el.dataset.slot || null, index: Number(el.dataset.index) };
}

function startCard(rootSize) {
  const wf = state.workflow;
  const est = startEstimate();
  return h(
    'div',
    {
      class: 'step-card start-card',
      'data-id': START_ID,
      role: 'treeitem',
      'aria-level': '1',
      'aria-posinset': '1',
      'aria-setsize': String(rootSize),
      tabindex: '-1',
      'data-type': 'start',
      onclick: () => {
        select({ kind: 'workflow' });
        openSheet();
      },
    },
    h('span', { class: 'type' }, icoTile(), 'Bắt đầu'),
    h('span', { class: 'sum', title: 'Ước tính từ cấu hình · giới hạn bản ghi mỗi lần chạy' }, `${wf.name || 'Workflow'} · ${est.text}`),
    est.over ? h('span', { class: 'tag-est-over', title: est.over.title }, est.over.label) : null,
    h('span', { class: 'badges' }),
  );
}

const isStep = (step) => step && typeof step === 'object' && !Array.isArray(step);

function renderSeq(list, parentId, slot, level) {
  const out = [];
  // aria-posinset / aria-setsize among the real steps; at the root the Start card is item 1.
  const offset = parentId === null ? 1 : 0;
  const setsize = list.filter(isStep).length + offset;
  let pos = offset;
  list.forEach((step, index) => {
    out.push(addPoint({ parentId, slot, index }, list), isStep(step) ? renderStep(step, level, { parentId, slot, index, posinset: ++pos, setsize }) : invalidStep(step));
  });
  out.push(addPoint({ parentId, slot, index: list.length }, list));
  return out;
}

/** Placeholder for an entry of a hand-edited file that is not a step object. */
function invalidStep(value) {
  return h('div', { class: 'step invalid-step', role: 'note' },
    h('div', { class: 'invalid-card' },
      h('span', { class: 'type' }, 'Bước lỗi'),
      h('span', { class: 'sum' }, `Không phải một bước (${JSON.stringify(value) ?? String(value)}). Xóa mục này trong file JSON rồi mở lại.`)));
}

function addPoint(target, list) {
  const label = addPointLabel(list, target.index);
  return h(
    'div',
    { class: 'add-point', ...targetAttrs(target) },
    h('button', { class: 'add-btn', title: 'Thêm bước ở đây (/)', 'aria-label': label, onclick: (e) => openAddMenu(e.currentTarget, target) }, ico('plus')),
  );
}

function renderStep(step, level, at) {
  const type = nodeType(step.type);
  const slots = type?.slots ?? [];
  const container = slots.length > 0;
  const collapsed = container && state.collapsed.has(step.id);
  const alias = stepAlias(step);
  const summary = stepSummary(step);
  const showDetails = !container && detailsOpen.has(step.id);

  const card = h(
    'div',
    {
      class: 'step-card',
      'data-id': step.id,
      role: 'treeitem',
      'aria-level': String(level),
      'aria-posinset': String(at.posinset),
      'aria-setsize': String(at.setsize),
      'aria-expanded': container ? String(!collapsed) : undefined,
      tabindex: '-1',
      // Shift+click must not select the page's text (it selects a range of cards, design 0012 B).
      onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); },
      onclick: (e) => {
        if (e.target.closest('button, .handle')) return;
        if (inSelectMode()) toggleSelected(step.id); // narrow select mode: a tap adds / removes the card
        else if (e.shiftKey || e.ctrlKey || e.metaKey) clickSelect(step.id, { range: e.shiftKey, toggle: !e.shiftKey });
        else {
          select({ kind: 'step', id: step.id });
          openSheet(); // narrow screens: a tap on the selected card shows the sheet a run (or ‹ Xong) closed
        }
        card.focus({ preventScroll: true });
      },
    },
    h('span', { class: 'handle', title: 'Kéo để di chuyển (hoặc Alt+↑ / Alt+↓)', 'aria-hidden': 'true', onpointerdown: (e) => onHandleDown(e, step) }, ico('grip')),
    h('span', { class: 'type' }, icoTile(), type?.label ?? step.type),
    alias ? h('span', { class: 'alias' }, alias) : null,
    h('span', { class: 'sum', title: summary }, summary),
    // The stat chip and the insert-error tag go here (paintCardRun in decorate).
    h('span', { class: 'badges' }),
    step.disabled ? h('span', { class: 'tag-off', title: 'Bước này đang tắt: không chạy và không được kiểm tra. Ctrl+/ để bật lại.' }, 'Đã tắt') : null,
    type?.needsOrg && !state.org && !step.disabled ? h('span', { class: 'tag-sample', title: 'Chưa chọn org: Xem trước dùng bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.' }, 'chưa chọn org') : null,
    h('button', { class: 'icon menu-btn', title: 'Thao tác với bước', 'aria-label': `Thao tác với bước ${stepLabel(step)}`, onclick: (e) => openStepMenu(e.currentTarget, step.id) }, ico('more')),
    container
      ? h('button', { class: 'icon toggle', title: collapsed ? 'Mở khung' : 'Thu gọn khung', 'aria-label': collapsed ? 'Mở khung' : 'Thu gọn khung', onclick: () => setCollapsed([step.id], !collapsed) }, ico(collapsed ? 'chevron-right' : 'chevron-down'))
      : step.type === 'record'
        ? h('button', {
          class: 'icon toggle',
          title: showDetails ? 'Ẩn chi tiết' : 'Hiện các field',
          'aria-label': showDetails ? 'Ẩn chi tiết' : 'Hiện các field',
          onclick: () => {
            showDetails ? detailsOpen.delete(step.id) : detailsOpen.add(step.id);
            render();
          },
        }, ico(showDetails ? 'chevron-down' : 'chevron-right'))
        : null,
  );

  const el = h(
    'div',
    { class: `step${container ? ' frame' : ''}${step.disabled ? ' disabled' : ''}${collapsed ? ' collapsed' : ''}`, 'data-step': step.id, 'data-type': step.type },
    card,
  );
  if (showDetails) el.append(fieldChips(step));
  if (!container) return el;
  if (collapsed) {
    const n = innerCount(step);
    el.append(h('div', { class: 'collapsed-note', 'data-count': String(n) }, `${n} bước bên trong`));
    return el;
  }
  const body = h('div', { class: 'step-body', role: 'group' });
  if (slots.length === 1) body.append(renderSlot(step, slots[0], level + 1, false));
  else body.append(h('div', { class: 'columns' }, slots.map((s) => renderSlot(step, s, level + 1, true))));
  el.append(body);
  return el;
}

function renderSlot(step, def, level, labelled) {
  const list = slotList(step, def.key);
  const target = { parentId: step.id, slot: def.key, index: 0 };
  return h(
    'div',
    { class: `slot slot-${def.key}`, 'data-slot-of': step.id, 'data-slot-key': def.key },
    labelled ? h('div', { class: 'slot-label' }, def.label || def.key) : null,
    list.length
      ? h('div', { class: 'seq' }, renderSeq(list, step.id, def.key, level))
      : h('div', { class: 'slot-empty-wrap' },
        h('button', { class: 'slot-empty', ...targetAttrs(target), title: 'Thêm bước ở đây (/)', 'aria-label': emptySlotLabel(def), onclick: (e) => openAddMenu(e.currentTarget, target) }, `+ ${def.empty || 'Thêm bước'}`),
        def.hint ? h('div', { class: 'slot-hint' }, def.hint) : null),
    h('div', { class: 'slot-msg', hidden: true }),
  );
}

function fieldChips(step) {
  const fields = Array.isArray(step.config?.fields) ? step.config.fields : [];
  const scope = currentScope();
  const chips = fields.slice(0, MAX_FIELD_CHIPS).map((f, i) => {
    const t = fieldType(f.type)?.label ?? f.type;
    const ref = (f.type === 'lookup' || f.type === 'masterdetail') && f.options?.ref ? ` → ${f.options.ref}` : '';
    // Design 0012 I: a Lookup chip outlines its parent step's card on hover / focus.
    const src = ref ? refSourceStep(scope.refs.find((r) => r.nodeId === step.id && r.field === `fields.${f.name}` && r.option === 'ref' && !r.hidden)) : null;
    return bindRefTarget(h('button', {
      class: 'field-chip',
      'data-field': `fields.${f.name}`,
      title: `Mở tùy chọn của field này trong panel bên phải${src ? `\n${sourceTitle(src)}` : ''}`,
      onclick: () => openField(step.id, i),
    }, `${f.name || '(chưa đặt tên)'} · ${t}${ref}`), src);
  });
  if (fields.length > MAX_FIELD_CHIPS) chips.push(h('span', { class: 'field-more' }, `+${fields.length - MAX_FIELD_CHIPS} field`));
  if (!fields.length) chips.push(h('span', { class: 'field-more' }, 'Chưa có field nào.'));
  return h('div', { class: 'details' }, chips);
}

// ---------- decoration (selection, issues) without rebuilding ----------

/** Chip, insert-error tag and the collapsed note's insert count of one card (design 0012 D, H). */
function paintRun(card, note = card.parentElement.querySelector(':scope > .collapsed-note'), steps = stepsById()) {
  const step = steps.get(card.dataset.id);
  if (!step) return;
  paintCardRun(card, step, { stale: staleStats, parent: card, before: card.querySelector(':scope > .badges') });
  if (note) note.textContent = noteText(note.dataset.base ?? '', step);
}

/** Progress of a run (design 0012 D): patch every card's chip and tag, nothing else. */
export function paintRunInfo() {
  if (!root || !active()) return;
  staleStats = resultStale();
  const steps = stepsById();
  for (const card of root.querySelectorAll('.step-card')) paintRun(card, undefined, steps);
}

function decorate() {
  if (!root) return;
  const issues = issuesByStep();
  const steps = stepsById();
  const sel = state.selection;
  const selectedId = sel?.kind === 'step' && stepById(sel.id) ? sel.id : sel?.kind === 'workflow' ? START_ID : null;
  let focusable = null;

  for (const card of root.querySelectorAll('.step-card')) {
    const id = card.dataset.id;
    const stepEl = card.parentElement;
    const own = issues.get(id) ?? { errors: [], warnings: [] };
    let errors = own.errors.length;
    let warnings = own.warnings.length;
    // A collapsed frame shows the issues of the steps inside it.
    let inner = { errors: 0, warnings: 0, first: null };
    if (stepEl.classList.contains('collapsed')) {
      inner = innerIssues(id, issues);
      errors += inner.errors;
      warnings += inner.warnings;
    }
    // Every selected card has the selected style (design 0012 B); the primary one is the tab stop.
    const primary = id === selectedId;
    const selected = primary || (id !== START_ID && isSelected(id));
    card.classList.toggle('selected', selected);
    card.classList.toggle('is-ref-target', id === refTargetId());
    card.setAttribute('aria-selected', String(selected));
    card.tabIndex = -1;
    if (primary) focusable = card;
    card.classList.toggle('has-error', errors > 0);
    card.classList.toggle('has-warning', !errors && warnings > 0);
    const badges = card.querySelector(':scope > .badges');
    const jump = (e) => {
      e.stopPropagation();
      const target = inner.first ?? id;
      if (target !== START_ID) {
        ops.expandAncestors(target);
        select({ kind: 'step', id: target });
        ops.reveal(target);
      } else select({ kind: 'workflow' });
    };
    badges.replaceChildren(
      errors ? h('button', { class: 'badge', title: `${errors} lỗi — bấm để xem`, onclick: jump }, String(errors)) : '',
      warnings ? h('button', { class: 'badge warn', title: `${warnings} cảnh báo — bấm để xem`, onclick: jump }, String(warnings)) : '',
    );
    const note = stepEl.querySelector(':scope > .collapsed-note');
    if (note) {
      const parts = [`${note.dataset.count} bước bên trong`];
      if (inner.errors) parts.push(`${inner.errors} lỗi`);
      else if (inner.warnings) parts.push(`${inner.warnings} cảnh báo`);
      note.dataset.base = parts.join(' · ');
    }
    paintRun(card, note, steps);
    // Field chips and slots of this step.
    const fieldIssues = [...own.errors, ...own.warnings];
    for (const chip of stepEl.querySelectorAll(':scope > .details .field-chip')) {
      chip.classList.toggle('has-error', own.errors.some((i) => i.field === chip.dataset.field));
      chip.classList.toggle('has-warning', own.warnings.some((i) => i.field === chip.dataset.field));
    }
    for (const slot of stepEl.querySelectorAll(`:scope > .step-body .slot[data-slot-of="${CSS.escape(id)}"]`)) {
      const mine = fieldIssues.filter((i) => i.field === `slots.${slot.dataset.slotKey}`);
      const isErr = own.errors.some((i) => i.field === `slots.${slot.dataset.slotKey}`);
      slot.classList.toggle('slot-error', isErr);
      slot.classList.toggle('slot-warning', !isErr && mine.length > 0);
      const msg = slot.querySelector(':scope > .slot-msg');
      msg.hidden = !mine.length;
      msg.textContent = mine.map((i) => i.message).join(' ');
    }
  }
  (focusable ?? root.querySelector('.start-card')).tabIndex = 0;
}

// ---------- selection helpers ----------

function cardOf(id) {
  return root.querySelector(`.step-card[data-id="${CSS.escape(id)}"]`);
}

export function focusSelected() {
  if (!active()) return;
  const sel = state.selection;
  const card = sel?.kind === 'step' ? cardOf(sel.id) : root.querySelector('.start-card');
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest' });
}

/** Open collapsed ancestors, scroll the card to the centre, optionally flash it. */
export function revealStep(id, { flash = false, focus = true, block = 'center' } = {}) {
  if (ops.expandAncestors(id)) setCollapsed([], false); // persists + re-renders
  const card = cardOf(id);
  if (!card) return;
  card.scrollIntoView({ block, behavior: 'auto' });
  if (focus && !document.activeElement?.closest('#inspector input, #inspector textarea, #inspector select')) card.focus({ preventScroll: true });
  if (flash) {
    const el = card.parentElement;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 700);
  }
}

// ---------- keyboard (tree) ----------

function onTreeKey(e) {
  if (e.target.closest('input, textarea, select, .popup') || e.altKey || e.ctrlKey || e.metaKey) return;
  // Shift+↑ / Shift+↓: grow or shrink the range inside the anchor's sequence (design 0012 B).
  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (extendBy(e.key === 'ArrowUp' ? -1 : 1)) focusSelected();
    return;
  }
  const cards = [...root.querySelectorAll('.step-card')];
  const current = e.target.closest('.step-card') ?? cards.find((c) => c.classList.contains('selected'));
  const idx = cards.indexOf(current);
  const go = (card) => {
    if (!card) return;
    e.preventDefault();
    const id = card.dataset.id;
    select(id === START_ID ? { kind: 'workflow' } : { kind: 'step', id });
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'nearest' });
  };
  const stepEl = current?.parentElement;
  const isFrame = stepEl?.classList.contains('frame');
  switch (e.key) {
    case 'ArrowDown':
      return go(cards[idx + 1] ?? (idx < 0 ? cards[0] : null));
    case 'ArrowUp':
      return go(cards[idx - 1] ?? (idx < 0 ? cards[0] : null));
    case 'Home':
      return go(cards[0]);
    case 'End':
      return go(cards.at(-1));
    case 'ArrowLeft':
      if (isFrame && !stepEl.classList.contains('collapsed')) {
        e.preventDefault();
        return setCollapsed([current.dataset.id], true);
      }
      return go(stepEl?.parentElement?.closest('.step.frame')?.querySelector(':scope > .step-card'));
    case 'ArrowRight':
      if (!isFrame) return undefined;
      e.preventDefault();
      if (stepEl.classList.contains('collapsed')) return setCollapsed([current.dataset.id], false);
      return go(stepEl.querySelector(':scope > .step-body .step-card'));
    case 'Enter': {
      // Only on the card itself: Enter on its ⋯ / ▾ or on a "+" activates that button.
      if (!e.target.matches('.step-card')) return undefined;
      const input = document.querySelector('#inspector input, #inspector select, #inspector textarea');
      if (input && current) {
        e.preventDefault();
        input.focus();
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------- "+" menu at the default position (popups: menus.js) ----------

/** "/" key: the "+" menu at the default insert position. */
export function openAddMenuAtDefault() {
  const target = ops.defaultTarget();
  if (target.parentId && ops.expandAncestors(target.parentId)) setCollapsed([], false);
  if (target.parentId && state.collapsed.has(target.parentId)) setCollapsed([target.parentId], false);
  const sel = `[data-parent="${CSS.escape(target.parentId ?? '')}"][data-slot="${CSS.escape(target.slot ?? '')}"][data-index="${target.index}"]`;
  const point = root.querySelector(sel);
  const anchor = point?.matches('button') ? point : point?.querySelector('button') ?? root;
  anchor.scrollIntoView?.({ block: 'nearest' });
  openAddMenu(anchor, target);
}

// ---------- drag and drop ----------

function dropPoints() {
  return [...root.querySelectorAll('.add-point:not(.no-drop), .slot-empty:not(.no-drop)')];
}

function nearestPoint(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const p of dropPoints()) {
    const r = p.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dy * 2 + dx; // vertical distance matters most in a vertical list
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function highlightDrop(el) {
  for (const p of root.querySelectorAll('.drop-active')) if (p !== el) p.classList.remove('drop-active');
  el?.classList.add('drop-active');
}

// Palette items are dragged with HTML5 drag and drop (desktop).
export function paletteDragStart(e, type) {
  e.dataTransfer.setData('text/x-node-type', type);
  e.dataTransfer.effectAllowed = 'copy';
  root.classList.add('dragging');
}
export function paletteDragEnd() {
  root.classList.remove('dragging');
  highlightDrop(null);
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
  if (point) ops.addStep(type, targetOf(point));
}

// Steps are moved with pointer events on the grip handle (mouse and touch).
function onHandleDown(e, step) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (inSelectMode()) return; // no dragging while tapping cards in and out of the selection
  const handle = e.currentTarget;
  const stepEl = handle.closest('.step');
  // A card of a selected block drags the whole block; any other card drags alone (design 0012 B).
  const sel = isSelected(step.id) ? selectionInfo() : null;
  const block = sel && sel.ids.length > 1 && sel.contiguous ? sel.ids : null;
  const blockEls = block ? block.map((id) => root.querySelector(`.step[data-step="${CSS.escape(id)}"]`)).filter(Boolean) : [stepEl];
  const start = { x: e.clientX, y: e.clientY };
  let drag = null;
  let holdTimer = null;
  let last = start;
  let scrollRaf = 0;

  const begin = () => {
    if (!block) select({ kind: 'step', id: step.id });
    const card = stepEl.querySelector(':scope > .step-card');
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    root.classList.add('dragging');
    for (const el of blockEls) el.classList.add('drag-source');
    // No drop inside the dragged step(s) itself.
    for (const el of blockEls) for (const p of el.querySelectorAll('.add-point, .slot-empty')) p.classList.add('no-drop');
    drag = { ghost, offX: start.x - r.left, offY: start.y - r.top, target: null };
    position(last);
    const tick = () => {
      if (!drag) return;
      const rr = root.getBoundingClientRect();
      if (last.y < rr.top + 40) root.scrollTop -= 12;
      else if (last.y > rr.bottom - 40) root.scrollTop += 12;
      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  };
  const position = (p) => {
    drag.ghost.style.left = `${p.x - drag.offX}px`;
    drag.ghost.style.top = `${p.y - drag.offY}px`;
    drag.target = nearestPoint(p.x, p.y);
    highlightDrop(drag.target);
  };
  const cleanup = () => {
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrollRaf);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    if (drag) {
      drag.ghost.remove();
      root.classList.remove('dragging');
      for (const el of blockEls) el.classList.remove('drag-source');
      for (const p of root.querySelectorAll('.no-drop')) p.classList.remove('no-drop');
      highlightDrop(null);
    }
  };
  const move = (ev) => {
    last = { x: ev.clientX, y: ev.clientY };
    const dist = Math.hypot(last.x - start.x, last.y - start.y);
    if (!drag) {
      if (e.pointerType === 'mouse' && dist > 4) begin();
      else if (e.pointerType !== 'mouse' && dist > 8) cancel();
      return;
    }
    ev.preventDefault();
    position(last);
  };
  const up = () => {
    const target = drag?.target ? targetOf(drag.target) : null;
    const wasDragging = Boolean(drag);
    cleanup();
    drag = null;
    if (target && block) ops.moveBlockTo(block, target);
    else if (target) ops.moveTo(step.id, target);
    else if (!wasDragging) {
      select({ kind: 'step', id: step.id });
      cardOf(step.id)?.focus({ preventScroll: true });
    }
  };
  const cancel = () => {
    cleanup();
    drag = null;
  };
  const key = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    }
  };
  if (e.pointerType !== 'mouse') holdTimer = setTimeout(begin, 300);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}


