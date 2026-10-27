// App bootstrap: loads metadata, migrates old workflows, wires toolbar, shortcuts, live
// validation and runs.

import { api } from './api.js';
import { h, toast, download, icoTile } from './dom.js';
import {
  state, emit, subscribe, updateWorkflow, replaceWorkflow, emptyWorkflow, loadPersisted, loadLegacy, persist,
  undo, redo, select, stepById, runKey, saveCollapsed, backupBrokenAutosave,
} from './store.js';
import { migrateV1, describeReport, reportIsEmpty } from '/shared/migrate-v1.js';
import { malformedSteps } from '/shared/workflow-tree.js';
import { initProcess, focusSelected, openAddMenuAtDefault, openStepMenu, paletteDragStart, paletteDragEnd } from './process.js';
import * as ops from './ops.js';
import { initInspector } from './inspector.js';
import { initResults, showRunning } from './results.js';
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
  initProcess();
  initInspector();
  initResults();
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
    ...SAMPLES.map((s) =>
      h('button', {
        class: 'palette-item',
        title: s.description,
        onclick: () => {
          if (!confirmDiscard()) return;
          replaceWorkflow(structuredClone(s.workflow));
        },
      }, s.label, h('small', {}, s.description)),
    ),
  );
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
  btn.disabled = !state.org;
  btn.title = state.org ? `Sinh dữ liệu và insert vào ${state.org}` : 'Chọn org trước';
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || document.querySelector('dialog[open]') || e.target.closest('.popup')) return;
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const sel = ops.selectedId();
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      run(false);
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

async function validateNow() {
  try {
    setIssues(await api.validate(state.workflow));
  } catch {
    // Server unreachable; the next run will surface the error.
  }
}

/** Select the step an issue belongs to, opening collapsed frames around it. */
function goToIssue(i) {
  if (!i.nodeId || !stepById(i.nodeId)) return select({ kind: 'workflow' });
  ops.expandAncestors(i.nodeId);
  saveCollapsed();
  select({ kind: 'step', id: i.nodeId });
  emit('app', 'view');
  ops.reveal(i.nodeId);
  return undefined;
}

function setIssues(issues) {
  state.issues = { errors: issues.errors ?? [], warnings: issues.warnings ?? [] };
  const box = $('issues');
  const all = [...state.issues.errors.map((i) => ({ ...i, level: 'error' })), ...state.issues.warnings.map((i) => ({ ...i, level: 'warning' }))];
  box.hidden = !all.length;
  box.classList.toggle('only-warnings', !state.issues.errors.length);
  box.replaceChildren(
    ...all.map((i) => {
      const step = i.nodeId ? stepById(i.nodeId) : null;
      const alias = step ? stepAlias(step) : '';
      return h('button', {
        class: `issue ${i.level}`,
        title: step ? 'Bấm để chọn bước' : '',
        onclick: () => goToIssue(i),
      }, `${alias ? `[${alias}] ` : ''}${i.message}`);
    }),
  );
  emit('validation', 'issues');
}

// ---------- run ----------

let running = false;
async function run(insert) {
  if (running) return;
  const seedRaw = $('seed').value.trim();
  const seed = seedRaw === '' ? undefined : /^\d+$/.test(seedRaw) ? Number(seedRaw) : seedRaw;

  if (insert) {
    const org = state.orgs.find((o) => (o.alias ?? o.username) === state.org);
    const same = state.result && seed !== undefined && state.lastRunKey === runKey(state.workflow, seed);
    const ok = await confirmInsert(org, same ? state.result.stats : null, seed);
    if (!ok) return;
  }

  running = true;
  $('btn-preview').disabled = $('btn-insert').disabled = true;
  showRunning(insert ? `Đang sinh và insert vào ${state.org}…` : 'Đang sinh dữ liệu…');
  try {
    const result = await api.run(state.workflow, { seed, target: insert ? { kind: 'org', org: state.org } : undefined });
    state.result = result;
    state.lastRunKey = runKey(state.workflow, result.seed);
    state.lastRunSteps = JSON.stringify(state.workflow.steps);
    setIssues({ errors: [], warnings: result.warnings });
    emit('run', 'result');
    if (insert) toast(result.insert.failed ? `Insert ${result.insert.inserted}, lỗi ${result.insert.failed}. Xem tab "Lỗi insert".` : `Đã insert ${result.insert.inserted} bản ghi.`, 5000);
  } catch (e) {
    if (e.issues) {
      setIssues({ errors: e.issues, warnings: state.issues.warnings });
      const first = e.issues.find((i) => i.nodeId && stepById(i.nodeId));
      if (first) goToIssue(first);
    }
    showRunning(`Lỗi: ${e.message}`);
    toast(e.message, 5000);
  } finally {
    running = false;
    $('btn-preview').disabled = false;
    updateInsertButton();
  }
}

function confirmInsert(org, stats, seed) {
  const modal = $('modal');
  return new Promise((resolve) => {
    const done = (v) => { modal.close(); resolve(v); };
    const isProd = org && !org.isSandbox && !org.isScratch;
    modal.replaceChildren(
      h('h2', {}, 'Insert vào org?'),
      h('p', {}, 'Org: ', h('b', {}, state.org), org?.username ? ` (${org.username})` : ''),
      isProd ? h('div', { class: 'warn-box' }, 'Org này không phải sandbox hay scratch org. Kiểm tra kỹ trước khi insert dữ liệu test.') : null,
      stats
        ? h('p', {}, `Giống lần xem trước (seed ${seed}): `, Object.entries(stats.bySobject).map(([s, n]) => `${s} ${n}`).join(', '), '.')
        : h('p', { class: 'hint' }, 'Chưa có bản xem trước với seed cố định cho workflow này, nên dữ liệu insert sẽ khác dữ liệu đã xem. Nhập seed và Xem trước để biết chính xác.'),
      h('div', { class: 'actions' }, h('button', { onclick: () => done(false) }, 'Hủy'), h('button', { class: 'danger solid', onclick: () => done(true) }, 'Insert')),
    );
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
