// Bottom panel: run summary, per-sObject tables, read-only tabs of the rows each Query step read
// (design 0006: `queries[]` of /api/run, never inserted), insert results, downloads.
//
// Streaming (design 0004): a run sends back only the first `limits.previewRows` records of each
// sObject; the totals come from `stats`. Downloads ask the server to regenerate the run
// (/api/export, same seed + now as the snapshot taken when the run finished), so the file matches
// the table even after the workflow was edited. While a run goes on, the download buttons give
// their place to "Dừng" and a thin <progress> sits on the bottom edge of the header (0009 §4).
// Insert failures are grouped (sObject, step, message); a group selects its step and field.
// The header is one row at every width (0009 §4): on phones the summary scrolls sideways and the
// two download buttons become one "⤓ Tải" menu that calls them.

import { h, ico, download, toast, watchOverflow, revealInRow } from './dom.js';
import { state, subscribe, stepById } from './store.js';
import { stepAlias } from './summary.js';
import { api } from './api.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';
import { groupTarget } from './history-text.js';
import { reveal } from './ops.js';
import { resultsRange, clampResults, resultsFromRatio, resultsRatio, resultsKey, shouldCollapse, resultsAria, RESULTS } from './sizing.js';

const QUERY_TAB = 'q:'; // activeTab of a Query tab: `q:<stepId>`
const ERRORS_TAB = '__errors';
const DELETE_ERRORS_TAB = '__deleteErrors';
const STOP_TITLE = 'Dừng sau lô đang gửi. Bản ghi đã insert vẫn ở lại trong org.';
let activeTab = null;
let panel, body, summary, progressBar, stopBtn, dlJson, dlCsv, dlMenu, toggle, historyBtn;
let onRefresh = null;
let onGoTo = null;
let onHistory = null; // (hid?) → opens the history dialog (design 0011)
let onIds = null; // (hid) → downloads the Ids of a run
let busyDownload = false;
let unwatchTabs = null; // the tab row is rebuilt on each render (design 0014 §4)

/** Thousands with a space, as in the design docs: 200 000. */
export const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const previewRows = () => state.meta?.limits?.previewRows ?? 200;

/**
 * opts.onRefresh: "⟳ Đọc lại" (preview again, reading the org instead of the query cache).
 * opts.onGoTo(issue): select the step (and field) of an insert error group.
 */
export function initResults({ onRefresh: refresh, onGoTo: goTo, onHistory: history, onIds: ids } = {}) {
  onRefresh = refresh ?? null;
  onGoTo = goTo ?? null;
  onHistory = history ?? null;
  onIds = ids ?? null;
  historyBtn = document.getElementById('btn-history');
  historyBtn.onclick = () => onHistory?.();
  panel = document.getElementById('results');
  body = document.getElementById('results-body');
  summary = document.getElementById('results-summary');
  watchOverflow(summary); // one line that scrolls sideways on phones
  progressBar = document.getElementById('run-progress');
  stopBtn = document.getElementById('btn-stop');
  dlJson = document.getElementById('btn-dl-json');
  dlCsv = document.getElementById('btn-dl-csv');
  dlMenu = document.getElementById('btn-dl-menu');
  toggle = document.getElementById('btn-results-toggle');
  toggle.onclick = () => setOpen(panel.classList.contains('collapsed'));
  dlMenu.onclick = () => (popupAnchor() === dlMenu ? closePopup() : openDownloadMenu());
  dlJson.onclick = () => exportFile('json');
  dlCsv.onclick = () => {
    const q = activeQuery();
    // A Query tab: its rows are already here (≤ 2 000, read from the org, never regenerated).
    if (q) download(`${fileBase()}-${q.alias}.csv`, toCsv(queryRecords(q)), 'text/csv');
    else if (activeTab && activeTab !== ERRORS_TAB) exportFile('csv', activeTab);
  };
  subscribe(({ kind }) => kind === 'result' && render());
  initResize();
}

// ---------- panel height (design 0014 §2) ----------

const HEIGHT_KEY = 'sfdg.resultsH';
let handle = null;
let storedRatio = null; // share of the space under the top bar, as stored (string) or null: 38 %
let dragging = null; // { startY, startH, want, frame, selVisible }

const readRatio = () => { try { return localStorage.getItem(HEIGHT_KEY); } catch { return null; } };
function writeRatio(v) {
  storedRatio = v;
  try {
    if (v === null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, v);
  } catch { /* private mode: remembered until reload */ }
}
/** Height under the top bar: the space the panel and the main area share. */
const space = () => window.innerHeight - (document.querySelector('.topbar')?.offsetHeight ?? 0);

function initResize() {
  handle = document.getElementById('results-resize');
  storedRatio = readRatio();
  handle.addEventListener('pointerdown', onResizeDown);
  handle.addEventListener('keydown', onResizeKey);
  handle.addEventListener('dblclick', () => {
    writeRatio(null);
    layoutResults();
    keepSelected(selectedFullyVisible());
  });
  window.addEventListener('resize', () => layoutResults());
  layoutResults();
}

/**
 * Applies the remembered height to the open panel (clamped for this window) and shows the handle
 * only when it is open and there are at least 24 px to change (main.js calls this when the top bar
 * changes height). While dragging, `override` is the height under the pointer.
 */
export function layoutResults(override = null) {
  if (!handle) return;
  const total = space();
  const range = resultsRange(total);
  const open = !panel.classList.contains('collapsed');
  handle.hidden = !open || !range.usable;
  if (!range.usable) {
    panel.style.removeProperty('--results-h'); // landscape phone: the 38vh of before
    return;
  }
  const height = override ?? resultsFromRatio(storedRatio, total, window.innerHeight);
  panel.style.setProperty('--results-h', `${height}px`);
  const aria = resultsAria(height, total);
  handle.setAttribute('aria-valuemin', String(aria.min));
  handle.setAttribute('aria-valuemax', String(aria.max));
  handle.setAttribute('aria-valuenow', String(aria.now));
  handle.setAttribute('aria-valuetext', aria.text);
}

/** The selected card of Quy trình is fully in view (Sơ đồ keeps it with its own ResizeObserver). */
function selectedFullyVisible() {
  const view = document.getElementById('process');
  const card = view && !view.hidden ? view.querySelector('.step-card.selected') : null;
  if (!card) return false;
  const v = view.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  return c.top >= v.top - 0.5 && c.bottom <= v.bottom + 0.5;
}
function keepSelected(was) {
  const sel = state.selection;
  if (was && sel?.kind === 'step') requestAnimationFrame(() => reveal(sel.id, { block: 'nearest', focus: false }));
}

function onResizeDown(e) {
  if (e.button !== 0 || handle.hidden) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  dragging = { startY: e.clientY, startH: panel.getBoundingClientRect().height, want: null, frame: 0, selVisible: selectedFullyVisible() };
  document.body.classList.add('resizing');
  handle.classList.add('dragging');
  handle.addEventListener('pointermove', onResizeMove);
  handle.addEventListener('pointerup', onResizeUp);
  handle.addEventListener('pointercancel', onResizeUp);
}

function onResizeMove(e) {
  if (!dragging) return;
  dragging.want = dragging.startH + (dragging.startY - e.clientY);
  if (!dragging.frame) {
    dragging.frame = requestAnimationFrame(() => {
      dragging.frame = 0;
      if (dragging.want !== null) layoutResults(clampResults(dragging.want, space()));
    });
  }
}

function onResizeUp(e) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  cancelAnimationFrame(d.frame);
  handle.removeEventListener('pointermove', onResizeMove);
  handle.removeEventListener('pointerup', onResizeUp);
  handle.removeEventListener('pointercancel', onResizeUp);
  if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
  handle.classList.remove('dragging');
  if (d.want === null) return; // a click, no move
  const total = space();
  if (shouldCollapse(d.want, RESULTS.min)) {
    // Dragged well under the minimum: collapse, keep the remembered height for the next opening.
    setOpen(false);
    toggle.focus({ preventScroll: true });
  } else {
    writeRatio(resultsRatio(clampResults(d.want, total), total));
    layoutResults();
  }
  keepSelected(d.selVisible);
}

function onResizeKey(e) {
  const total = space();
  const res = resultsKey(e.key, e.shiftKey, panel.getBoundingClientRect().height, total);
  if (!res) return;
  e.preventDefault();
  if (res.toggle) {
    setOpen(false); // the handle hides with the panel: focus goes to "Kết quả"
    toggle.focus();
    return;
  }
  const was = selectedFullyVisible();
  writeRatio(resultsRatio(res.height, total));
  layoutResults();
  keepSelected(was);
}

const fileBase = () => (state.workflow.name || 'workflow').replace(/[^\w.-]+/g, '_');

/** Opens or collapses the panel; the toggle says which (aria-expanded, chevron down open / up collapsed). */
function setOpen(open) {
  panel.classList.toggle('collapsed', !open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.querySelector('.caret').dataset.ico = open ? 'chevron-down' : 'chevron-up';
  layoutResults();
}

/** "Tải" (phones): the two download buttons as a menu; each row calls its button. */
function openDownloadMenu() {
  const row = (btn) => ({ label: btn.textContent, disabled: btn.disabled, title: btn.title, onSelect: () => btn.click() });
  dlMenu.setAttribute('aria-expanded', 'true');
  openPopup(dlMenu, { title: 'Tải về', items: [row(dlJson), row(dlCsv)], onClose: () => dlMenu.setAttribute('aria-expanded', 'false') });
}

/** Regenerates the last run on the server and saves it (CSV: one sObject). */
async function exportFile(format, sobject) {
  const run = state.resultRun;
  if (!run || busyDownload) return;
  const btn = format === 'json' ? dlJson : dlCsv;
  const label = btn.textContent;
  busyDownload = true;
  btn.textContent = 'Đang tạo file…';
  btn.disabled = true;
  try {
    const { blob, filename } = await api.exportFile({
      workflow: run.workflow, seed: run.seed, now: run.now, format, sobject, org: run.org || undefined, expectQueries: run.expectQueries,
      runId: run.runId, // the server reuses the Query rows of that run (exactly what was shown / inserted)
    });
    download(filename, blob);
  } catch (e) {
    toast(e.message, e.status === 409 ? 8000 : 5000);
  } finally {
    busyDownload = false;
    btn.textContent = label;
    btn.disabled = false;
    updateButtons();
  }
}

/**
 * Header while a run goes on: summary nodes, progress (value/max, or indeterminate), Dừng.
 * stopLabel / stopTitle: "Dừng ngay" while a Bulk job is waited for (design 0011).
 */
export function showProgress({ parts, value, max, onStop, stopping = false, stopLabel = 'Dừng', stopTitle = STOP_TITLE }) {
  setOpen(true);
  summary.replaceChildren(...parts);
  progressBar.hidden = false;
  if (max) {
    progressBar.max = max;
    progressBar.value = Math.min(value ?? 0, max);
  } else progressBar.removeAttribute('value');
  dlJson.hidden = dlCsv.hidden = dlMenu.hidden = historyBtn.hidden = true;
  if (popupAnchor() === dlMenu) closePopup();
  stopBtn.hidden = false;
  stopBtn.textContent = stopLabel;
  stopBtn.title = stopTitle;
  stopBtn.disabled = stopping || !onStop;
  stopBtn.onclick = onStop ?? null;
}

/** Back to the idle header (download buttons instead of Dừng). */
export function endProgress() {
  // Dừng disappears: keep the keyboard user's place on the next sensible control.
  const hadFocus = document.activeElement === stopBtn;
  progressBar.hidden = true;
  stopBtn.hidden = true;
  stopBtn.onclick = null;
  stopBtn.textContent = 'Dừng';
  stopBtn.title = STOP_TITLE;
  dlJson.hidden = dlCsv.hidden = dlMenu.hidden = historyBtn.hidden = false;
  updateButtons();
  if (hadFocus) document.getElementById('btn-preview').focus();
}

/** One-off status text in the header (errors, lost connection). */
export function showRunning(text) {
  setOpen(true);
  summary.textContent = text;
}

/** Chips `<sObject> n` (or `n/total` when totals are given). */
export function sobjectChips(counts, totals) {
  return Object.entries(totals ?? counts).map(([s, t]) => {
    const v = counts?.[s];
    const n = typeof v === 'object' && v ? v.inserted : v ?? 0;
    return h('span', { class: 'chip' }, totals ? `${s} ${fmt(n)}/${fmt(t)}` : `${s} ${fmt(n)}`);
  });
}

const activeQuery = () => (activeTab?.startsWith(QUERY_TAB) ? state.result?.queries?.find((q) => `${QUERY_TAB}${q.nodeId}` === activeTab) : null);
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '');

/** Rows of a Query as table records: relationship fields become `Owner.Name` columns. */
function queryRecords(q) {
  const flat = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`, out);
      else out[`${prefix}${k}`] = v;
    }
    return out;
  };
  return q.records.map((row, i) => ({ ref: `${q.alias}#${i + 1}`, fields: flat(row) }));
}

function querySummary(queries) {
  if (!queries?.length) return [];
  const fromOrg = queries.filter((q) => q.source !== 'sample');
  const samples = queries.filter((q) => q.source === 'sample');
  const parts = [];
  if (fromOrg.length) parts.push(` · ↓ đọc từ ${fromOrg[0].org}: ${fromOrg.map((q) => `${q.alias} ${q.count} (${hhmm(q.fetchedAt)})`).join(', ')}`);
  for (const q of samples) parts.push(` · ↓ ${q.alias}: ${q.count} bản ghi mẫu`);
  return [
    ...parts,
    ' · ',
    h('button', { class: 'link', title: 'Đọc lại org cho các bước Query rồi xem trước (Ctrl+Shift+Enter)', onclick: () => onRefresh?.() }, ico('refresh'), 'Đọc lại'),
  ];
}

function updateButtons() {
  const r = state.result;
  const canExport = Boolean(state.resultRun && r?.stats?.total);
  const hasQueries = Boolean(r?.queries?.length);
  dlJson.disabled = busyDownload || !canExport;
  dlCsv.disabled = busyDownload || !(canExport || hasQueries);
  dlMenu.disabled = dlJson.disabled && dlCsv.disabled;
  const tip = state.resultRun ? `Server sinh lại từ seed ${state.resultRun.seed}, ra đúng dữ liệu đang xem.` : '';
  dlJson.title = tip;
  dlCsv.title = tip;
}

function insertSummary(ins) {
  if (!ins) return '';
  const note = ins.stopped?.reason === 'allFailing' || ins.stopped?.reason === 'bulkFailing' ? ' · đã dừng vì lỗi hàng loạt' : ins.stopped ? ' · đã dừng' : ins.cancelled ? ' · đã dừng' : '';
  // Design 0011: the Ids of this insert and the history (only when it was recorded).
  const links = ins.historyId
    ? [
      ' · ',
      h('button', { class: 'link', 'data-action': 'ids', title: 'Tải mọi Id đã insert của lần chạy này (CSV)', onclick: () => onIds?.(ins.historyId) }, 'Tải Id'),
      ' · ',
      h('button', { class: 'link', 'data-action': 'history', title: 'Mở Lịch sử insert ở lần chạy này', onclick: () => onHistory?.(ins.historyId) }, 'Lịch sử'),
    ]
    : [];
  return h('span', {}, ' · ', h('span', { class: 'ok' }, `insert ${fmt(ins.inserted)}`), ins.failed ? h('span', { class: 'err' }, ` · lỗi ${fmt(ins.failed)}`) : '', note, ...links);
}

function render() {
  const r = state.result;
  updateButtons();
  if (!r) {
    summary.textContent = 'Chưa chạy.';
    const del = state.deleteResult;
    // A delete from the history with nothing run yet in this tab: only its error tab (design 0011).
    if (del?.failed) {
      setOpen(true);
      body.replaceChildren(
        h('div', { class: 'tabs' }, h('button', { class: 'tab-issues tab-delete-errors active' }, `Lỗi xóa (${fmt(del.failed)})`)),
        errorGroupsView({ errorGroups: del.errorGroups, errorGroupsOther: del.errorGroupsOther, errors: [], errorsTotal: del.failed }, { exampleLabel: 'Id ví dụ' }),
      );
    } else body.replaceChildren();
    return;
  }
  setOpen(true);
  summary.replaceChildren(
    ...Object.entries(r.stats.bySobject).map(([s, n]) => h('span', { class: 'chip' }, `${s}: ${fmt(n)}`)),
    ` ${fmt(r.stats.total)} bản ghi · seed `,
    h('code', {}, String(r.seed)),
    ' ',
    h('button', { class: 'link', title: 'Dùng seed này cho lần chạy sau để ra đúng dữ liệu này', onclick: () => keepSeed(r.seed) }, ico('pin'), 'giữ seed'),
    ` · ${fmt(r.stats.durationMs)} ms`,
    r.cancelled && !r.insert ? ' · đã dừng' : '',
    ...querySummary(r.queries),
    insertSummary(r.insert),
  );

  const sobjects = Object.keys(r.stats.bySobject);
  const queryTabs = (r.queries ?? []).map((q) => `${QUERY_TAB}${q.nodeId}`);
  const errorsTotal = r.insert?.errorsTotal ?? r.insert?.errors?.length ?? 0;
  const del = state.deleteResult; // last delete of the history (design 0011), shown with this run
  const deleteErrors = del?.failed ?? 0;
  if (!sobjects.includes(activeTab) && !queryTabs.includes(activeTab) && !(activeTab === ERRORS_TAB && errorsTotal) && !(activeTab === DELETE_ERRORS_TAB && deleteErrors)) activeTab = sobjects[0] ?? queryTabs[0] ?? null;
  const tabs = h(
    'div',
    { class: 'tabs' },
    sobjects.map((s) => h('button', { class: s === activeTab ? 'active' : '', onclick: () => { activeTab = s; render(); } }, `${s} (${fmt(r.stats.bySobject[s])})`)),
    (r.queries ?? []).map((q) => {
      const key = `${QUERY_TAB}${q.nodeId}`;
      return h('button', { class: `tab-query${key === activeTab ? ' active' : ''}`, 'data-query': q.nodeId, 'data-type': 'query', title: 'Bản ghi đọc từ org (chỉ để xem, không insert)', onclick: () => { activeTab = key; render(); } }, `↓ ${q.alias} · ${q.sobject} (${q.count})`);
    }),
    errorsTotal ? h('button', { class: `tab-issues${activeTab === ERRORS_TAB ? ' active' : ''}`, onclick: () => { activeTab = ERRORS_TAB; render(); } }, `Lỗi insert (${fmt(errorsTotal)})`) : null,
    deleteErrors ? h('button', { class: `tab-issues tab-delete-errors${activeTab === DELETE_ERRORS_TAB ? ' active' : ''}`, onclick: () => { activeTab = DELETE_ERRORS_TAB; render(); } }, `Lỗi xóa (${fmt(deleteErrors)})`) : null,
  );
  const q = activeQuery();
  let content;
  if (activeTab === ERRORS_TAB) content = errorGroupsView(r.insert);
  else if (activeTab === DELETE_ERRORS_TAB) content = errorGroupsView({ errorGroups: del.errorGroups, errorGroupsOther: del.errorGroupsOther, errors: [], errorsTotal: del.failed }, { exampleLabel: 'Id ví dụ' });
  else if (q) {
    const when = q.fetchedAt ? new Date(q.fetchedAt).toLocaleTimeString('vi-VN') : '';
    content = h('div', {},
      h('p', { class: 'hint query-hint' }, q.source === 'sample'
        ? 'Bản ghi mẫu (Id giả) vì chưa chọn org. Chọn org để đọc dữ liệu thật.'
        : `Đọc từ org "${q.org}" lúc ${when}, chỉ để xem, không insert. SOQL: ${q.soql}`),
      dataTable(queryRecords(q), null, q.records.length));
  } else {
    // Records of a Bulk step (design 0011) have no ref → Id mapping: their Ids are in "Tải Id".
    const viaBulk = (r.insert?.bulk ?? []).some((b) => b.sobject === activeTab);
    content = dataTable(r.records.filter((x) => x.sobject === activeTab), r.insert?.ids, r.stats.bySobject[activeTab] ?? 0, { viaBulk, failedRefs: new Set((r.insert?.errors ?? []).map((e) => e.ref)) });
  }
  const prevLeft = body.querySelector('.tabs')?.scrollLeft ?? 0;
  body.replaceChildren(tabs, content);
  unwatchTabs?.();
  unwatchTabs = watchOverflow(tabs);
  tabs.scrollLeft = prevLeft;
  const active = tabs.querySelector('.active');
  if (active) revealInRow(tabs, active);
}

/** "📌 giữ seed": fills the Seed field; the input event updates the phone's "Seed n" chip. */
function keepSeed(seed) {
  const input = document.getElementById('seed');
  input.value = seed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Re-renders the panel (a delete finished: its error tab). */
export function renderResults() {
  render();
}

/**
 * The insert-error tag of a card (design 0012 D): the "Lỗi insert" tab with the first error group
 * of that step highlighted (.current) and focused; past the 100 groups, the tab only.
 */
export function showInsertErrorsFor(nodeId) {
  const ins = state.result?.insert;
  if (!ins) {
    toast('Đang insert: nhóm lỗi hiện ở tab "Lỗi insert" khi insert xong.', 4000);
    return;
  }
  if (!(ins.errorsTotal ?? ins.errors?.length)) return;
  activeTab = ERRORS_TAB;
  render();
  const row = body.querySelector(`table.error-groups tr[data-node="${CSS.escape(nodeId)}"]`);
  if (!row) return;
  row.classList.add('current');
  row.scrollIntoView({ block: 'nearest' });
  row.focus({ preventScroll: true });
}

/** Opens the "Lỗi xóa" tab (design 0011). */
export function showDeleteErrors() {
  activeTab = DELETE_ERRORS_TAB;
  render();
}

function dataTable(records, ids, total, { viaBulk = false, failedRefs = new Set() } = {}) {
  const idCell = (x) => ids[x.ref] ?? (viaBulk && !failedRefs.has(x.ref)
    ? h('span', { class: 'null', title: 'Gửi bằng Bulk API 2.0: Id có trong "Tải Id" (Bulk không trả Id theo từng dòng).' }, 'Bulk')
    : h('span', { class: 'err', title: 'Insert lỗi: xem tab "Lỗi insert"' }, ico('error'), h('span', { class: 'sr-only' }, 'lỗi')));
  const cols = [...new Set(records.flatMap((x) => Object.keys(x.fields)))];
  const rows = records.slice(0, previewRows());
  const table = h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'ref'), ids ? h('th', {}, 'Id') : null, cols.map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.map((x) => h('tr', {}, h('td', {}, h('span', { class: 'ref' }, x.ref)), ids ? h('td', {}, idCell(x)) : null, cols.map((c) => h('td', { title: display(x.fields[c]) }, cell(x.fields[c], ids)))))),
  );
  return h('div', {}, table, total > rows.length ? h('p', { class: 'hint table-more' }, `Hiển thị ${fmt(rows.length)}/${fmt(total)} dòng đầu. Tải CSV/JSON để lấy đủ.`) : null);
}

const DETAIL_ROWS = 200; // rows of "Chi tiết từng bản ghi" drawn (the server sends at most 1 000)

/** Insert failures grouped by (sObject, step, field, message pattern); a row selects the step / field. */
function errorGroupsView(ins, { exampleLabel = 'Ví dụ' } = {}) {
  const groups = ins?.errorGroups ?? [];
  const other = ins?.errorGroupsOther;
  const errors = ins?.errors ?? [];
  const stepName = (id) => {
    const step = id ? stepById(id) : null;
    return step ? stepAlias(step) || id : id ?? '';
  };
  // Review nit: a group of a step no longer in the workflow (deleted since the run) is not a button.
  const target = (g) => groupTarget(g, (id) => Boolean(stepById(id)));
  const go = (g) => target(g) && onGoTo?.({ nodeId: g.nodeId, field: g.field });
  const shown = errors.slice(0, DETAIL_ROWS);
  const total = ins?.errorsTotal ?? errors.length;
  return h('div', {},
    h('table', { class: 'data error-groups' },
      h('thead', {}, h('tr', {}, h('th', {}, 'sObject'), h('th', {}, 'Bước'), h('th', {}, 'Lỗi'), h('th', {}, 'Số bản ghi'), h('th', {}, exampleLabel))),
      h('tbody', {},
        groups.map((g) => h('tr', {
          class: target(g) ? 'clickable' : '',
          'data-node': g.nodeId,
          role: target(g) ? 'button' : null,
          tabindex: target(g) ? '0' : null,
          title: target(g) ? 'Bấm để chọn bước' : g.nodeId ? 'Bước này không còn trong workflow.' : '',
          onclick: () => go(g),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              go(g);
            }
          },
        },
        h('td', {}, g.sobject),
        h('td', {}, stepName(g.nodeId)),
        h('td', { class: 'err wrap' }, g.message),
        h('td', { class: 'num' }, fmt(g.count)),
        h('td', {}, g.refs.join(', ')))),
        other ? h('tr', { class: 'other-groups' }, h('td', { colspan: '3', class: 'wrap' }, `… và ${fmt(other.groups)} nhóm lỗi khác`), h('td', { class: 'num' }, fmt(other.count)), h('td', {})) : null)),
    shown.length
      ? h('details', { class: 'error-details' },
        h('summary', {}, `Chi tiết từng bản ghi${total > shown.length ? ` (${fmt(shown.length)} dòng đầu / ${fmt(total)})` : ''}`),
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'ref'), h('th', {}, 'sObject'), h('th', {}, 'Lỗi'))),
          h('tbody', {}, shown.map((e) => h('tr', {}, h('td', {}, e.ref), h('td', {}, e.sobject), h('td', { class: 'err wrap' }, e.message))))))
      : null);
}

function cell(v, ids) {
  if (v === null || v === undefined) return h('span', { class: 'null' }, '—');
  if (typeof v === 'object' && v.$ref) return h('span', { class: 'ref', title: ids?.[v.$ref] ?? '' }, `→ ${v.$ref}`);
  return display(v);
}

function display(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.$ref ?? JSON.stringify(v);
  return String(v);
}

/** CSV of the rows of a Query tab (generated records are exported by the server). */
function toCsv(records) {
  const cols = [...new Set(records.flatMap((x) => Object.keys(x.fields)))];
  const esc = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['ref', ...cols].join(',')];
  for (const x of records) lines.push([x.ref, ...cols.map((c) => esc(display(x.fields[c])))].map(String).join(','));
  return lines.join('\r\n');
}
