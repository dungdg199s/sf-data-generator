// Single app state + undo/redo history + localStorage autosave.
// Views subscribe and receive the change `source` so a view can skip re-rendering
// for edits it made itself (keeps input focus while typing in the inspector).

import { findStep, collectAliases, allSteps } from '/shared/workflow-tree.js';
import { analyzeRecordScope } from '/shared/scope.js';

const STORAGE_KEY = 'sfdg.workflow.v2';
// Autosave of the old graph editor. Read once for migration, never written or removed.
const LEGACY_STORAGE_KEY = 'sfdg.workflow.v1';
const COLLAPSED_KEY = 'sfdg.collapsed';
const COLLAPSED_MAX = 500;
const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

export const NODE_COLORS = {
  start: 'var(--node-start)',
  record: 'var(--node-record)',
  loop: 'var(--node-loop)',
  branch: 'var(--node-branch)',
};

export function emptyWorkflow() {
  return { version: 2, name: 'Workflow mới', steps: [] };
}

export const state = {
  meta: null, // { fieldTypes, nodeTypes, stepCategories, limits }
  workflow: emptyWorkflow(),
  selection: null, // { kind: 'step', id } | { kind: 'workflow' }
  issues: { errors: [], warnings: [] },
  orgs: [],
  org: '',
  result: null,
  lastRunKey: null,
  lastRunSteps: null, // JSON of steps at the last run, to dim stale stat chips
  collapsed: loadCollapsed(), // ids of containers shown collapsed (UI only, no undo)
};

const listeners = new Set();
const past = [];
const future = [];
let lastCoalesce = { key: null, at: 0 };

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
  persist();
  emit(source, 'workflow');
  return result;
}

export function replaceWorkflow(wf, { history = true } = {}) {
  updateWorkflow((cur) => {
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, wf);
  }, { history });
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
  if (state.selection?.kind === 'step' && !stepById(state.selection.id)) state.selection = null;
  persist();
  emit('history', 'workflow');
}

export function select(selection) {
  state.selection = selection;
  emit('app', 'selection');
}

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workflow));
  } catch {
    // Storage full or disabled: autosave is a convenience, not a requirement.
  }
}

export function loadPersisted() {
  return readJson(STORAGE_KEY);
}

/** The old editor's autosave (version 1), if any. Read-only. */
export function loadLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? { raw, workflow: JSON.parse(raw) } : null;
  } catch {
    return null;
  }
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

export function selectedStep() {
  return state.selection?.kind === 'step' ? stepById(state.selection.id) : null;
}

/** Record scope (which aliases are usable where), see shared/scope.js. */
export function recordScope() {
  return analyzeRecordScope(state.workflow, slotKeys);
}

/** Suggest a short unique alias from an sObject name: Account → acc, My_Thing__c → mything. */
export function suggestAlias(sobject, exceptStepId) {
  const base = (sobject || 'rec').replace(/__c$/i, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 8) || 'rec';
  const short = base.length > 4 ? base.slice(0, 3) : base;
  const taken = collectAliases(state.workflow);
  const own = stepById(exceptStepId)?.config?.alias;
  if (own) taken.delete(own);
  if (!taken.has(short)) return short;
  for (let i = 2; ; i++) if (!taken.has(`${short}${i}`)) return `${short}${i}`;
}

/** Workflow as it affects the run, plus the seed. Stable key for "same as last preview". */
export function runKey(wf, seed) {
  return JSON.stringify({ seed, steps: wf.steps, settings: wf.settings ?? null });
}
