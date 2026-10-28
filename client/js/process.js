// "Quy trình" view (design 0003): the workflow as a vertical list of step cards, with
// Lặp / Rẽ nhánh drawn as nested frames, "+" insertion points between steps, drag and drop,
// and tree keyboard navigation. Configuration is edited in the inspector only; cards show
// summaries and read-only details.
//
// Rendering: workflow / view / result events rebuild the DOM (keeping scroll and focus);
// selection and issue events only update classes and badges (decorate()), so focus and
// scroll position survive.

import { h, icoTile } from './dom.js';
import {
  state, subscribe, select, nodeType, fieldType, slotKeys, locate, stepById, setCollapsed, runKey,
} from './store.js';
import { allSteps, slotList, walkSteps } from '/shared/workflow-tree.js';
import { exposesOf } from '/shared/scope.js';
import { stepSummary, stepAlias, statChip, stepLabel } from './summary.js';
import * as ops from './ops.js';
import { openField, openSheet } from './inspector.js';
import { openPopup } from './popup.js';

const MAX_FIELD_CHIPS = 12;
const START_ID = '__start';

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
    // Typing in the inspector: one rebuild per frame at most, not one per keystroke.
    if (kind === 'workflow' && source === 'inspector') scheduleRender();
    else if (kind === 'workflow' || kind === 'all' || kind === 'view' || kind === 'result') render();
    else if (kind === 'selection' || kind === 'issues') decorate();
  });
  ops.onReveal(revealStep);
  // The first render is done by main.js (emit 'all'), which can recover from a broken autosave.
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
  staleStats = state.lastRunSteps !== null && state.lastRunSteps !== JSON.stringify(state.workflow.steps);
  const scroll = root.scrollTop;
  const hadFocus = root.contains(document.activeElement) && !document.activeElement.closest('.popup');
  const steps = state.workflow.steps ?? [];
  root.replaceChildren(
    h('div', { class: 'seq seq-root' },
      startCard(),
      steps.length
        ? renderSeq(steps, null, null, 1)
        : h('div', { class: 'add-point big', ...targetAttrs({ parentId: null, slot: null, index: 0 }) },
          h('button', { class: 'add-first', title: 'Thêm bước ở đây (/)', onclick: (e) => openAddMenu(e.currentTarget, { parentId: null, slot: null, index: 0 }) }, '+ Thêm bước đầu tiên')),
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

function startCard() {
  const wf = state.workflow;
  const max = wf.settings?.maxRecords ?? state.meta?.limits.maxRecordsDefault;
  return h(
    'div',
    {
      class: 'step-card start-card',
      'data-id': START_ID,
      role: 'treeitem',
      'aria-level': '1',
      tabindex: '-1',
      'data-type': 'start',
      onclick: () => {
        select({ kind: 'workflow' });
        openSheet();
      },
    },
    h('span', { class: 'type' }, icoTile(), 'Bắt đầu'),
    h('span', { class: 'sum' }, `${wf.name || 'Workflow'} · ≤ ${Number(max).toLocaleString('vi-VN')} bản ghi`),
    h('span', { class: 'badges' }),
  );
}

const isStep = (step) => step && typeof step === 'object' && !Array.isArray(step);

function renderSeq(list, parentId, slot, level) {
  const out = [];
  list.forEach((step, index) => {
    out.push(addPoint({ parentId, slot, index }, list), isStep(step) ? renderStep(step, level, { parentId, slot, index }) : invalidStep(step));
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
  const before = isStep(list[target.index]) ? list[target.index] : null;
  const after = isStep(list[target.index - 1]) ? list[target.index - 1] : null;
  let label;
  if (after) label = `Thêm bước sau "${nameOf(after)}"`;
  else if (before) label = `Thêm bước trước "${nameOf(before)}"`;
  else label = 'Thêm bước ở đây';
  return h(
    'div',
    { class: 'add-point', ...targetAttrs(target) },
    h('button', { class: 'add-btn', title: 'Thêm bước ở đây (/)', 'aria-label': label, onclick: (e) => openAddMenu(e.currentTarget, target) }, '+'),
  );
}

const nameOf = (step) => stepAlias(step) || nodeType(step.type)?.label || step.type;

function renderStep(step, level, at) {
  const type = nodeType(step.type);
  const slots = type?.slots ?? [];
  const container = slots.length > 0;
  const collapsed = container && state.collapsed.has(step.id);
  const alias = stepAlias(step);
  const summary = stepSummary(step);
  const chip = state.result ? statChip(step, state.result.stats?.byStep) : null;
  const stale = staleStats;
  const showDetails = !container && detailsOpen.has(step.id);

  const card = h(
    'div',
    {
      class: 'step-card',
      'data-id': step.id,
      role: 'treeitem',
      'aria-level': String(level),
      'aria-expanded': container ? String(!collapsed) : undefined,
      tabindex: '-1',
      onclick: (e) => {
        if (e.target.closest('button, .handle')) return;
        select({ kind: 'step', id: step.id });
        openSheet(); // narrow screens: a tap on the selected card shows the sheet a run (or ‹ Xong) closed
        card.focus({ preventScroll: true });
      },
    },
    h('span', { class: 'handle', title: 'Kéo để di chuyển (hoặc Alt+↑ / Alt+↓)', 'aria-hidden': 'true', onpointerdown: (e) => onHandleDown(e, step) }, '⠿'),
    h('span', { class: 'type' }, icoTile(), type?.label ?? step.type),
    alias ? h('span', { class: 'alias' }, alias) : null,
    h('span', { class: 'sum', title: summary }, summary),
    chip ? h('span', { class: `stat${stale ? ' stale' : ''}`, title: stale ? 'Số liệu của lần xem trước gần nhất; workflow đã đổi sau đó.' : 'Số liệu của lần xem trước gần nhất.' }, chip) : null,
    h('span', { class: 'badges' }),
    step.disabled ? h('span', { class: 'tag-off', title: 'Bước này đang tắt: không chạy và không được kiểm tra. Ctrl+/ để bật lại.' }, 'Đã tắt') : null,
    type?.needsOrg && !state.org && !step.disabled ? h('span', { class: 'tag-sample', title: 'Chưa chọn org: Xem trước dùng bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.' }, 'chưa chọn org') : null,
    h('button', { class: 'icon menu-btn', title: 'Thao tác với bước', 'aria-label': `Thao tác với bước ${stepLabel(step)}`, onclick: (e) => openStepMenu(e.currentTarget, step.id) }, '⋯'),
    container
      ? h('button', { class: 'icon toggle', title: collapsed ? 'Mở khung' : 'Thu gọn khung', 'aria-label': collapsed ? 'Mở khung' : 'Thu gọn khung', onclick: () => setCollapsed([step.id], !collapsed) }, collapsed ? '▸' : '▾')
      : step.type === 'record'
        ? h('button', {
          class: 'icon toggle',
          title: showDetails ? 'Ẩn chi tiết' : 'Hiện các field',
          'aria-label': showDetails ? 'Ẩn chi tiết' : 'Hiện các field',
          onclick: () => {
            showDetails ? detailsOpen.delete(step.id) : detailsOpen.add(step.id);
            render();
          },
        }, showDetails ? '▾' : '▸')
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
    let n = 0;
    walkSteps(Object.values(step.slots ?? {}).flat(), () => { n++; }, slotKeys);
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
  const where = labelled ? `vào nhánh ${def.label}` : 'vào vòng lặp';
  return h(
    'div',
    { class: `slot slot-${def.key}`, 'data-slot-of': step.id, 'data-slot-key': def.key },
    labelled ? h('div', { class: 'slot-label' }, def.label || def.key) : null,
    list.length
      ? h('div', { class: 'seq' }, renderSeq(list, step.id, def.key, level))
      : h('div', { class: 'slot-empty-wrap' },
        h('button', { class: 'slot-empty', ...targetAttrs(target), title: 'Thêm bước ở đây (/)', 'aria-label': `Thêm bước ${where}`, onclick: (e) => openAddMenu(e.currentTarget, target) }, `+ ${def.empty || 'Thêm bước'}`),
        def.hint ? h('div', { class: 'slot-hint' }, def.hint) : null),
    h('div', { class: 'slot-msg', hidden: true }),
  );
}

function fieldChips(step) {
  const fields = Array.isArray(step.config?.fields) ? step.config.fields : [];
  const chips = fields.slice(0, MAX_FIELD_CHIPS).map((f, i) => {
    const t = fieldType(f.type)?.label ?? f.type;
    const ref = (f.type === 'lookup' || f.type === 'masterdetail') && f.options?.ref ? ` → ${f.options.ref}` : '';
    return h('button', {
      class: 'field-chip',
      'data-field': `fields.${f.name}`,
      title: 'Mở tùy chọn của field này trong panel bên phải',
      onclick: () => openField(step.id, i),
    }, `${f.name || '(chưa đặt tên)'} · ${t}${ref}`);
  });
  if (fields.length > MAX_FIELD_CHIPS) chips.push(h('span', { class: 'field-more' }, `+${fields.length - MAX_FIELD_CHIPS} field`));
  if (!fields.length) chips.push(h('span', { class: 'field-more' }, 'Chưa có field nào.'));
  return h('div', { class: 'details' }, chips);
}

// ---------- decoration (selection, issues) without rebuilding ----------

function issuesByStep() {
  const map = new Map();
  for (const [level, list] of [['errors', state.issues.errors], ['warnings', state.issues.warnings]]) {
    for (const i of list) {
      const key = i.nodeId && stepById(i.nodeId) ? i.nodeId : START_ID;
      const entry = map.get(key) ?? { errors: [], warnings: [] };
      entry[level].push(i);
      map.set(key, entry);
    }
  }
  return map;
}

function decorate() {
  if (!root) return;
  const issues = issuesByStep();
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
    const selected = id === selectedId;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-selected', String(selected));
    card.tabIndex = -1;
    if (selected) focusable = card;
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
      note.textContent = parts.join(' · ');
    }
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

function innerIssues(id, issues) {
  const step = stepById(id);
  const out = { errors: 0, warnings: 0, first: null };
  if (!step) return out;
  walkSteps(Object.values(step.slots ?? {}).flat(), (s) => {
    const i = issues.get(s.id);
    if (!i) return;
    out.errors += i.errors.length;
    out.warnings += i.warnings.length;
    if (!out.first && (i.errors.length || i.warnings.length)) out.first = s.id;
  }, slotKeys);
  return out;
}

// ---------- selection helpers ----------

function cardOf(id) {
  return root.querySelector(`.step-card[data-id="${CSS.escape(id)}"]`);
}

export function focusSelected() {
  const sel = state.selection;
  const card = sel?.kind === 'step' ? cardOf(sel.id) : root.querySelector('.start-card');
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest' });
}

/** Open collapsed ancestors, scroll the card to the centre, optionally flash it. */
function revealStep(id, { flash = false, focus = true } = {}) {
  if (ops.expandAncestors(id)) setCollapsed([], false); // persists + re-renders
  const card = cardOf(id);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'auto' });
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

// ---------- popups: "+" menu and step menu (client/js/popup.js) ----------

function openAddMenu(anchor, target) {
  const types = state.meta.nodeTypes;
  const items = [];
  for (const cat of state.meta.stepCategories ?? [{ key: undefined, label: '' }]) {
    const inCat = types.filter((t) => t.category === cat.key);
    if (!inCat.length) continue;
    items.push({ group: cat.label });
    for (const t of inCat) items.push({ type: t.type, label: t.label, desc: t.description.split('.')[0], onSelect: () => ops.addStep(t.type, target) });
  }
  const rest = types.filter((t) => !(state.meta.stepCategories ?? []).some((c) => c.key === t.category));
  for (const t of rest) items.push({ type: t.type, label: t.label, desc: t.description.split('.')[0], onSelect: () => ops.addStep(t.type, target) });
  openPopup(anchor, { title: 'Thêm bước', items, search: types.length > 6 });
}

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

/** A step whose records a Lặp `each` can loop over: a pool (`exposes.pool`) named by `alias` (catalogue). */
const isPoolStep = (step) => exposesOf(nodeType(step.type), step.config).some(({ ex }) => ex.pool === true && ex.name?.key === 'alias');

export function openStepMenu(anchor, id) {
  const step = stepById(id);
  if (!step) return;
  const container = slotKeys(step.type).length > 0;
  const items = [
    { label: 'Nhân bản', kbd: 'Ctrl+D', onSelect: () => ops.duplicateStep(id) },
    { label: 'Lên', kbd: 'Alt+↑', onSelect: () => ops.moveBy(id, -1) },
    { label: 'Xuống', kbd: 'Alt+↓', onSelect: () => ops.moveBy(id, 1) },
    { label: 'Bọc trong Lặp', onSelect: () => ops.wrapIn(id, 'loop') },
    { label: 'Bọc trong Rẽ nhánh', onSelect: () => ops.wrapIn(id, 'branch') },
    // Design 0010: a Lặp over each record of this step's pool, right after it.
    isPoolStep(step)
      ? step.config?.alias
        ? { label: 'Lặp qua từng bản ghi', title: `Thêm bước Lặp ngay sau bước này, chạy một lần cho mỗi bản ghi của "${step.config.alias}".`, onSelect: () => ops.addEachLoopAfter(id) }
        : { label: 'Lặp qua từng bản ghi', disabled: true, title: 'Đặt alias cho bước này trước.' }
      : null,
    container
      ? { label: 'Bỏ vỏ (giữ các bước bên trong)', disabled: !ops.canUnwrap(step), title: ops.canUnwrap(step) ? undefined : 'Chỉ bỏ vỏ được khi một nhánh trống.', onSelect: () => ops.unwrap(id) }
      : null,
    { label: step.disabled ? 'Bật bước' : 'Tắt bước', kbd: 'Ctrl+/', onSelect: () => ops.toggleDisabled(id) },
    { label: 'Xóa', kbd: 'Delete', danger: true, onSelect: () => ops.deleteStep(id) },
  ].filter(Boolean);
  select({ kind: 'step', id });
  openPopup(anchor, { title: stepLabel(step), items });
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

// Steps are moved with pointer events on the ⠿ handle (mouse and touch).
function onHandleDown(e, step) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  const stepEl = handle.closest('.step');
  const start = { x: e.clientX, y: e.clientY };
  let drag = null;
  let holdTimer = null;
  let last = start;
  let scrollRaf = 0;

  const begin = () => {
    select({ kind: 'step', id: step.id });
    const card = stepEl.querySelector(':scope > .step-card');
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    root.classList.add('dragging');
    stepEl.classList.add('drag-source');
    // No drop inside the dragged step itself.
    for (const p of stepEl.querySelectorAll('.add-point, .slot-empty')) p.classList.add('no-drop');
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
      stepEl.classList.remove('drag-source');
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
    if (target) ops.moveTo(step.id, target);
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


