// Bottom panel: run summary, per-sObject tables, insert results, JSON/CSV download.

import { h, download } from './dom.js';
import { state, subscribe } from './store.js';

const PREVIEW_ROWS = 200;
let activeTab = null;
let panel, body, summary;

export function initResults() {
  panel = document.getElementById('results');
  body = document.getElementById('results-body');
  summary = document.getElementById('results-summary');
  document.getElementById('btn-results-toggle').onclick = () => panel.classList.toggle('collapsed');
  document.getElementById('btn-dl-json').onclick = () => {
    if (state.result) download(`${fileBase()}.json`, JSON.stringify(state.result.records, null, 2));
  };
  document.getElementById('btn-dl-csv').onclick = () => {
    if (state.result && activeTab) download(`${fileBase()}-${activeTab}.csv`, toCsv(state.result.records.filter((r) => r.sobject === activeTab)), 'text/csv');
  };
  subscribe(({ kind }) => kind === 'result' && render());
}

const fileBase = () => (state.workflow.name || 'workflow').replace(/[^\w.-]+/g, '_');

export function showRunning(text) {
  panel.classList.remove('collapsed');
  summary.textContent = text;
}

function render() {
  const r = state.result;
  const hasData = Boolean(r?.records?.length);
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
    r.insert ? h('span', {}, ' · ', h('span', { class: 'ok' }, `insert ${r.insert.inserted}`), r.insert.failed ? h('span', { class: 'err' }, ` · lỗi ${r.insert.failed}`) : '') : '',
  );

  const sobjects = Object.keys(r.stats.bySobject);
  if (!sobjects.includes(activeTab)) activeTab = sobjects[0] ?? null;
  const tabs = h(
    'div',
    { class: 'tabs' },
    sobjects.map((s) => h('button', { class: s === activeTab ? 'active' : '', onclick: () => { activeTab = s; render(); } }, `${s} (${r.stats.bySobject[s]})`)),
    r.insert?.errors.length ? h('button', { class: `tab-issues${activeTab === '__errors' ? ' active' : ''}`, onclick: () => { activeTab = '__errors'; render(); } }, `Lỗi insert (${r.insert.errors.length})`) : null,
  );
  body.replaceChildren(tabs, activeTab === '__errors' ? errorTable(r.insert.errors) : dataTable(r.records.filter((x) => x.sobject === activeTab), r.insert?.ids));
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
