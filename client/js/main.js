// App bootstrap: loads metadata, migrates old workflows, wires toolbar (and its "⋯" menu on
// narrow screens, design 0009), shortcuts, live validation (issues bar: issues.js) and runs.

import { api } from './api.js';
import { h, toast, download, icoTile, watchOverflow } from './dom.js';
import {
  state, emit, subscribe, updateWorkflow, emptyWorkflow,
  undo, redo, select, stepById, runKey, saveCollapsed, slotKeys,
} from './store.js';
import { migrateV1, describeReport, reportIsEmpty } from '/shared/migrate-v1.js';
import { malformedSteps, allSteps } from '/shared/workflow-tree.js';
import { poolUsage } from '/shared/scope.js';
import { planInsert } from '/shared/insert-plan.js';
import { initViews, focusSelected, openAddMenuAtDefault, paletteDragStart, paletteDragEnd, toggleView, setView, VIEWS, paintRunInfo } from './views.js';
import { openStepMenu } from './menus.js';
import * as ops from './ops.js';
import { initInspector, openField, openSheet, closeSheet, clearDescribeCache } from './inspector.js';
import { initResults, showRunning, showProgress, endProgress, sobjectChips, insertLinks, showDeleteErrors } from './results.js';
import { initIssues, renderIssues, expandIssues, goToNextIssue } from './issues.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';
import { SAMPLES } from './samples.js';
import { stepAlias } from './summary.js';
import { initSelection, selectedIds, isMulti, collapseToPrimary, selectAllInSequence, inSelectMode } from './selection.js';
import { initSelectBar, exitSelectMode } from './select-bar.js';
import {
  initLibrary, openAsNew, importLibraryFile, openLibraryMenu, setLibraryLocked, libraryReady,
} from './library-ui.js';
import { historyStatus, refreshHistory, historyOffText, initHistory, openHistory, confirmDelete, historyChanged, bulkJobsOf, deleteInFlight } from './history.js';

const $ = (id) => document.getElementById(id);
const ORG_KEY = 'sfdg.org';

async function boot() {
  try {
    state.meta = await api.meta();
  } catch (e) {
    document.body.replaceChildren(h('p', { style: { padding: '20px' } }, `Không kết nối được server: ${e.message}`));
    return;
  }
  // The workflow library (design 0012 A); on the first run it is made from the old autosave.
  const afterBoot = initLibrary({
    migrateV1: (v1) => migrateV1(v1, migrateOptions()),
    onMigrated: (report, raw, name) => announceMigration(report, raw, { name, autosave: true }),
  });
  saveCollapsed();

  renderPalette();
  initViews();
  initInspector();
  initSelection();
  initSelectBar();
  initResults({ onRefresh: () => run(false, { refresh: true }), onGoTo: goToIssue });
  initHistory({ startDelete: deleteRun, isRunning: () => Boolean(running) || deleteInFlight() });
  // --topbar-h (design 0014 §3): the sheet's tall snap stops under the top bar, which wraps to two rows.
  new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--topbar-h', `${Math.round(entry.target.offsetHeight)}px`)).observe(document.querySelector('.topbar'));
  watchOverflow(document.querySelector('.palette')); // ≤ 900 px the palette is a row that scrolls sideways (0014 §4)
  initIssues({ onGoTo: goToIssue });
  firstRender();
  wireToolbar();
  wireShortcuts();
  wireClipboard();
  wireValidation();
  loadOrgs();
  afterBoot?.();
}

/** Options for migrateV1 from /api/meta (depth limit, defaults of the "unique" option). */
const migrateOptions = () => ({ maxDepth: state.meta?.limits?.maxDepth, fieldTypes: state.meta?.fieldTypes });

/**
 * Show the loaded workflow. If the autosave is malformed or the views fail on it, show the
 * first sample instead, without overwriting the autosave, and tell the user how to recover it.
 */
function firstRender() {
  try {
    const bad = malformedSteps(state.workflow);
    if (bad) throw new Error(bad);
    emit('app', 'all');
  } catch (e) {
    console.error(e);
    const json = JSON.stringify(state.workflow);
    let key = null;
    if (libraryReady()) {
      // The broken entry stays in the library as it is; the sample opens as a new entry.
      openAsNew(structuredClone(SAMPLES[0].workflow));
    } else {
      try {
        if (localStorage.getItem('sfdg.workflow.v2.broken') === null) localStorage.setItem('sfdg.workflow.v2.broken', json);
        key = 'sfdg.workflow.v2.broken';
      } catch {
        key = null;
      }
      state.workflow = structuredClone(SAMPLES[0].workflow); // not persisted: the autosave stays as it was
      state.selection = null;
    }
    emit('app', 'all');
    toast(
      `Không hiển thị được workflow lưu tự động (${e.message}). Đang mở mẫu "${SAMPLES[0].label}"; bản lưu cũ chưa bị ghi đè${key ? ` và có bản sao trong trình duyệt (${key})` : ''}. Bấm "Tải bản lưu" để lấy file JSON, sửa rồi Mở lại.`,
      15000,
      { label: 'Tải bản lưu', onClick: () => download('workflow-autosave.json', json) },
    );
  }
}

/** Toast when nothing changed; otherwise the report dialog with "Tải bản gốc (v1)". */
function announceMigration(report, rawOriginal, { name, autosave }) {
  if (reportIsEmpty(report)) {
    toast(
      autosave
        ? 'Đã chuyển workflow đang soạn sang định dạng mới. Bản cũ vẫn được giữ trong trình duyệt.'
        : `Đã chuyển "${name}" sang định dạng mới (version 2). Bấm Lưu để cập nhật file.`,
      6000,
    );
    return;
  }
  const modal = $('modal');
  const items = describeReport(report);
  modal.replaceChildren(
    h('h2', {}, 'Đã chuyển workflow sang dạng Quy trình'),
    h('p', {}, `Workflow này lưu ở định dạng cũ (version 1, dạng sơ đồ nối dây). Ứng dụng đã chuyển nó sang version 2 (các bước lồng nhau). ${report.duplicated?.length
      ? 'Với cùng seed, dữ liệu sinh ra giống bản cũ, trừ ở các bước được nhân bản: bản sao sinh giá trị riêng nên giá trị duy nhất, số tự tăng và dữ liệu phía sau có thể khác. Các điểm cần kiểm tra:'
      : 'Với cùng seed, dữ liệu sinh ra giống bản cũ, trừ các điểm sau:'}`),
    h('ul', { class: 'migration-report' }, items.map((i) => h('li', {}, i.message))),
    h('p', { class: 'hint' }, autosave ? 'Bản gốc vẫn được giữ trong trình duyệt.' : 'Bản gốc vẫn được giữ: file trên máy không bị sửa cho tới khi bạn bấm Lưu.'),
    h(
      'div',
      { class: 'actions' },
      h('button', { onclick: () => download(`${fileBase(name)}-v1.json`, rawOriginal) }, 'Tải bản gốc (v1)'),
      h('button', { class: 'primary', onclick: () => modal.close() }, 'Đồng ý'),
    ),
  );
  modal.onclose = null;
  modal.showModal();
}

const fileBase = (name) => (name || 'workflow').replace(/[^\w.-]+/g, '_');

function renderPalette() {
  const cats = state.meta.stepCategories ?? [];
  const types = state.meta.nodeTypes;
  const item = (t) =>
    h(
      'button',
      {
        class: 'palette-item',
        draggable: 'true',
        'data-type': t.type,
        title: `${t.description}\nBấm để thêm sau bước đang chọn; kéo vào một dấu + để đặt đúng chỗ.`,
        onclick: () => ops.addStep(t.type),
        ondragstart: (e) => paletteDragStart(e, t.type),
        ondragend: paletteDragEnd,
      },
      icoTile(),
      t.label,
      h('small', {}, t.description.split('.')[0]),
    );
  $('palette-items').replaceChildren(
    ...cats.flatMap((c) => {
      const inCat = types.filter((t) => t.category === c.key);
      return inCat.length ? [h('div', { class: 'palette-group' }, c.label), ...inCat.map(item)] : [];
    }),
    ...types.filter((t) => !cats.some((c) => c.key === t.category)).map(item),
  );
  $('sample-items').replaceChildren(
    ...SAMPLES.map((s) => h('button', { class: 'palette-item', title: s.description, onclick: () => loadSample(s) }, s.label, h('small', {}, s.description))),
  );
}

/** Mẫu (palette, or the "⋯" menu on narrow screens): a new entry of the library (design 0012 A). */
function loadSample(s) {
  openAsNew(structuredClone(s.workflow));
}

function wireToolbar() {
  const name = $('wf-name');
  name.value = state.workflow.name ?? '';
  name.oninput = () => updateWorkflow((wf) => { wf.name = name.value; }, { source: 'toolbar', coalesceKey: 'name' });
  subscribe(({ source }) => {
    if (source !== 'toolbar') name.value = state.workflow.name ?? '';
  });

  $('btn-new').onclick = () => openAsNew(emptyWorkflow());
  $('btn-save').onclick = saveFile;
  $('file-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let raw;
    let wf;
    try {
      raw = await file.text();
      wf = JSON.parse(raw);
    } catch {
      toast('Không mở được file: không phải JSON hợp lệ.', 5000);
      return;
    }
    if (importLibraryFile(wf)) return; // "Tải tất cả (JSON)" of the library: every workflow added
    openWorkflowObject(wf, raw, file.name);
  };
  $('btn-undo').onclick = () => undo() || toast('Không còn gì để hoàn tác.');
  $('btn-redo').onclick = () => redo() || toast('Không còn gì để làm lại.');
  $('btn-preview').onclick = () => run(false);
  $('btn-insert').onclick = () => run(true);
  $('btn-orgs').onclick = () => {
    clearDescribeCache(); // ⟳: describes (the "Thiếu field bắt buộc" hint, 0012 F2) are read again
    loadOrgs(true);
  };
  $('org-select').onchange = (e) => {
    state.org = e.target.value;
    try { localStorage.setItem(ORG_KEY, state.org); } catch { /* optional */ }
    updateInsertButton();
    checkHistory();
    emit('toolbar', 'all'); // inspector re-renders so "Import từ org" enables
  };
  updateInsertButton();
  $('btn-more').onclick = () => (popupAnchor() === $('btn-more') ? closePopup() : openMoreMenu());
  $('seed-chip').onclick = () => (popupAnchor() === $('seed-chip') ? closePopup() : openMoreMenu({ fromChip: true }));
  $('seed').addEventListener('input', updateSeedChip);
  updateSeedChip();
}

const phone = () => window.matchMedia('(max-width: 720px)').matches;
/** The "Thu gọn / Mở tất cả" row is hidden (app.css): phones and short narrow screens. */
const noViewTools = () => window.matchMedia('(max-width: 720px), (max-width: 900px) and (max-height: 500px)').matches;

/** Phones: "Seed 42" in the top bar while a seed is set (the Seed field itself is in the ⋯ menu). */
function updateSeedChip() {
  const v = $('seed').value.trim();
  const chip = $('seed-chip');
  chip.hidden = !v;
  chip.textContent = `Seed ${v}`;
  chip.title = `Seed cố định: ${v}. Chạm để sửa.`;
}

/** "Lịch sử insert" in the ⋯ menu (group Chạy): the same dialog as the results panel's button. */
const HISTORY_ITEM = () => ({ label: 'Lịch sử insert', icon: 'history', onSelect: () => openHistory() });

const THEMES = [['system', 'Theo hệ thống'], ['light', 'Sáng'], ['dark', 'Tối']];

/**
 * "⋯" (≤ 900 px, design 0009 §2): Mẫu always; on phones (≤ 720 px) also what the top bar hides
 * there. Every row calls the existing control (same confirmations); the Seed row mirrors #seed.
 */
function openMoreMenu({ fromChip = false } = {}) {
  const btn = $('btn-more');
  // Opened from the "Seed n" chip: anchored there, so Esc / Tab put focus back on the chip.
  const anchor = fromChip ? $('seed-chip') : btn;
  const click = (id) => () => $(id).click();
  const items = [];
  if (phone()) {
    items.push(
      { group: 'Workflow' },
      { label: 'Mới', onSelect: click('btn-new'), disabled: $('btn-new').disabled, title: $('btn-new').disabled ? $('btn-new').title : undefined },
      { label: 'Thư viện…', kbd: 'Ctrl+O', onSelect: () => openLibraryMenu() },
      { label: 'Mở file JSON…', onSelect: click('file-input'), disabled: $('btn-new').disabled, title: $('btn-new').disabled ? $('btn-new').title : undefined },
      { label: 'Lưu', kbd: 'Ctrl+S', onSelect: click('btn-save') },
      { group: 'Chạy' },
      {
        field: {
          id: 'seed',
          label: 'Seed',
          value: $('seed').value,
          placeholder: 'ngẫu nhiên',
          title: $('seed').closest('label')?.title,
          onInput: (v) => {
            $('seed').value = v;
            $('seed').dispatchEvent(new Event('input', { bubbles: true }));
          },
          onEnter: () => closePopup(true),
        },
      },
      { label: 'Tải lại danh sách org', onSelect: click('btn-orgs') },
      HISTORY_ITEM(),
    );
  } else items.push({ group: 'Chạy' }, HISTORY_ITEM()); // the menu exists ≤ 900 px (design 0011 §4)
  if (noViewTools()) {
    // The Quy trình | Sơ đồ switch lives in the hidden "Thu gọn / Mở tất cả" row (design 0003).
    items.push({ group: 'Chế độ xem' }, ...VIEWS.map((v) => ({ label: v.label, checked: state.view === v.value, onSelect: () => setView(v.value) })));
    items.push(
      { group: 'Khung' },
      { label: 'Thu gọn tất cả', onSelect: click('btn-collapse-all') },
      { label: 'Mở tất cả', onSelect: click('btn-expand-all') },
    );
  }
  items.push({ group: 'Mẫu' }, ...SAMPLES.map((s) => ({ label: s.label, desc: s.description, onSelect: () => loadSample(s) })));
  if (phone()) {
    const select = $('theme-select');
    items.push({ group: 'Giao diện' }, ...THEMES.map(([value, label]) => ({
      label,
      checked: select.value === value,
      onSelect: () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    })));
  }
  btn.setAttribute('aria-expanded', 'true');
  openPopup(anchor, { title: 'Mẫu và thao tác khác', items, focus: fromChip ? 'seed' : null, onClose: () => btn.setAttribute('aria-expanded', 'false') });
}

async function openWorkflowObject(wf, raw, fileName) {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return toast('Không mở được file: không phải file workflow.', 5000);
  if (wf.version === 1) {
    if (!Array.isArray(wf.nodes)) return toast('Không mở được file: không phải file workflow (thiếu "nodes").', 5000);
    let migrated;
    try {
      migrated = migrateV1(wf, migrateOptions());
    } catch (e) {
      return toast(`Không chuyển được file version 1: ${e.message}`, 6000);
    }
    if (!(await openAsNew(migrated.workflow))) return undefined;
    announceMigration(migrated.report, raw, { name: migrated.workflow.name ?? fileName, autosave: false });
    return undefined;
  }
  if (wf.version !== 2) {
    return toast(
      wf.version === undefined
        ? 'Không mở được file: không phải file workflow (thiếu "version").'
        : `Không mở được file: workflow version ${wf.version} chưa được hỗ trợ. Hãy cập nhật ứng dụng.`,
      6000,
    );
  }
  const bad = malformedSteps(wf);
  if (bad) return toast(`Không mở được file: ${bad}. Sửa file JSON rồi mở lại.`, 6000);
  if (!(await openAsNew(wf))) return undefined;
  toast(`Đã mở "${wf.name ?? fileName}".`);
  return undefined;
}

function saveFile() {
  download(`${fileBase(state.workflow.name)}.json`, JSON.stringify(state.workflow, null, 2));
}

function updateInsertButton() {
  const btn = $('btn-insert');
  // No history ⇒ no insert (design 0011, review S7): the server would refuse it (503) anyway.
  const st = historyStatus();
  const off = Boolean(st && !st.enabled);
  btn.disabled = !state.org || Boolean(running) || off;
  btn.title = !state.org ? 'Chọn org trước' : off ? historyOffText(st) : `Sinh dữ liệu và insert vào ${state.org}`;
}

let toldHistoryOff = false;
/**
 * With an org selected: asks the server whether it can keep the insert history (Insert is locked
 * when it cannot; a disabled button's tooltip is easy to miss, so the sentence is also a toast, once).
 */
async function checkHistory() {
  if (!state.org) return;
  const st = await refreshHistory();
  updateInsertButton();
  if (st && !st.enabled && state.org && !toldHistoryOff) {
    toldHistoryOff = true;
    toast(historyOffText(st), 15000);
  }
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
      // Ctrl+O: the library popup from anywhere — an input, an open popup (toggles) — never the
      // browser's file dialog. Not while a dialog is open (the popup would be behind it).
      e.preventDefault();
      if (document.querySelector('dialog[open]')) return;
      if (popupAnchor() === $('btn-library')) closePopup(true);
      else openLibraryMenu();
      return;
    }
    if (e.defaultPrevented || document.querySelector('dialog[open]') || e.target.closest('.popup')) return;
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const sel = ops.selectedId();
    if (e.key === 'F8' && !mod && !e.altKey) {
      // Works in the inspector's inputs too (not a typing key).
      e.preventDefault();
      goToNextIssue(e.shiftKey ? -1 : 1);
    } else if (mod && e.key === 'Enter') {
      // Ctrl+Shift+Enter: read the org again for Query steps (bypass the server's cache).
      e.preventDefault();
      run(false, { refresh: e.shiftKey });
    } else if (mod && key === 's') {
      e.preventDefault();
      saveFile();
    } else if (typing) {
      // Inputs keep their native keys; Esc in the inspector goes back to the selected card.
      if (e.key === 'Escape' && e.target.closest('#inspector')) {
        e.preventDefault();
        e.target.blur();
        focusSelected();
      }
    } else if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && key === 'd') {
      // One-step keys act on the whole selection (design 0012 B).
      e.preventDefault();
      if (sel) ops.duplicateSelection();
    } else if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      if (sel) ops.toggleSelectionDisabled();
    } else if (mod && key === 'a' && e.target.closest('#process, #canvas')) {
      // Ctrl+A in the tree: every step of the primary step's sequence.
      e.preventDefault();
      selectAllInSequence();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (sel) ops.moveSelectionBy(e.key === 'ArrowUp' ? -1 : 1);
    } else if (!mod && !e.altKey && e.key === '/') {
      e.preventDefault();
      openAddMenuAtDefault();
    } else if (!mod && !e.altKey && key === 'm') {
      // Quy trình ↔ Sơ đồ (design 0003): same selection, no undo step.
      e.preventDefault();
      toggleView();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!sel) return;
      e.preventDefault();
      ops.deleteSelection();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const card = sel && document.querySelector(`.step-card[data-id="${CSS.escape(sel)}"] .menu-btn`);
      if (card) {
        e.preventDefault();
        openStepMenu(card, sel);
      }
    } else if (e.key === 'Escape') {
      // Two steps: several selected ⇒ keep the primary one; then ⇒ nothing selected.
      if (inSelectMode()) exitSelectMode();
      else if (isMulti()) collapseToPrimary();
      else select(null);
    }
  });
}

/**
 * Copy / cut / paste of steps (design 0012 B) through the document's clipboard events, so they
 * work without clipboard permissions and outside a secure context (HOST on a LAN address). Inputs
 * keep their own copy / paste; text the user selected on the page is copied as text.
 */
function wireClipboard() {
  const typing = () => document.activeElement?.closest?.('input, textarea, select, [contenteditable]');
  const blocked = () => document.querySelector('dialog[open]') || typing();
  const onCopy = (cut) => (e) => {
    if (blocked() || !selectedIds().length || document.getSelection()?.toString()) return;
    const clip = ops.selectionClipboard();
    if (!clip) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', clip.text);
    if (cut) ops.removeCut();
    else toast(`Đã sao chép ${clip.count} bước.`);
  };
  document.addEventListener('copy', onCopy(false));
  document.addEventListener('cut', onCopy(true));
  document.addEventListener('paste', (e) => {
    if (blocked()) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // Text that is not steps is only answered when focus is in the tree (a paste meant for it).
    const inTree = Boolean(document.activeElement?.closest?.('#process, #canvas'));
    e.preventDefault();
    ops.pasteText(text, { quiet: !inTree });
  });
}

// ---------- validation ----------

let validateTimer;
function wireValidation() {
  subscribe(({ kind }) => {
    if (kind !== 'workflow') return;
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateNow, 400);
  });
  validateNow();
}

// Each request (and each run result, which carries its own issues) takes a number; a response
// that is not the latest is dropped, so a slow /api/validate of an older workflow can never
// overwrite newer issues.
let validateSeq = 0;
// Warnings only a run can know (Query "sample rows, no org", …): kept while the workflow is the
// one that ran, so the next background validation of that same workflow does not erase them.
let runWarnings = null; // { key, warnings }

function withRunWarnings(issues, key) {
  if (runWarnings?.key !== key) return issues;
  const seen = new Set((issues.warnings ?? []).map((w) => `${w.nodeId}|${w.message}`));
  return { ...issues, warnings: [...(issues.warnings ?? []), ...runWarnings.warnings.filter((w) => !seen.has(`${w.nodeId}|${w.message}`))] };
}

async function validateNow() {
  const seq = ++validateSeq;
  const key = JSON.stringify(state.workflow);
  try {
    const issues = await api.validate(state.workflow);
    if (seq === validateSeq) setIssues(withRunWarnings(issues, key));
  } catch {
    // Server unreachable; the next run will surface the error.
  }
}

/** Select the step an issue belongs to (opening collapsed frames around it and the field's card). */
function goToIssue(i) {
  const step = i.nodeId ? stepById(i.nodeId) : null;
  if (!step) return select({ kind: 'workflow' });
  ops.expandAncestors(i.nodeId);
  saveCollapsed();
  const index = i.field?.startsWith('fields.') ? (step.config?.fields ?? []).findIndex((f) => `fields.${f?.name}` === i.field) : -1;
  if (index >= 0) openField(i.nodeId, index);
  else select({ kind: 'step', id: i.nodeId });
  openSheet(); // narrow screens: a run closed the sheet; show the step's configuration again
  emit('app', 'view');
  ops.reveal(i.nodeId);
  return undefined;
}

function setIssues(issues) {
  state.issues = { errors: issues.errors ?? [], warnings: issues.warnings ?? [] };
  const all = [...state.issues.errors.map((i) => ({ ...i, level: 'error' })), ...state.issues.warnings.map((i) => ({ ...i, level: 'warning' }))];
  renderIssues(all.map((i) => {
    const step = i.nodeId ? stepById(i.nodeId) : null;
    const alias = step ? stepAlias(step) : '';
    return { ...i, nodeId: step ? i.nodeId : undefined, prefix: alias ? `[${alias}] ` : '' };
  }));
  emit('validation', 'issues');
}

// ---------- run ----------

/** The run in progress: { insert, runId, controller, stopping, … } (design 0004). */
let running = null;
/** The workflow has a Query step that is not turned off (design 0006). */
const hasQueries = () => allSteps(state.workflow, slotKeys).some((s) => s.type === 'query' && !s.disabled);
const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const BATCH = 200;

function readSeed() {
  const raw = $('seed').value.trim();
  return raw === '' ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** The last preview when an insert would repeat it: same workflow, org and (if typed) seed. */
function matchingPreview(seed) {
  const r = state.result;
  // A result that was inserted is not a preview to insert again: the next Insert previews afresh.
  if (!r || r.cancelled || r.insert || !state.resultRun) return null;
  if (seed !== undefined && String(seed) !== String(r.seed)) return null;
  return state.lastRunKey === runKey(state.workflow, r.seed) && state.lastRunOrg === state.org ? r : null;
}

function setRunning(r) {
  running = r;
  setLibraryLocked(Boolean(r)); // no switching workflows while a run is on (design 0012 A)
  $('btn-preview').disabled = Boolean(r);
  if (r) $('btn-insert').disabled = true;
  else updateInsertButton();
}

/** Dừng: before the server named the run, drop the request (nothing was written yet). */
async function stopRun() {
  const r = running;
  if (!r || r.stopping) return;
  r.stopping = true;
  r.render?.();
  if (!r.runId) {
    // Still waiting for the response (Query steps being read): dropping the request stops it
    // before anything runs. Once the response arrived the run has started on the server, so
    // cancel it by id as soon as `start` names it (dropping the stream could miss a batch).
    if (!r.responded) r.controller.abort();
    else r.cancelOnStart = true;
    return;
  }
  try {
    await api.cancelRun(r.runId);
  } catch {
    // 404: the run just ended; its last event says what happened.
  }
}

/**
 * Dừng ngay (design 0011 §3): a stop is waiting for the Bulk job being processed; abort it.
 * Salesforce keeps what it processed; the server tries to read those Ids into history.
 */
async function forceStop() {
  const r = running;
  if (!r?.runId || r.forcing) return;
  r.forcing = true;
  r.render?.();
  try {
    await api.cancelRun(r.runId, { force: true });
  } catch (e) {
    if (e.status === 404) return; // the run just ended; its last event says what happened
    // 403 on a server bound to every address (the message says why) and the like: still waiting.
    r.forcing = false;
    r.render?.();
    toast(e.message, 10000);
  }
}

const FORCE_TITLE = 'Hủy job Bulk đang chạy. Bản ghi Salesforce đã xử lý vẫn ở lại trong org; app cố lấy Id của chúng để ghi vào Lịch sử.';

/** Summary text and Dừng / Dừng ngay while a stop is under way (insert and delete). → { parts, stop } | null */
function stoppingView(r) {
  if (r.forcing) return { parts: ['Đang hủy job Bulk…'], stop: { stopping: true, stopLabel: 'Dừng ngay', stopTitle: FORCE_TITLE } };
  if (r.stopping && r.waitingBulk) {
    const w = r.waitingBulk;
    return {
      parts: [`Đang chờ job Bulk ${w.sobject} đang chạy xong (${fmt(w.processed)}/${fmt(w.records)}) rồi dừng…`],
      stop: { stopping: false, onStop: forceStop, stopLabel: 'Dừng ngay', stopTitle: FORCE_TITLE },
    };
  }
  if (r.stopping) return { parts: ['Đang dừng sau lô hiện tại…'], stop: { stopping: true } };
  return null;
}

/** `start` event: the run has an id; a Dừng pressed before it is sent now. */
function started(r, ev) {
  r.runId = ev.runId;
  if (r.cancelOnStart && r.runId) api.cancelRun(r.runId).catch(() => {});
}

const leaveGuard = (e) => {
  e.preventDefault();
  e.returnValue = '';
};

/**
 * Preview (insert false) or insert. A preview's Query steps read `state.org` (sample rows without
 * one). Insert always shows how many records it will create: without a matching preview it
 * previews first, then inserts with that preview's seed and `now` (same data), sending the
 * preview's Query fingerprints so the server refuses (409) if the org data changed.
 */
async function run(insert, { refresh = false } = {}) {
  if (running || deleteInFlight()) {
    toast('Đang chạy. Bấm "Dừng" nếu muốn chạy lại.');
    return;
  }
  // Narrow screens: the results panel opens behind the sheet, so close it (selection kept).
  if (window.matchMedia('(max-width: 900px)').matches) closeSheet();
  const seed = readSeed();
  if (!insert) {
    await preview({ seed, refresh });
    return;
  }
  let base = matchingPreview(seed);
  if (!base) {
    if (!(await preview({ seed, auto: true }))) return;
    base = state.result;
  }
  const org = state.orgs.find((o) => (o.alias ?? o.username) === state.org);
  const choice = await confirmInsert(org, base);
  if (!choice) return;
  await insertRun(base, choice);
}

/** Streams a preview into the results panel. → true when it finished (not stopped, no error). */
async function preview({ seed, refresh = false, auto = false }) {
  const r = { insert: false, controller: new AbortController(), generated: 0, bySobject: {} };
  const label = auto ? 'Đang sinh dữ liệu để xác nhận trước khi insert…' : refresh ? 'Đang đọc lại org và sinh dữ liệu…' : 'Đang sinh dữ liệu…';
  r.render = () => showProgress({
    parts: r.stopping ? ['Đang dừng…'] : [r.generated || !hasQueries() ? `${label} ${fmt(r.generated)} bản ghi ` : 'Đang đọc Query…', ...sobjectChips(r.bySobject)],
    onStop: stopRun,
    stopping: r.stopping,
  });
  setRunning(r);
  r.render();
  const workflow = structuredClone(state.workflow);
  try {
    const result = await api.runStream({ workflow, seed, org: state.org || undefined, refreshQueries: refresh || undefined }, {
      signal: r.controller.signal,
      onResponse: () => { r.responded = true; },
      onEvent: (ev) => {
        if (ev.type === 'start') started(r, ev);
        if (ev.type === 'progress') {
          r.generated = ev.generated;
          r.bySobject = ev.bySobject;
          r.render();
          liveCards({ phase: 'generate', byStep: ev.byStep ?? {} });
        }
      },
    });
    liveCards(null);
    acceptResult(result, workflow);
    if (result.cancelled) toast('Đã dừng xem trước.');
    return !result.cancelled;
  } catch (e) {
    if (e.name === 'AbortError') {
      showRunning('Đã dừng. Chưa ghi bản ghi nào vào org.');
      return false;
    }
    runFailed(e);
    return false;
  } finally {
    liveCards(null);
    setRunning(null);
    endProgress();
  }
}

/**
 * Live counts on the cards (design 0012 D): `info` = state.runLive (see run-cards.js), null once
 * the run ended. Only the chips and tags are patched.
 */
function liveCards(info) {
  if (!info && !state.runLive) return;
  state.runLive = info;
  paintRunInfo();
}

/** Shows a finished run and remembers what produced it (downloads regenerate from this snapshot). */
function acceptResult(result, workflow) {
  state.result = result;
  state.deleteResult = null; // a new run replaces the last delete's summary and tab
  state.resultRun = {
    workflow,
    seed: result.seed,
    now: result.now,
    org: state.org,
    runId: result.runId,
    expectQueries: result.queries?.length ? Object.fromEntries(result.queries.map((q) => [q.nodeId, { fingerprint: q.fingerprint, count: q.count, fetchedAt: q.fetchedAt }])) : undefined,
  };
  state.lastRunKey = runKey(workflow, result.seed);
  state.lastRunSteps = JSON.stringify(workflow.steps);
  state.lastRunOrg = state.org;
  validateSeq++; // a validation still in flight is older than this result
  runWarnings = { key: JSON.stringify(workflow), warnings: result.warnings ?? [] };
  setIssues({ errors: [], warnings: result.warnings });
  // Edited while it ran: the dropped validation was of the newer workflow, so check that again.
  if (JSON.stringify(workflow) !== JSON.stringify(state.workflow)) validateNow();
  emit('run', 'result');
}

function runFailed(e) {
  if (e.issues) {
    validateSeq++;
    setIssues({ errors: e.issues, warnings: state.issues.warnings });
    expandIssues(); // the only time the bar expands by itself (design 0009, Đã chốt 2)
    const first = e.issues.find((i) => i.nodeId && stepById(i.nodeId));
    if (first) goToIssue(first);
  }
  const msg = e.lost ? 'Mất kết nối với server. Chạy lại khi server hoạt động.' : e.message;
  showRunning(`Lỗi: ${msg}`);
  toast(msg, e.status === 409 ? 8000 : 5000);
}

const bySobjectText = (counts) => Object.entries(counts ?? {}).filter(([, v]) => (v?.inserted ?? v) > 0).map(([s, v]) => `${s} ${fmt(v?.inserted ?? v)}`).join(', ');

/** Inserts with the seed and `now` of `base` (the confirmed preview): progress, Dừng, summary. */
async function insertRun(base, { bulk = 'auto' } = {}) {
  const total = base.stats.total;
  const org = state.org;
  const r = { insert: true, controller: new AbortController(), phase: 'generate', generated: 0, inserted: 0, failed: 0, bySobject: {}, insertStart: 0, bulk: null, historyId: null };
  r.render = () => {
    let parts;
    let value;
    const stopping = stoppingView(r);
    if (stopping) {
      showProgress({ parts: stopping.parts, value: r.inserted + r.failed, max: total || 1, ...stopping.stop });
      return;
    }
    if (r.phase === 'generate') {
      parts = [`Đang kiểm tra dữ liệu trước khi ghi… ${fmt(r.generated)}/${fmt(total)}`];
      value = r.generated;
    } else {
      const done = r.inserted + r.failed;
      const pct = total ? Math.floor((done / total) * 100) : 100;
      let eta = '';
      // Remaining time from the insert pace, once 3 calls went through.
      if (done >= 3 * BATCH && done < total) {
        const perRecord = (Date.now() - r.insertStart) / done;
        const min = ((total - done) * perRecord) / 60000;
        eta = min < 1 ? ' · còn dưới 1 phút' : ` · còn khoảng ${Math.round(min)} phút`;
      }
      // Design 0011 §2: the Bulk job in flight, after the errors.
      const job = r.bulk ? ` · Bulk: ${r.bulk.sobject} job ${r.bulk.job ?? '?'}/${r.bulk.jobs ?? '?'}` : '';
      parts = [`Đang insert vào ${org}: ${fmt(done)}/${fmt(total)} (${pct} %)${r.failed ? ` · lỗi ${fmt(r.failed)}` : ''}${job}${eta} `, ...sobjectChips(r.bySobject, base.stats.bySobject)];
      value = done;
    }
    showProgress({ parts, value, max: total || 1, onStop: stopRun });
  };
  setRunning(r);
  r.render();
  window.addEventListener('beforeunload', leaveGuard);
  const workflow = structuredClone(state.workflow);
  const preview = state.resultRun;
  try {
    const result = await api.runStream({
      workflow, seed: base.seed, now: base.now, target: { kind: 'org', org, bulk }, expectQueries: preview?.expectQueries,
    }, {
      signal: r.controller.signal,
      onResponse: () => { r.responded = true; },
      onEvent: (ev) => {
        if (ev.type === 'start') started(r, ev);
        else if (ev.type === 'plan') {
          r.phase = 'insert';
          r.insertStart = Date.now();
          r.historyId = ev.historyId ?? null;
          // A full history drops an older insert that still has records in an org (review S4).
          const pruned = (ev.warnings ?? []).filter((w) => w.code === 'historyPruned');
          // The server writes the time as ISO: shown as local `HH:mm dd/MM` (N4).
          if (pruned.length) toast(pruned.map((w) => w.message.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => whenText(iso))).join(' '), 15000);
          liveCards({ phase: 'insert', base, insertByStep: {} });
        } else if (ev.type === 'progress' && ev.phase === 'generate') {
          r.generated = ev.generated;
          liveCards({ phase: 'generate', byStep: ev.byStep ?? {} });
        } else if (ev.type === 'progress' && ev.phase === 'insert') {
          r.phase = 'insert';
          Object.assign(r, { inserted: ev.inserted, failed: ev.failed, bySobject: ev.bySobject, bulk: ev.bulk ?? null });
          liveCards({ phase: 'insert', base, insertByStep: ev.byStep ?? {} });
        } else if (ev.type === 'progress' && ev.phase === 'stopping') {
          r.waitingBulk = ev.waitingBulk ?? null;
        }
        if (ev.type !== 'start') r.render();
      },
    });
    liveCards(null);
    acceptResult(result, workflow);
    const ins = result.insert;
    // A later Insert with the same seed would create the same data again: the confirmation says so.
    if (ins.inserted) state.lastInserts = [...state.lastInserts, { key: runKey(workflow, result.seed), org }].slice(-20);
    const msg = insertEndMessage(ins, { org, total });
    if (ins.stopped || ins.cancelled) showRunning(msg.text, insertLinks(ins));
    // Design 0011 §3: every ending with records in the org offers to delete them (≥ 10 s).
    const offer = deleteOffer(ins.historyId, ins.inserted);
    toast(msg.text, offer ? Math.max(10000, msg.long ? 12000 : 0) : msg.long ? 12000 : 6000, offer);
    historyChanged();
    const s = ins.stopped;
    if ((s?.reason === 'allFailing' || s?.reason === 'bulkFailing') && s.nodeId && stepById(s.nodeId)) {
      goToIssue({ nodeId: s.nodeId, field: ins.errorGroups?.find((g) => g.nodeId === s.nodeId)?.field });
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // Dừng before the server started the run: nothing was sent.
      showRunning('Đã dừng. Chưa ghi bản ghi nào vào org.');
      toast('Đã dừng. Chưa ghi bản ghi nào vào org.', 6000);
    } else if (e.lost && r.phase === 'insert') {
      const msg = `Mất kết nối với server khi đang insert. Đã insert ít nhất ${fmt(r.inserted)} bản ghi (theo tiến độ cuối). Kiểm tra org trước khi chạy lại để tránh trùng.${r.historyId ? ' Xem Lịch sử để biết chính xác đã insert bao nhiêu khi server chạy xong.' : ''}`;
      showRunning(msg);
      toast(msg, 12000, deleteOffer(r.historyId, r.inserted));
    } else {
      if (e.insert?.inserted) e.message += ` Đã insert ${fmt(e.insert.inserted)} bản ghi trước khi lỗi; ${STILL_THERE}`;
      // 503: history cannot be written (S7): Insert locks with the server's reason.
      if (e.status === 503) refreshHistory().then(updateInsertButton);
      runFailed(e);
      const offer = deleteOffer(e.insert?.historyId ?? r.historyId, e.insert?.inserted);
      if (offer) toast(e.message, 12000, offer);
    }
    if (r.historyId) historyChanged();
  } finally {
    liveCards(null);
    window.removeEventListener('beforeunload', leaveGuard);
    setRunning(null);
    endProgress();
  }
}

/** The toast button "Xóa dữ liệu này…" of an insert that left records in the org, or null. */
const deleteOffer = (hid, inserted) => (hid && inserted > 0 ? { label: 'Xóa dữ liệu này…', onClick: () => confirmDelete(hid) } : null);

/**
 * Deletes the records of history entry `hid` (design 0011 §6), in the results panel like an insert:
 * progress, Dừng (Dừng ngay while a Bulk job is processed), summary, toast, "Lỗi xóa" tab. Called by
 * the delete confirmation (history.js): a refusal before the stream starts is thrown back to it.
 */
async function deleteRun({ hid, body, org, total, bySobject, onResponse, signal }) {
  if (running) throw new Error('Đang chạy. Bấm "Dừng" hoặc chờ lần chạy xong rồi mới xóa.');
  // Children first: the chips follow the delete order (reverse insert order).
  const order = Object.keys(bySobject ?? {}).reverse();
  const r = { delete: true, controller: new AbortController(), deleted: 0, gone: 0, failed: 0, total, bySobject: {}, start: Date.now(), bulk: null };
  r.render = () => {
    if (r.stopping && r.bulk && r.bulk.state !== 'Open' && r.bulk.jobId) r.waitingBulk = r.bulk; // a stop waits for the Bulk job
    const stopping = stoppingView(r);
    const done = r.deleted + r.gone + r.failed;
    if (stopping) {
      showProgress({ parts: stopping.parts, value: done, max: total || 1, ...stopping.stop });
      return;
    }
    const pct = total ? Math.floor((done / total) * 100) : 100;
    let eta = '';
    if (done >= 3 * BATCH && done < total) {
      const min = ((total - done) * ((Date.now() - r.start) / done)) / 60000;
      eta = min < 1 ? ' · còn dưới 1 phút' : ` · còn khoảng ${Math.round(min)} phút`;
    }
    const job = r.bulk ? ` · Bulk: ${r.bulk.sobject}` : '';
    const chips = order.map((so) => {
      const c = r.bySobject[so] ?? {};
      return h('span', { class: 'chip' }, `${so} ${fmt((c.deleted ?? 0) + (c.gone ?? 0))}/${fmt(c.total ?? bySobject[so])}`);
    });
    showProgress({ parts: [`Đang xóa khỏi ${org}: ${fmt(r.deleted + r.gone)}/${fmt(total)} (${pct} %) · lỗi ${fmt(r.failed)}${job}${eta} `, ...chips], value: done, max: total || 1, onStop: stopRun });
  };
  let streaming = false;
  // Hủy / Esc in the confirmation while the server still checks the org: the request is dropped
  // before any header, and the server deletes nothing (final review S1).
  signal?.addEventListener('abort', () => { if (!streaming) r.controller.abort(); }, { once: true });
  try {
    const result = await api.deleteStream(hid, body, {
      signal: r.controller.signal,
      onResponse: () => {
        streaming = true;
        r.responded = true;
        onResponse?.();
        if (window.matchMedia('(max-width: 900px)').matches) closeSheet();
        setRunning(r);
        r.render();
        window.addEventListener('beforeunload', leaveGuard);
      },
      onEvent: (ev) => {
        if (ev.type === 'start') started(r, ev);
        else if (ev.type === 'progress') {
          Object.assign(r, { deleted: ev.deleted, gone: ev.gone, failed: ev.failed, bySobject: ev.bySobject ?? {}, bulk: ev.bulk ?? null });
          r.render();
        }
      },
    });
    state.deleteResult = { result, org, hid };
    emit('run', 'result');
    const msg = deleteEndMessage(result, { org, total });
    if (result.stopped || result.cancelled || result.failed || msg.extra) showRunning(msg.text);
    toast(msg.text, msg.long ? 15000 : 8000);
    if (result.failed && !result.stopped && !result.cancelled) showDeleteErrors();
  } catch (e) {
    if (!streaming) throw e; // refused before anything was deleted: the confirmation says it
    const text = e.lost
      ? `Mất kết nối với server khi đang xóa. Đã xóa ít nhất ${fmt(r.deleted)} bản ghi (theo tiến độ cuối). Xem Lịch sử để biết chính xác đã xóa bao nhiêu khi server chạy xong.`
      : `Lỗi khi xóa: ${e.message} Đã xóa ${fmt(r.deleted)} bản ghi trước đó; phần còn lại xóa được bằng "Xóa phần còn lại…" trong Lịch sử.`;
    showRunning(text);
    toast(text, 12000);
  } finally {
    if (streaming) {
      window.removeEventListener('beforeunload', leaveGuard);
      setRunning(null);
      endProgress();
      historyChanged();
    }
  }
}

/** The sentence after a delete (design 0011 §6, §7). → { text, long, extra } */
function deleteEndMessage(res, { org }) {
  const extra = [];
  if (res.collected) extra.push(`Đã lấy thêm ${fmt(res.collected)} Id từ job Bulk chưa lấy kết quả.`);
  for (const sk of res.skipped ?? []) extra.push(sk.reason ?? `Không xóa ${fmt(sk.count)} bản ghi ${sk.sobject} của bước "${sk.nodeId}".`);
  for (const j of bulkJobsOf(res)) {
    extra.push(j.idsLost
      ? j.message
      : `Job Bulk ${j.jobId} (${j.sobject}) chưa trả Id${j.state ? ` (${j.state})` : ''}; bản ghi của job này chưa bị xóa. Bấm "Xóa phần còn lại…" trong Lịch sử khi job xong.`);
  }
  // The server's own sentences (rows of the Id file no step owns: `rejected`) come first.
  for (const w of res.warnings ?? []) extra.push(w);
  if (res.bulkAborted) {
    const b = res.bulkAborted;
    extra.push(`Đã hủy job Bulk xóa ${b.sobject}: Salesforce đã xử lý ${fmt(b.processed)}/${fmt(b.records)} Id của job${b.idsKnown ? '' : '; xem kết quả của job trong Setup → Bulk Data Load Jobs'}.`);
  }
  const s = res.stopped;
  const removed = res.deleted + res.gone;
  let text;
  if (s) text = s.text ?? `Đã dừng xóa: ${s.message ?? s.reason}. Đã xóa ${fmt(res.deleted)} bản ghi; phần còn lại xóa được bằng "Xóa phần còn lại…" trong Lịch sử.`;
  else if (res.cancelled) text = `Đã dừng. Đã xóa ${fmt(removed)}/${fmt(res.total)} bản ghi khỏi ${org}; ${fmt(res.remaining)} bản ghi còn lại xóa được bằng "Xóa phần còn lại…" trong Lịch sử.`;
  else if (res.failed) text = `Đã xóa ${fmt(res.deleted)} bản ghi; ${fmt(res.failed)} bản ghi không xóa được. Xem nhóm lỗi trong tab "Lỗi xóa" hoặc trong Lịch sử, sửa rồi bấm "Xóa phần còn lại…".`;
  else text = `Đã xóa ${fmt(res.deleted)} bản ghi khỏi ${org} (vào Thùng rác).${res.gone ? ` ${fmt(res.gone)} bản ghi đã không còn trong org.` : ''}`;
  if (extra.length) text += ` ${extra.join(' ')}`;
  return { text, long: Boolean(s || res.cancelled || res.failed || extra.length), extra: extra.length > 0 };
}

/** Tail of every stop with records in the org (design 0011 §3). */
const STILL_THERE = 'các bản ghi này vẫn còn trong org; xóa được bằng nút "Xóa dữ liệu này…" hoặc trong Lịch sử.';

/** The sentence after an insert (toast, and the summary when it stopped). → { text, long } */
function insertEndMessage(ins, { org, total }) {
  const where = bySobjectText(ins.bySobject);
  const s = ins.stopped;
  const stepName = (id) => {
    const step = id ? stepById(id) : null;
    return step ? stepAlias(step) || id : id ?? '';
  };
  const written = ins.inserted ? ` Đã insert ${where}; ${STILL_THERE}` : ' Chưa ghi bản ghi nào vào org.';
  const extra = [];
  if (ins.bulkAborted) {
    const b = ins.bulkAborted;
    extra.push(b.idsKnown
      ? `Đã hủy job Bulk ${b.sobject}. Salesforce đã xử lý ${fmt(b.processed)}/${fmt(b.records)} bản ghi của job; Id của chúng đã ghi vào Lịch sử.`
      : `Đã hủy job Bulk ${b.sobject}. Salesforce đã xử lý ${fmt(b.processed)}/${fmt(b.records)} bản ghi của job nhưng chưa trả Id của chúng; khi xóa dữ liệu của lần insert này, app lấy lại Id từ job ${b.jobId} trước. Xem job trong Setup → Bulk Data Load Jobs.`);
  }
  if (ins.bulkUnknown) extra.push(`${fmt(ins.bulkUnknown)} bản ghi của job Bulk chưa biết kết quả (có thể đã vào org); Lịch sử giữ mã job để lấy lại Id khi xóa.`);
  const tail = extra.length ? ` ${extra.join(' ')}` : '';
  let text;
  if (s?.reason === 'allFailing') text = `Đã dừng insert: ${s.batches} lô ${s.sobject} đầu tiên (${fmt(s.records)} bản ghi) đều lỗi "${s.message}". Sửa bước "${stepName(s.nodeId)}" rồi chạy lại.${written}`;
  else if (s?.reason === 'bulkFailing') text = `Đã dừng insert: ${s.jobs} job Bulk ${s.sobject} liên tiếp (${fmt(s.records)} bản ghi) đều lỗi "${s.message}". Sửa bước "${stepName(s.nodeId)}" rồi chạy lại, hoặc bỏ chọn "Dùng Bulk API 2.0" trong hộp xác nhận.${written}`;
  else if (s?.reason === 'history') text = `Không ghi được Id vào Lịch sử (${s.message}) nên đã dừng insert, để không có bản ghi nào trong org mà app không biết Id. Đã insert ${fmt(ins.inserted)} bản ghi; Id của chúng đã được ghi.`;
  else if (s?.reason === 'bulkTimeout') text = `${s.message} App đã ngừng theo dõi và dừng lần chạy. Job có thể vẫn đang chạy trong org: xem Setup → Bulk Data Load Jobs. Lịch sử ghi lại mã job này.${written}`;
  else if (s?.reason === 'orgChanged') text = `${s.message}${written}`;
  else if (s?.reason === 'bulkError') text = `Đã dừng insert: ${s.message}${/[.!?]$/.test(s.message ?? '') ? '' : '.'} Xem job ${s.jobId ?? ''} trong Setup → Bulk Data Load Jobs.${written}`;
  else if (s) text = `Đã dừng insert: ${s.message ?? s.reason}.${written}`;
  else if (ins.cancelled) {
    text = ins.inserted
      ? `Đã dừng. Đã insert ${fmt(ins.inserted)}/${fmt(total)} bản ghi vào ${org} (${where}); ${STILL_THERE}`
      : 'Đã dừng. Chưa ghi bản ghi nào vào org.';
  } else text = ins.failed ? `Insert ${fmt(ins.inserted)}, lỗi ${fmt(ins.failed)}. Xem tab "Lỗi insert".` : `Đã insert ${fmt(ins.inserted)} bản ghi vào ${org}.`;
  return { text: text + tail, long: Boolean(s || ins.cancelled || tail) };
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '?');
const whenText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : `${hhmm(iso)} ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
};

const BULK_HELP = 'Nhanh hơn và ít lời gọi API hơn. Chỉ áp cho bước không có Lookup nào trỏ tới, vì Bulk trả Id không theo thứ tự. Bỏ chọn nếu org có trigger hay gặp lỗi khóa bản ghi (UNABLE_TO_LOCK_ROW).';
const MAX_BULK_LINES = 5;

/** planInsert (shared with the server's `plan` event) for the preview `previewed` of `workflow`. */
function insertPlan(previewed, workflow, bulk) {
  const byStep = previewed.stats.byStep ?? {};
  const steps = allSteps(workflow, slotKeys)
    .filter((s) => s.type === 'record' && byStep[s.id]?.records > 0)
    .map((s) => ({ nodeId: s.id, alias: stepAlias(s), sobject: s.config?.sobject, records: byStep[s.id].records }));
  return planInsert({ steps, referenced: poolUsage(workflow, state.meta).referenced, bulk, limits: state.meta?.limits });
}

/**
 * Always shows the record count of `previewed` (the preview the insert repeats, same seed + now),
 * the Bulk choice (design 0011 §1), the API calls and the org's remaining API limit, and whether
 * the insert is written to history. → { bulk } or false.
 */
async function confirmInsert(org, previewed) {
  const modal = $('modal');
  const stats = previewed.stats;
  const read = (previewed.queries ?? []).filter((q) => q.source !== 'sample');
  const counts = Object.entries(stats.bySobject).map(([s, n]) => `${s} ${fmt(n)}`).join(', ');
  const workflow = state.resultRun?.workflow ?? state.workflow;
  const minBulk = state.meta?.limits?.bulkMinRecords ?? 10000;
  const bulkSteps = insertPlan(previewed, workflow, 'auto').steps.filter((s) => s.mode === 'bulk');
  let bulk = 'auto';
  let limits = null;
  const callsLine = h('p', { class: 'hint insert-calls' });
  const limitsLine = h('div', { class: 'insert-limits' });
  const bulkList = bulkSteps.length
    ? h('ul', { class: 'bulk-steps' },
      bulkSteps.slice(0, MAX_BULK_LINES).map((s) => h('li', {}, `${s.alias} (${s.sobject}) ${fmt(s.records)}: ${fmt(s.probe)} bản ghi đầu gửi thử bằng sObject Collections, phần còn lại ${fmt(s.jobs)} job Bulk.`)),
      bulkSteps.length > MAX_BULK_LINES ? h('li', {}, `… và ${bulkSteps.length - MAX_BULK_LINES} bước khác`) : null)
    : null;
  const update = () => {
    const c = insertPlan(previewed, workflow, bulk).apiCalls;
    callsLine.textContent = c.bulk
      ? `Khoảng ${fmt(c.total)} lời gọi API (sObject Collections ${fmt(c.collections)}, Bulk khoảng ${fmt(c.bulk)}), tính vào giới hạn API 24 giờ của org.`
      : `Khoảng ${fmt(c.total)} lời gọi API (${BATCH} bản ghi mỗi lời gọi), tính vào giới hạn API 24 giờ của org.`;
    bulkList?.classList.toggle('off', bulk === 'off');
    const api24 = limits?.api;
    if (!api24 || !stats.total) {
      limitsLine.replaceChildren();
      return;
    }
    limitsLine.replaceChildren(c.total > api24.remaining
      ? h('div', { class: 'warn-box limits-warn' }, `Ước tính cần khoảng ${fmt(c.total)} lời gọi API nhưng org chỉ còn ${fmt(api24.remaining)} trong 24 giờ. Insert có thể dừng giữa chừng với lỗi REQUEST_LIMIT_EXCEEDED. ${bulkSteps.length && bulk === 'off' ? 'Bật Bulk API 2.0, giảm' : 'Giảm'} số bản ghi hoặc chờ hạn mức hồi lại.`)
      : h('p', { class: 'hint' }, `Org còn ${fmt(api24.remaining)}/${fmt(api24.max)} lời gọi API trong 24 giờ.`));
  };
  update();
  const orgName = state.org;
  // The org's remaining API calls: ≤ 3 s, never blocks the dialog (a failure leaves the line out).
  if (stats.total) {
    api.limits(orgName).then((l) => {
      limits = l;
      if (limitsLine.isConnected) update();
    });
  }
  // History (design 0011 §5) and what a full history would drop (review S4) are filled in when
  // GET /api/history answers (N8: the dialog opens at once); Insert waits for that answer.
  const historyBox = h('div', { class: 'insert-history' }, stats.total ? h('p', { class: 'hint' }, 'Đang kiểm tra Lịch sử…') : null);
  return new Promise((resolve) => {
    const done = (v) => { modal.onclose = null; modal.close(); resolve(v); };
    const isProd = org && !org.isSandbox && !org.isScratch;
    const insertBtn = h('button', {
      class: 'danger solid',
      disabled: true,
      onclick: () => done({ bulk }),
    }, `Insert ${fmt(stats.total)} bản ghi`);
    refreshHistory().then((st) => {
      updateInsertButton();
      if (!historyBox.isConnected) return; // the dialog was closed or replaced meanwhile
      const off = Boolean(st && !st.enabled);
      insertBtn.disabled = !stats.total || off;
      insertBtn.title = off ? historyOffText(st) : '';
      historyBox.replaceChildren(...[
        off
          ? h('div', { class: 'warn-box history-off' }, historyOffText(st))
          : stats.total ? h('p', { class: 'hint history-line' }, 'Lần insert được ghi vào Lịch sử trên máy này (danh sách Id) để tải Id hoặc xóa lại sau.') : null,
        ...(st?.enabled ? st.prune ?? [] : []).map((e) => h('div', { class: 'warn-box history-prune' }, `Lịch sử đã đầy nên lần insert này sẽ bỏ ghi chép của lần insert lúc ${whenText(e.startedAt)} vào org "${e.org?.alias ?? e.org?.username ?? '?'}"${e.workflowName ? ` (workflow "${e.workflowName}")` : ''}, còn ${fmt(e.remaining)} bản ghi trong org: sau đó không tải Id hay xóa dữ liệu của lần đó qua app được nữa. Muốn giữ, Hủy rồi xóa dữ liệu của lần đó trong Lịch sử trước.`)),
      ].filter(Boolean));
    });
    // replaceChildren would print "null" for the parts that do not apply.
    modal.replaceChildren(...[
      h('h2', {}, 'Insert vào org?'),
      h('p', {}, 'Org: ', h('b', {}, state.org), org?.username ? ` (${org.username})` : ''),
      isProd ? h('div', { class: 'warn-box' }, 'Org này không phải sandbox hay scratch org. Kiểm tra kỹ trước khi insert dữ liệu test.') : null,
      h('p', { class: 'insert-count' }, stats.total ? `Sẽ tạo ${fmt(stats.total)} bản ghi: ${counts}.` : 'Workflow không sinh bản ghi nào: không có gì để insert.'),
      h('p', {}, `Giống hệt bản xem trước (seed ${previewed.seed}).`),
      state.lastInserts.some((x) => x.org === state.org && x.key === runKey(state.workflow, previewed.seed))
        ? h('div', { class: 'warn-box same-seed' }, `Seed ${previewed.seed} đã dùng cho lần insert trước vào org này với cùng workflow: cùng seed thì ra cùng dữ liệu (tên, email…), nên các bản ghi này có thể bị trùng với lần trước. Muốn dữ liệu mới, xóa ô Seed rồi bấm Insert lại.`)
        : null,
      read.length
        ? h('p', {}, `Đọc từ org, không ghi: ${read.map((q) => `${q.sobject} ${q.count} (${q.alias}, đọc lúc ${hhmm(q.fetchedAt)})`).join(', ')}.`)
        : null,
      // Within the 10-minute cache the insert reuses the previewed rows as they were; only a re-read
      // (cache expired, server restarted) can notice that the org changed.
      read.length ? h('p', { class: 'hint query-reuse' }, 'Insert dùng lại đúng các dòng đã đọc lúc xem trước. Nếu đã quá 10 phút (hoặc server vừa khởi động lại), app đọc lại org và dừng trước khi ghi nếu dữ liệu đã đổi. Muốn insert theo dữ liệu mới nhất, bấm Đọc lại rồi Insert.') : null,
      // Design 0011 §1: only when a step qualifies; on by default, not remembered.
      bulkSteps.length && stats.total
        ? h('label', { class: 'check-line bulk-check', title: BULK_HELP },
          h('input', { type: 'checkbox', checked: true, 'aria-describedby': 'bulk-help', onchange: (e) => { bulk = e.target.checked ? 'auto' : 'off'; update(); } }),
          `Dùng Bulk API 2.0 cho bước từ ${fmt(minBulk)} bản ghi`)
        : null,
      bulkSteps.length && stats.total ? h('p', { class: 'hint', id: 'bulk-help' }, BULK_HELP) : null,
      stats.total ? bulkList : null,
      stats.total ? callsLine : null,
      stats.total ? limitsLine : null,
      historyBox,
      stats.total ? h('p', { class: 'hint' }, 'Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã insert không tự xóa nhưng xóa được trong Lịch sử.') : null,
      h('div', { class: 'actions' },
        h('button', { onclick: () => done(false) }, 'Hủy'),
        insertBtn),
    ].filter(Boolean));
    modal.onclose = () => resolve(false);
    modal.showModal();
    modal.querySelector('.actions button')?.focus(); // Hủy: an org write is never one Enter away
  });
}

// ---------- orgs ----------

async function loadOrgs(manual = false) {
  const sel = $('org-select');
  const previous = state.org || (() => { try { return localStorage.getItem(ORG_KEY) ?? ''; } catch { return ''; } })();
  try {
    state.orgs = await api.orgs();
    sel.replaceChildren(
      h('option', { value: '' }, '— không kết nối —'),
      ...state.orgs.map((o) => {
        const value = o.alias ?? o.username;
        const tag = o.isScratch ? ' [scratch]' : o.isSandbox ? ' [sandbox]' : '';
        return h('option', { value, selected: value === previous }, `${o.alias ? `${o.alias} — ` : ''}${o.username}${tag}`);
      }),
    );
    state.org = state.orgs.some((o) => (o.alias ?? o.username) === previous) ? previous : '';
    sel.title = '';
    if (manual) toast(`Tìm thấy ${state.orgs.length} org từ sf CLI.`);
  } catch (e) {
    state.orgs = [];
    state.org = '';
    sel.title = e.message;
    if (manual) toast(e.message, 5000);
  }
  updateInsertButton();
  checkHistory();
  emit('orgs', 'all');
}

boot();
