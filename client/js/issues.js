// Issues bar (design 0009 §1): validation errors and warnings docked under the canvas, in the
// page flow, so it never covers a step card. Collapsible (remembered in
// localStorage['sfdg.issuesCollapsed'], UI state, not undoable); F8 / Shift+F8 walk the rows.
// It only expands by itself when a run fails on validation (main.js calls expandIssues), never
// on the 400 ms background validation, so the layout does not jump while the user types.
//
// The pure helpers (issueCountParts, issueCountsLabel, nextIssueIndex) are unit-tested in
// test/issues.test.js; the DOM part only imports dom.js so the module also loads in Node.

import { h, toast } from './dom.js';

const KEY = 'sfdg.issuesCollapsed';

/** [{ level: 'error' | 'warning', text }] of the count: "2 lỗi", "1 cảnh báo". */
export function issueCountParts({ errors = 0, warnings = 0 } = {}) {
  const parts = [];
  if (errors) parts.push({ level: 'error', text: `${errors} lỗi` });
  if (warnings) parts.push({ level: 'warning', text: `${warnings} cảnh báo` });
  return parts;
}

/** "2 lỗi · 1 cảnh báo" / "2 lỗi" / "1 cảnh báo" ("" when there is nothing). */
export function issueCountsLabel(counts) {
  return issueCountParts(counts).map((p) => p.text).join(' · ');
}

/**
 * Index of the row F8 (dir 1) or Shift+F8 (dir -1) goes to, wrapping around. `current` -1 (or
 * out of range: the list changed) starts at the first row (F8) or the last (Shift+F8). -1 when empty.
 */
export function nextIssueIndex(current, length, dir) {
  if (!length) return -1;
  if (!(current >= 0 && current < length)) return dir < 0 ? length - 1 : 0;
  return (current + (dir < 0 ? -1 : 1) + length) % length;
}

export function readCollapsed() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v) {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: lasts until reload */
  }
}

let box, list, count, firstLine, toggle;
let rows = []; // [{ issue, key, el }]
let current = -1;
let currentKey = null;
let collapsed = false;
let onGoTo = () => {};

const keyOf = (i) => `${i.level}|${i.nodeId ?? ''}|${i.field ?? ''}|${i.message}`;

/** opts.onGoTo(issue): select the issue's step and field. */
export function initIssues({ onGoTo: goTo }) {
  onGoTo = goTo;
  box = document.getElementById('issues');
  list = document.getElementById('issues-list');
  count = document.getElementById('issues-count');
  firstLine = document.getElementById('issues-first');
  toggle = document.getElementById('btn-issues-toggle');
  collapsed = readCollapsed();
  toggle.onclick = () => setCollapsed(!collapsed);
  firstLine.onclick = () => rows[0] && go(0);
  applyCollapsed();
}

function applyCollapsed() {
  box.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.textContent = collapsed ? `Hiện (${rows.length})` : 'Thu gọn';
  toggle.title = collapsed ? 'Hiện danh sách lỗi và cảnh báo' : 'Thu gọn danh sách lỗi và cảnh báo';
  firstLine.hidden = !collapsed || !rows.length;
}

function setCollapsed(v) {
  collapsed = v;
  writeCollapsed(v);
  applyCollapsed();
}

/**
 * A run failed on validation: show the whole list. The remembered choice is left as it was, so
 * a user who keeps the bar collapsed gets it collapsed again after a reload.
 */
export function expandIssues() {
  if (!collapsed) return;
  collapsed = false;
  applyCollapsed();
}

/**
 * Draws the bar. `all`: [{ level, message, nodeId, field, prefix }] in display order (errors first).
 */
export function renderIssues(all) {
  const errors = all.filter((i) => i.level === 'error').length;
  const warnings = all.length - errors;
  box.hidden = !all.length;
  box.classList.toggle('only-warnings', !errors);
  // aria-live: only touch the count when it changes, or every background validation re-announces it.
  const label = issueCountsLabel({ errors, warnings });
  if (count.dataset.label !== label) {
    count.dataset.label = label;
    count.replaceChildren(...issueCountParts({ errors, warnings }).flatMap((p, n) => [
      n ? ' · ' : '',
      h('span', { class: `ic ic-${p.level}` }, p.text),
    ]));
  }
  rows = all.map((issue, n) => {
    const key = keyOf(issue);
    const el = h('button', {
      class: `issue ${issue.level}`,
      title: issue.nodeId ? 'Bấm để chọn bước' : '',
      onclick: () => go(n),
    }, `${issue.prefix ?? ''}${issue.message}`);
    return { issue, key, el };
  });
  list.replaceChildren(...rows.map((r) => r.el));
  current = currentKey ? rows.findIndex((r) => r.key === currentKey) : -1;
  markCurrent();
  const first = rows[0];
  firstLine.textContent = first ? `— ${first.issue.prefix ?? ''}${first.issue.message}` : '';
  firstLine.title = first ? 'Bấm để tới bước này' : '';
  applyCollapsed();
}

function markCurrent() {
  rows.forEach((r, n) => r.el.classList.toggle('current', n === current));
}

function go(n) {
  current = n;
  currentKey = rows[n].key;
  markCurrent();
  rows[n].el.scrollIntoView({ block: 'nearest' });
  onGoTo(rows[n].issue);
}

/** F8 (dir 1) / Shift+F8 (dir -1). */
export function goToNextIssue(dir) {
  const n = nextIssueIndex(current, rows.length, dir);
  if (n < 0) {
    toast('Không có lỗi hay cảnh báo.');
    return;
  }
  go(n);
}
