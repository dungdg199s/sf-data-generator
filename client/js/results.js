// Bottom panel: run summary, per-sObject tables, read-only tabs of the rows each Query step read
// (design 0006: `queries[]` of /api/run, never inserted), insert results, JSON/CSV download.

import { h, download } from './dom.js';
import { state, subscribe } from './store.js';

const PREVIEW_ROWS = 200;
const QUERY_TAB = 'q:'; // activeTab of a Query tab: `q:<stepId>`
let activeTab = null;
let panel, body, summary;
let onRefresh = null;

/** opts.onRefresh: "⟳ Đọc lại" (preview again, reading the org instead of the query cache). */
export function initResults({ onRefresh: refresh } = {}) {
  onRefresh = refresh ?? null;
  panel = document.getElementById('results');
  body = document.getElementById('results-body');
  summary = document.getElementById('results-summary');
  document.getElementById('btn-results-toggle').onclick = () => panel.classList.toggle('collapsed');
  document.getElementById('btn-dl-json').onclick = () => {
    if (state.result) download(`${fileBase()}.json`, JSON.stringify(state.result.records, null, 2));
  };
  document.getElementById('btn-dl-csv').onclick = () => {
    if (!state.result || !activeTab) return;
    const q = activeQuery();
    if (q) download(`${fileBase()}-${q.alias}.csv`, toCsv(queryRecords(q)), 'text/csv');
    else download(`${fileBase()}-${activeTab}.csv`, toCsv(state.result.records.filter((r) => r.sobject === activeTab)), 'text/csv');
  };
  subscribe(({ kind }) => kind === 'result' && render());
}

const fileBase = () => (state.workflow.name || 'workflow').replace(/[^\w.-]+/g, '_');

export function showRunning(text) {
  panel.classList.remove('collapsed');
  summary.textContent = text;
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
    h('button', { class: 'link', title: 'Đọc lại org cho các bước Query rồi xem trước (Ctrl+Shift+Enter)', onclick: () => onRefresh?.() }, '⟳ Đọc lại'),
  ];
}

function render() {
  const r = state.result;
  const hasData = Boolean(r?.records?.length || r?.queries?.length);
  document.getElementById('btn-dl-json').disabled = !hasData;
  document.getElementById('btn-dl-csv').disabled = !hasData;
  if (!r) {
    summary.textContent = 'Chưa chạy.';
    body.replaceChildren();
    return;
  }
  panel.classList.remove('collapsed');
  const chips = Object.entries(r.stats.bySobject).map(([s, n]) => h('span', { class: 'chip' }, `${s}: ${n}`));
  summary.replaceChildren(
    ...chips,
    ` ${r.stats.total} bản ghi · seed `,
    h('code', {}, String(r.seed)),
    ' ',
    h('button', { class: 'link', title: 'Dùng seed này cho lần chạy sau để ra đúng dữ liệu này', onclick: () => { document.getElementById('seed').value = r.seed; } }, '📌 giữ seed'),
    ` · ${r.stats.durationMs} ms`,
    ...querySummary(r.queries),
    r.insert ? h('span', {}, ' · ', h('span', { class: 'ok' }, `insert ${r.insert.inserted}`), r.insert.failed ? h('span', { class: 'err' }, ` · lỗi ${r.insert.failed}`) : '') : '',
  );

  const sobjects = Object.keys(r.stats.bySobject);
  const queryTabs = (r.queries ?? []).map((q) => `${QUERY_TAB}${q.nodeId}`);
  if (!sobjects.includes(activeTab) && !queryTabs.includes(activeTab) && !(activeTab === '__errors' && r.insert?.errors.length)) activeTab = sobjects[0] ?? queryTabs[0] ?? null;
  const tabs = h(
    'div',
    { class: 'tabs' },
    sobjects.map((s) => h('button', { class: s === activeTab ? 'active' : '', onclick: () => { activeTab = s; render(); } }, `${s} (${r.stats.bySobject[s]})`)),
    (r.queries ?? []).map((q) => {
      const key = `${QUERY_TAB}${q.nodeId}`;
      return h('button', { class: `tab-query${key === activeTab ? ' active' : ''}`, 'data-query': q.nodeId, 'data-type': 'query', title: 'Bản ghi đọc từ org (chỉ để xem, không insert)', onclick: () => { activeTab = key; render(); } }, `↓ ${q.alias} · ${q.sobject} (${q.count})`);
    }),
    r.insert?.errors.length ? h('button', { class: `tab-issues${activeTab === '__errors' ? ' active' : ''}`, onclick: () => { activeTab = '__errors'; render(); } }, `Lỗi insert (${r.insert.errors.length})`) : null,
  );
  const q = activeQuery();
  let content;
  if (activeTab === '__errors') content = errorTable(r.insert.errors);
  else if (q) {
    const when = q.fetchedAt ? new Date(q.fetchedAt).toLocaleTimeString('vi-VN') : '';
    content = h('div', {},
      h('p', { class: 'hint query-hint' }, q.source === 'sample'
        ? 'Bản ghi mẫu (Id giả) vì chưa chọn org. Chọn org để đọc dữ liệu thật.'
        : `Đọc từ org "${q.org}" lúc ${when}, chỉ để xem, không insert. SOQL: ${q.soql}`),
      dataTable(queryRecords(q), null));
  } else content = dataTable(r.records.filter((x) => x.sobject === activeTab), r.insert?.ids);
  body.replaceChildren(tabs, content);
}

function dataTable(records, ids) {
  const cols = [...new Set(records.flatMap((x) => Object.keys(x.fields)))];
  const rows = records.slice(0, PREVIEW_ROWS);
  const table = h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'ref'), ids ? h('th', {}, 'Id') : null, cols.map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.map((x) => h('tr', {}, h('td', {}, h('span', { class: 'ref' }, x.ref)), ids ? h('td', {}, ids[x.ref] ?? h('span', { class: 'err' }, '✕')) : null, cols.map((c) => h('td', { title: display(x.fields[c]) }, cell(x.fields[c], ids)))))),
  );
  return h('div', {}, table, records.length > PREVIEW_ROWS ? h('p', { class: 'hint' }, `Hiển thị ${PREVIEW_ROWS}/${records.length} dòng. Tải CSV/JSON để xem đủ.`) : null);
}

function errorTable(errors) {
  return h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'ref'), h('th', {}, 'sObject'), h('th', {}, 'Lỗi'))),
    h('tbody', {}, errors.map((e) => h('tr', {}, h('td', {}, e.ref), h('td', {}, e.sobject), h('td', { class: 'err', style: { whiteSpace: 'normal' } }, e.message)))),
  );
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

export function toCsv(records) {
  const cols = [...new Set(records.flatMap((x) => Object.keys(x.fields)))];
  const esc = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['ref', ...cols].join(',')];
  for (const x of records) lines.push([x.ref, ...cols.map((c) => esc(display(x.fields[c])))].map(String).join(','));
  return lines.join('\r\n');
}
