// App bootstrap: loads metadata, wires toolbar, shortcuts, live validation and runs.

import { api } from './api.js';
import { h, toast, download } from './dom.js';
import {
  state, emit, subscribe, updateWorkflow, replaceWorkflow, emptyWorkflow, loadPersisted, undo, redo, select, nodeById, runKey, NODE_COLORS,
} from './store.js';
import { initCanvas, addNode, deleteSelection, duplicateSelection, fit } from './canvas.js';
import { initInspector } from './inspector.js';
import { initResults, showRunning } from './results.js';
import { SAMPLES } from './samples.js';

const $ = (id) => document.getElementById(id);
const ORG_KEY = 'sfdg.org';

async function boot() {
  try {
    state.meta = await api.meta();
  } catch (e) {
    document.body.replaceChildren(h('p', { style: { padding: '20px' } }, `Không kết nối được server: ${e.message}`));
    return;
  }
  const saved = loadPersisted();
  state.workflow = saved?.version === 1 ? saved : structuredClone(SAMPLES[0].workflow);

  renderPalette();
  initCanvas();
  initInspector();
  initResults();
  wireToolbar();
  wireShortcuts();
  wireValidation();
  loadOrgs();
}

function renderPalette() {
  $('palette-items').replaceChildren(
    ...state.meta.nodeTypes
      .filter((t) => t.type !== 'start')
      .map((t) =>
        h(
          'button',
          {
            class: 'palette-item',
            draggable: 'true',
            style: { '--c': NODE_COLORS[t.type] },
            title: t.description,
            onclick: () => addNode(t.type),
            ondragstart: (e) => e.dataTransfer.setData('text/x-node-type', t.type),
          },
          t.label,
          h('small', {}, t.description.split('.')[0]),
        ),
      ),
  );
  $('sample-items').replaceChildren(
    ...SAMPLES.map((s) =>
      h('button', {
        class: 'palette-item',
        title: s.description,
        onclick: () => {
          if (!confirmDiscard()) return;
          replaceWorkflow(structuredClone(s.workflow));
          requestAnimationFrame(fit);
        },
      }, s.label, h('small', {}, s.description)),
    ),
  );
}

function confirmDiscard() {
  return state.workflow.nodes.length <= 1 || confirm('Thay workflow hiện tại? (Vẫn có thể hoàn tác bằng Ctrl+Z)');
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
    requestAnimationFrame(fit);
  };
  $('btn-save').onclick = saveFile;
  $('btn-open').onclick = () => $('file-input').click();
  $('file-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const wf = JSON.parse(await file.text());
      if (wf.version !== 1 || !Array.isArray(wf.nodes)) throw new Error('Không phải file workflow (version 1).');
      wf.nodes.forEach((n, i) => { n.position ??= { x: 60 + i * 260, y: 160 }; n.config ??= {}; });
      replaceWorkflow(wf);
      requestAnimationFrame(fit);
      toast(`Đã mở "${wf.name ?? file.name}".`);
    } catch (err) {
      toast(`Không mở được file: ${err.message}`, 5000);
    }
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

function saveFile() {
  download(`${(state.workflow.name || 'workflow').replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(state.workflow, null, 2));
}

function updateInsertButton() {
  const btn = $('btn-insert');
  btn.disabled = !state.org;
  btn.title = state.org ? `Sinh dữ liệu và insert vào ${state.org}` : 'Chọn org trước';
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      run(false);
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveFile();
    } else if (typing) {
      // Let inputs keep their native undo/delete behaviour.
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
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

function setIssues(issues) {
  state.issues = { errors: issues.errors ?? [], warnings: issues.warnings ?? [] };
  const box = $('issues');
  const all = [...state.issues.errors.map((i) => ({ ...i, level: 'error' })), ...state.issues.warnings.map((i) => ({ ...i, level: 'warning' }))];
  box.hidden = !all.length;
  box.replaceChildren(
    ...all.map((i) =>
      h('button', {
        class: `issue ${i.level}`,
        title: i.nodeId ? 'Bấm để chọn node' : '',
        onclick: () => i.nodeId && nodeById(i.nodeId) && select({ kind: 'node', id: i.nodeId }),
      }, `${i.nodeId && nodeById(i.nodeId)?.config?.alias ? `[${nodeById(i.nodeId).config.alias}] ` : ''}${i.message}`),
    ),
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
    setIssues({ errors: [], warnings: result.warnings });
    emit('run', 'result');
    if (insert) toast(result.insert.failed ? `Insert ${result.insert.inserted}, lỗi ${result.insert.failed}. Xem tab "Lỗi insert".` : `Đã insert ${result.insert.inserted} bản ghi.`, 5000);
  } catch (e) {
    if (e.issues) {
      setIssues({ errors: e.issues, warnings: state.issues.warnings });
      const first = e.issues.find((i) => i.nodeId);
      if (first) select({ kind: 'node', id: first.nodeId });
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
      h('div', { class: 'actions' }, h('button', { onclick: () => done(false) }, 'Hủy'), h('button', { class: 'danger', onclick: () => done(true) }, 'Insert')),
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
