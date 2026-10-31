// Single app state + undo/redo history + autosave (the workflow library of design 0012 A,
// library-ui.js, sets the handler; without it, the single autosave `sfdg.workflow.v2` of before).
// Views subscribe and receive the change `source` so a view can skip re-rendering
// for edits it made itself (keeps input focus while typing in the inspector).

import { findStep, collectAliases, allSteps } from '/shared/workflow-tree.js';
import { analyzeScope } from '/shared/scope.js';
import { estimateSteps } from '/shared/estimate.js';

// The single autosave of before the library: only written while the library could not be made
// (storage full on the first run, design 0012 A "chế độ cũ").
const STORAGE_KEY = 'sfdg.workflow.v2';
const COLLAPSED_KEY = 'sfdg.collapsed';
const COLLAPSED_MAX = 500;
const VIEW_KEY = 'sfdg.view'; // 'process' (Quy trình, default) | 'canvas' (Sơ đồ), design 0003
const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

export function emptyWorkflow() {
  return { version: 2, name: 'Workflow mới', steps: [] };
}

export const state = {
  meta: null, // { fieldTypes, nodeTypes, stepCategories, limits }
  workflow: emptyWorkflow(),
  // { kind: 'step', id, ids?, anchor? } | { kind: 'workflow' }. `id`: the primary step; `ids`: every
  // selected step when several are (design 0012 B, selection.js); `anchor`: start of a Shift range.
  selection: null,
  issues: { errors: [], warnings: [] },
  orgs: [],
  org: '',
  result: null, // last run (design 0004: first previewRows records per sObject + totals)
  // Inserts that wrote records in this tab, newest last, at most 20 ({ key: runKey(workflow, seed), org }):
  // kept across workflows of the library, so a copied workflow inserted again with the same seed warns.
  lastInserts: [],
  resultRun: null, // { workflow, seed, now, org, expectQueries } of that run: downloads regenerate from it
  lastRunKey: null,
  lastRunOrg: null, // org the Query steps of the last preview read ('' = sample rows)
  lastRunSteps: null, // JSON of steps at the last run, to dim stale stat chips
  runLive: null, // counts of the run going on, for the cards (design 0012 D, client/js/run-cards.js)
  collapsed: loadCollapsed(), // ids of containers shown collapsed (UI only, no undo)
  view: 'process', // 'process' | 'canvas' (views.js; UI only, no undo)
};

const listeners = new Set();
const past = [];
const future = [];
let lastCoalesce = { key: null, at: 0 };
let revision = 0; // bumped by every change to the workflow (edits, undo, redo)

/** Changes when the workflow changes; lets a toast's "Hoàn tác" check nothing happened since. */
export const workflowRevision = () => revision;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(source = 'app', kind = 'all') {
  for (const fn of listeners) fn({ source, kind });
}

/**
 * Mutate the workflow through `fn(workflow)`. Records an undo step unless coalesced
 * with the previous edit of the same `coalesceKey` (typing into one input).
 */
export function updateWorkflow(fn, { source = 'app', coalesceKey = null, history = true } = {}) {
  const now = Date.now();
  const coalesce = coalesceKey && lastCoalesce.key === coalesceKey && now - lastCoalesce.at < COALESCE_MS;
  const before = history && !coalesce ? JSON.stringify(state.workflow) : null;
  lastCoalesce = { key: coalesceKey, at: now };
  const result = fn(state.workflow);
  if (before !== null) {
    if (before === JSON.stringify(state.workflow)) return result; // no-op edit: no undo step, no event
    past.push(before);
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
  }
  revision++;
  persist();
  emit(source, 'workflow');
  return result;
}

/** Another workflow (Mới, Mở…, Mẫu): source 'replace', so views start from its beginning. */
export function replaceWorkflow(wf, { history = true } = {}) {
  updateWorkflow((cur) => {
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, wf);
  }, { history, source: 'replace' });
  state.selection = null;
  emit('app', 'selection');
}

export function undo() {
  if (!past.length) return false;
  future.push(JSON.stringify(state.workflow));
  restore(past.pop());
  return true;
}

export function redo() {
  if (!future.length) return false;
  past.push(JSON.stringify(state.workflow));
  restore(future.pop());
  return true;
}

function restore(json) {
  state.workflow = JSON.parse(json);
  lastCoalesce = { key: null, at: 0 };
  revision++;
  // Undo / redo keep the primary step selected if it is still there; a multi-selection is not restored (0012 B).
  if (state.selection?.kind === 'step') state.selection = stepById(state.selection.id) ? { kind: 'step', id: state.selection.id } : null;
  persist();
  emit('history', 'workflow');
}

export function select(selection) {
  state.selection = selection;
  emit('app', 'selection');
}

let persistHandler = null;
/** The library's save (library-ui.js); null: the single autosave of before. */
export function setPersistHandler(fn) {
  persistHandler = fn;
}

export function persist() {
  if (persistHandler) return persistHandler(state.workflow);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workflow));
  } catch {
    // Storage full or disabled: autosave is a convenience, not a requirement.
  }
  return undefined;
}

/**
 * Show another workflow of the library (design 0012 A): undo / redo start empty (Ctrl+Z never
 * brings workflow A's content into B), nothing selected, no run result. Not saved: it comes from
 * the library (call persist() when it is new content for the open entry).
 */
export function openWorkflow(wf) {
  state.workflow = wf;
  past.length = 0;
  future.length = 0;
  lastCoalesce = { key: null, at: 0 };
  revision++;
  state.selection = null;
  Object.assign(state, { result: null, resultRun: null, lastRunKey: null, lastRunOrg: null, lastRunSteps: null, runLive: null });
  emit('replace', 'workflow');
  emit('app', 'selection');
  emit('run', 'result');
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------- collapsed containers (UI state) ----------

function loadCollapsed() {
  const list = readJson(COLLAPSED_KEY);
  return new Set(Array.isArray(list) ? list.slice(0, COLLAPSED_MAX) : []);
}

export function saveCollapsed() {
  const existing = new Set(allSteps(state.workflow, slotKeys).map((s) => s.id));
  for (const id of state.collapsed) if (!existing.has(id)) state.collapsed.delete(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed].slice(0, COLLAPSED_MAX)));
  } catch {
    /* optional */
  }
}

export function setCollapsed(ids, collapsed) {
  for (const id of ids) collapsed ? state.collapsed.add(id) : state.collapsed.delete(id);
  saveCollapsed();
  emit('app', 'view');
}

// ---------- view (Quy trình | Sơ đồ, UI state) ----------

/** The saved view choice, or null. */
export function loadView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'process' || v === 'canvas' ? v : null;
  } catch {
    return null;
  }
}

export function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* optional */
  }
}

// ---------- lookups ----------

export function newId(prefix = 's') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function nodeType(type) {
  return state.meta?.nodeTypes.find((t) => t.type === type);
}

export function fieldType(type) {
  return state.meta?.fieldTypes.find((t) => t.type === type);
}

/** Slot keys of a step type in reading order, from /api/meta (for shared/workflow-tree.js). */
export const slotKeys = (type) => nodeType(type)?.slots?.map((s) => s.key) ?? [];

export function locate(id) {
  return id ? findStep(state.workflow, id, slotKeys) : null;
}

export function stepById(id) {
  return locate(id)?.step ?? null;
}

let idCache = { revision: -1, workflow: null, map: new Map() };
/**
 * id → step of the whole workflow, built once per workflow revision (decoration passes and the
 * selection look steps up in it instead of walking the tree for each card).
 */
export function stepsById() {
  if (idCache.revision !== revision || idCache.workflow !== state.workflow) {
    idCache = { revision, workflow: state.workflow, map: new Map(allSteps(state.workflow, slotKeys).map((s) => [s.id, s])) };
  }
  return idCache.map;
}

export function selectedStep() {
  return state.selection?.kind === 'step' ? stepById(state.selection.id) : null;
}

let scopeCache = { revision: -1, workflow: null, scope: null };
/**
 * Variable scope of the current workflow (shared/scope.js analyzeScope, the same analysis the
 * server validates with): sources, what each step can use, and every reference. Recomputed
 * lazily once per workflow revision.
 */
export function currentScope() {
  if (scopeCache.revision !== revision || scopeCache.workflow !== state.workflow) {
    scopeCache = { revision, workflow: state.workflow, scope: analyzeScope(state.workflow, state.meta) };
  }
  return scopeCache.scope;
}

let estimateCache = { revision: -1, workflow: null, result: null, estimate: null };
/**
 * Record-count estimate of the workflow (design 0012 H, shared/estimate.js): once per workflow
 * revision and run result (a Query's last read row count makes a Lặp over it exact).
 */
export function currentEstimate() {
  const result = state.result;
  if (estimateCache.revision !== revision || estimateCache.workflow !== state.workflow || estimateCache.result !== result) {
    const queryCounts = Object.fromEntries((result?.queries ?? []).filter((q) => Number.isFinite(q.count)).map((q) => [q.nodeId, q.count]));
    estimateCache = { revision, workflow: state.workflow, result, estimate: estimateSteps(state.workflow, state.meta, { queryCounts }) };
  }
  return estimateCache.estimate;
}

/** Suggest a short unique alias from an sObject name: Account → acc, My_Thing__c → mything. */
export function suggestAlias(sobject, exceptStepId) {
  const base = (sobject || 'rec').replace(/__c$/i, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 8) || 'rec';
  const short = base.length > 4 ? base.slice(0, 3) : base;
  const taken = collectAliases(state.workflow, state.meta);
  const own = stepById(exceptStepId)?.config?.alias;
  if (own) taken.delete(own);
  if (!taken.has(short)) return short;
  for (let i = 2; ; i++) if (!taken.has(`${short}${i}`)) return `${short}${i}`;
}

/**
 * Pool name for a new / retyped Query step (0006): the preset's alias, else the record alias
 * plus "s" (Account → accs); a number is added when taken (accs2).
 */
export function suggestPoolAlias(sobject, exceptStepId) {
  const preset = state.meta?.queryPresets?.[sobject]?.alias;
  return uniqueAlias(preset ?? `${baseAlias(sobject)}s`, exceptStepId);
}

/**
 * Alias for a Chọn bản ghi step picking from `from`: accs → acc, users → user (acc2 when taken).
 * Also the record a Lặp `each` loops over (design 0010, `key` 'itemAlias').
 */
export function suggestPickAlias(from, exceptStepId, key = 'alias') {
  const base = from && from.length > 1 && from.endsWith('s') ? from.slice(0, -1) : from || 'rec';
  return uniqueAlias(base, exceptStepId, key);
}

function baseAlias(sobject) {
  const base = (sobject || 'rec').replace(/__c$/i, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 8) || 'rec';
  return base.length > 4 ? base.slice(0, 3) : base;
}

function uniqueAlias(name, exceptStepId, key = 'alias') {
  const taken = collectAliases(state.workflow, state.meta);
  for (const s of allSteps(state.workflow, slotKeys)) if (s.type === 'loop') taken.add(s.config?.alias || 'loop');
  const own = stepById(exceptStepId)?.config?.[key];
  if (own) taken.delete(own);
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}

/** The last preview's result of a Query step (`queries[]` of /api/run), or null. */
export function queryResultOf(stepId) {
  return state.result?.queries?.find((q) => q.nodeId === stepId) ?? null;
}

/** Workflow as it affects the run, plus the seed. Stable key for "same as last preview". */
export function runKey(wf, seed) {
  return JSON.stringify({ seed, steps: wf.steps, settings: wf.settings ?? null });
}
