// App bootstrap: loads metadata, migrates old workflows, wires toolbar (and its "⋯" menu on
// narrow screens, design 0009), shortcuts, live validation (issues bar: issues.js) and runs.

import { api } from './api.js';
import { h, toast, download, icoTile } from './dom.js';
import {
  state, emit, subscribe, updateWorkflow, replaceWorkflow, emptyWorkflow, loadPersisted, loadLegacy, persist,
  undo, redo, select, stepById, runKey, saveCollapsed, backupBrokenAutosave, slotKeys,
} from './store.js';
import { migrateV1, describeReport, reportIsEmpty } from '/shared/migrate-v1.js';
import { malformedSteps, allSteps } from '/shared/workflow-tree.js';
import { initViews, focusSelected, openAddMenuAtDefault, paletteDragStart, paletteDragEnd, toggleView, setView, VIEWS } from './views.js';
import { openStepMenu } from './menus.js';
import * as ops from './ops.js';
import { initInspector, openField, openSheet, closeSheet } from './inspector.js';
import { initResults, showRunning, showProgress, endProgress, sobjectChips } from './results.js';
import { initIssues, renderIssues, expandIssues, goToNextIssue } from './issues.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';
import { SAMPLES } from './samples.js';
import { stepAlias } from './summary.js';

const $ = (id) => document.getElementById(id);
const ORG_KEY = 'sfdg.org';

async function boot() {
  try {
    state.meta = await api.meta();
  } catch (e) {
    document.body.replaceChildren(h('p', { style: { padding: '20px' } }, `Không kết nối được server: ${e.message}`));
    return;
  }
  const afterBoot = loadInitialWorkflow();
  saveCollapsed();

  renderPalette();
  initViews();
  initInspector();
  initResults({ onRefresh: () => run(false, { refresh: true }), onGoTo: goToIssue });
  initIssues({ onGoTo: goToIssue });
  firstRender();
  wireToolbar();
  wireShortcuts();
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
    const key = backupBrokenAutosave(json);
    state.workflow = structuredClone(SAMPLES[0].workflow); // not persisted: the autosave stays as it was
    state.selection = null;
    emit('app', 'all');
    toast(
      `Không hiển thị được workflow lưu tự động (${e.message}). Đang mở mẫu "${SAMPLES[0].label}"; bản lưu cũ chưa bị ghi đè${key ? ` và có bản sao trong trình duyệt (${key})` : ''}. Bấm "Tải bản lưu" để lấy file JSON, sửa rồi Mở lại.`,
      15000,
      { label: 'Tải bản lưu', onClick: () => download('workflow-autosave.json', json) },
    );
  }
}

/** v2 autosave → old v1 autosave (migrated, original kept) → first sample. */
function loadInitialWorkflow() {
  const saved = loadPersisted();
  if (saved?.version === 2 && Array.isArray(saved.steps)) {
    state.workflow = saved;
    return null;
  }
  const legacy = loadLegacy();
  if (legacy?.workflow?.version === 1 && Array.isArray(legacy.workflow.nodes)) {
    try {
      const { workflow, report } = migrateV1(legacy.workflow, migrateOptions());
      state.workflow = workflow;
      persist(); // writes sfdg.workflow.v2 only; sfdg.workflow.v1 stays as it was
      return () => announceMigration(report, legacy.raw, { name: workflow.name, autosave: true });
    } catch (e) {
      console.error(e);
      toast(`Không chuyển được workflow cũ trong trình duyệt (${e.message}). Bản cũ vẫn được giữ nguyên.`, 6000);
    }
  }
  state.workflow = structuredClone(SAMPLES[0].workflow);
  return null;
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

/** Mẫu (palette, or the "⋯" menu on narrow screens): asks before replacing a non-empty workflow. */
function loadSample(s) {
  if (!confirmDiscard()) return;
  replaceWorkflow(structuredClone(s.workflow));
}

function confirmDiscard() {
  return !state.workflow.steps?.length || confirm('Thay workflow hiện tại? (Vẫn có thể hoàn tác bằng Ctrl+Z)');
}

function wireToolbar() {
  const name = $('wf-name');
  name.value = state.workflow.name ?? '';
  name.oninput = () => updateWorkflow((wf) => { wf.name = name.value; }, { source: 'toolbar', coalesceKey: 'name' });
  subscribe(({ source }) => {
    if (source !== 'toolbar') name.value = state.workflow.name ?? '';
  });

  $('btn-new').onclick = () => {
    if (!confirmDiscard()) return;
    replaceWorkflow(emptyWorkflow());
  };
  $('btn-save').onclick = saveFile;
  $('btn-open').onclick = () => $('file-input').click();
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
    openWorkflowObject(wf, raw, file.name);
  };
  $('btn-undo').onclick = () => undo() || toast('Không còn gì để hoàn tác.');
  $('btn-redo').onclick = () => redo() || toast('Không còn gì để làm lại.');
  $('btn-preview').onclick = () => run(false);
  $('btn-insert').onclick = () => run(true);
  $('btn-orgs').onclick = () => loadOrgs(true);
  $('org-select').onchange = (e) => {
    state.org = e.target.value;
    try { localStorage.setItem(ORG_KEY, state.org); } catch { /* optional */ }
    updateInsertButton();
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
      { label: 'Mới', onSelect: click('btn-new') },
      { label: 'Mở…', onSelect: click('btn-open') },
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
    );
  }
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

function openWorkflowObject(wf, raw, fileName) {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return toast('Không mở được file: không phải file workflow.', 5000);
  if (wf.version === 1) {
    if (!Array.isArray(wf.nodes)) return toast('Không mở được file: không phải file workflow (thiếu "nodes").', 5000);
    let migrated;
    try {
      migrated = migrateV1(wf, migrateOptions());
    } catch (e) {
      return toast(`Không chuyển được file version 1: ${e.message}`, 6000);
    }
    replaceWorkflow(migrated.workflow);
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
  replaceWorkflow(wf);
  toast(`Đã mở "${wf.name ?? fileName}".`);
  return undefined;
}

function saveFile() {
  download(`${fileBase(state.workflow.name)}.json`, JSON.stringify(state.workflow, null, 2));
}

function updateInsertButton() {
  const btn = $('btn-insert');
  btn.disabled = !state.org || Boolean(running);
  btn.title = state.org ? `Sinh dữ liệu và insert vào ${state.org}` : 'Chọn org trước';
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
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
      e.preventDefault();
      if (sel) ops.duplicateStep(sel);
    } else if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      if (sel) ops.toggleDisabled(sel);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (sel) ops.moveBy(sel, e.key === 'ArrowUp' ? -1 : 1);
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
      ops.deleteStep(sel);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const card = sel && document.querySelector(`.step-card[data-id="${CSS.escape(sel)}"] .menu-btn`);
      if (card) {
        e.preventDefault();
        openStepMenu(card, sel);
      }
    } else if (e.key === 'Escape') {
      select(null);
    }
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
  if (running) {
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
  if (!(await confirmInsert(org, base))) return;
  await insertRun(base);
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
        }
      },
    });
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
    setRunning(null);
    endProgress();
  }
}

/** Shows a finished run and remembers what produced it (downloads regenerate from this snapshot). */
function acceptResult(result, workflow) {
  state.result = result;
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
async function insertRun(base) {
  const total = base.stats.total;
  const org = state.org;
  const r = { insert: true, controller: new AbortController(), phase: 'generate', generated: 0, inserted: 0, failed: 0, bySobject: {}, insertStart: 0 };
  r.render = () => {
    let parts;
    let value;
    if (r.stopping) parts = ['Đang dừng sau lô hiện tại…'];
    else if (r.phase === 'generate') {
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
      parts = [`Đang insert vào ${org}: ${fmt(done)}/${fmt(total)} (${pct} %)${r.failed ? ` · lỗi ${fmt(r.failed)}` : ''}${eta} `, ...sobjectChips(r.bySobject, base.stats.bySobject)];
      value = done;
    }
    showProgress({ parts, value, max: total || 1, onStop: stopRun, stopping: r.stopping });
  };
  setRunning(r);
  r.render();
  window.addEventListener('beforeunload', leaveGuard);
  const workflow = structuredClone(state.workflow);
  const preview = state.resultRun;
  try {
    const result = await api.runStream({
      workflow, seed: base.seed, now: base.now, target: { kind: 'org', org }, expectQueries: preview?.expectQueries,
    }, {
      signal: r.controller.signal,
      onResponse: () => { r.responded = true; },
      onEvent: (ev) => {
        if (ev.type === 'start') started(r, ev);
        else if (ev.type === 'plan') {
          r.phase = 'insert';
          r.insertStart = Date.now();
        } else if (ev.type === 'progress' && ev.phase === 'generate') r.generated = ev.generated;
        else if (ev.type === 'progress' && ev.phase === 'insert') {
          r.phase = 'insert';
          Object.assign(r, { inserted: ev.inserted, failed: ev.failed, bySobject: ev.bySobject });
        }
        if (ev.type !== 'start') r.render();
      },
    });
    acceptResult(result, workflow);
    const ins = result.insert;
    // A later Insert with the same seed would create the same data again: the confirmation says so.
    if (ins.inserted) state.lastInsert = { key: runKey(workflow, result.seed), org };
    const where = bySobjectText(ins.bySobject);
    if (ins.stopped?.reason === 'allFailing') {
      const s = ins.stopped;
      const step = s.nodeId ? stepById(s.nodeId) : null;
      const msg = `Đã dừng insert: ${s.batches} lô ${s.sobject} đầu tiên (${fmt(s.records)} bản ghi) đều lỗi "${s.message}". Sửa bước "${step ? stepAlias(step) || s.nodeId : s.nodeId}" rồi chạy lại.${ins.inserted ? ` Đã insert ${where}, các bản ghi này vẫn còn trong org.` : ' Chưa ghi bản ghi nào vào org.'}`;
      showRunning(msg);
      toast(msg, 12000);
      if (step) goToIssue({ nodeId: s.nodeId, field: ins.errorGroups?.find((g) => g.nodeId === s.nodeId)?.field });
    } else if (ins.cancelled) {
      const msg = ins.inserted
        ? `Đã dừng. Đã insert ${fmt(ins.inserted)}/${fmt(total)} bản ghi vào ${org} (${where}). Các bản ghi này vẫn còn trong org.`
        : 'Đã dừng. Chưa ghi bản ghi nào vào org.';
      showRunning(msg);
      toast(msg, 10000);
    } else {
      toast(ins.failed ? `Insert ${fmt(ins.inserted)}, lỗi ${fmt(ins.failed)}. Xem tab "Lỗi insert".` : `Đã insert ${fmt(ins.inserted)} bản ghi vào ${org}.`, 6000);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // Dừng before the server started the run: nothing was sent.
      showRunning('Đã dừng. Chưa ghi bản ghi nào vào org.');
      toast('Đã dừng. Chưa ghi bản ghi nào vào org.', 6000);
    } else if (e.lost && r.phase === 'insert') {
      const msg = `Mất kết nối với server khi đang insert. Đã insert ít nhất ${fmt(r.inserted)} bản ghi (theo tiến độ cuối). Kiểm tra org trước khi chạy lại để tránh trùng.`;
      showRunning(msg);
      toast(msg, 12000);
    } else {
      if (e.insert?.inserted) e.message += ` Đã insert ${fmt(e.insert.inserted)} bản ghi trước khi lỗi; các bản ghi này vẫn còn trong org.`;
      runFailed(e);
    }
  } finally {
    window.removeEventListener('beforeunload', leaveGuard);
    setRunning(null);
    endProgress();
  }
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '?');

/** Always shows the record count of `previewed` (the preview the insert repeats, same seed + now). */
function confirmInsert(org, previewed) {
  const modal = $('modal');
  const stats = previewed.stats;
  const read = (previewed.queries ?? []).filter((q) => q.source !== 'sample');
  const calls = Object.values(stats.bySobject).reduce((n, c) => n + Math.ceil(c / BATCH), 0);
  const counts = Object.entries(stats.bySobject).map(([s, n]) => `${s} ${fmt(n)}`).join(', ');
  return new Promise((resolve) => {
    const done = (v) => { modal.close(); resolve(v); };
    const isProd = org && !org.isSandbox && !org.isScratch;
    // replaceChildren would print "null" for the parts that do not apply.
    modal.replaceChildren(...[
      h('h2', {}, 'Insert vào org?'),
      h('p', {}, 'Org: ', h('b', {}, state.org), org?.username ? ` (${org.username})` : ''),
      isProd ? h('div', { class: 'warn-box' }, 'Org này không phải sandbox hay scratch org. Kiểm tra kỹ trước khi insert dữ liệu test.') : null,
      h('p', { class: 'insert-count' }, stats.total ? `Sẽ tạo ${fmt(stats.total)} bản ghi: ${counts}.` : 'Workflow không sinh bản ghi nào: không có gì để insert.'),
      h('p', {}, `Giống hệt bản xem trước (seed ${previewed.seed}).`),
      state.lastInsert && state.lastInsert.org === state.org && state.lastInsert.key === runKey(state.workflow, previewed.seed)
        ? h('div', { class: 'warn-box same-seed' }, `Seed ${previewed.seed} đã dùng cho lần insert trước vào org này với cùng workflow: cùng seed thì ra cùng dữ liệu (tên, email…), nên các bản ghi này có thể bị trùng với lần trước. Muốn dữ liệu mới, xóa ô Seed rồi bấm Insert lại.`)
        : null,
      read.length
        ? h('p', {}, `Đọc từ org, không ghi: ${read.map((q) => `${q.sobject} ${q.count} (${q.alias}, đọc lúc ${hhmm(q.fetchedAt)})`).join(', ')}.`)
        : null,
      // Within the 10-minute cache the insert reuses the previewed rows as they were; only a re-read
      // (cache expired, server restarted) can notice that the org changed.
      read.length ? h('p', { class: 'hint query-reuse' }, 'Insert dùng lại đúng các dòng đã đọc lúc xem trước. Nếu đã quá 10 phút (hoặc server vừa khởi động lại), app đọc lại org và dừng trước khi ghi nếu dữ liệu đã đổi. Muốn insert theo dữ liệu mới nhất, bấm ⟳ Đọc lại rồi Insert.') : null,
      stats.total ? h('p', { class: 'hint' }, `Khoảng ${fmt(calls)} lời gọi API (${BATCH} bản ghi mỗi lời gọi), tính vào giới hạn API 24 giờ của org.`) : null,
      stats.total ? h('p', { class: 'hint' }, 'Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã insert không tự xóa.') : null,
      h('div', { class: 'actions' },
        h('button', { onclick: () => done(false) }, 'Hủy'),
        h('button', { class: 'danger solid', disabled: !stats.total, onclick: () => done(true) }, `Insert ${fmt(stats.total)} bản ghi`)),
    ].filter(Boolean));
    modal.onclose = () => resolve(false);
    modal.showModal();
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
  emit('orgs', 'all');
}

boot();
