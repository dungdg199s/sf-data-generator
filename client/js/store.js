// Single app state + undo/redo history + localStorage autosave.
// Views subscribe and receive the change `source` so a view can skip re-rendering
// for edits it made itself (keeps input focus while typing in the inspector).

const STORAGE_KEY = 'sfdg.workflow.v1';
const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

export const NODE_COLORS = {
  start: 'var(--node-start)',
  record: 'var(--node-record)',
  loop: 'var(--node-loop)',
  branch: 'var(--node-branch)',
};

export function emptyWorkflow() {
  return {
    version: 1,
    name: 'Workflow mới',
    nodes: [{ id: 'start', type: 'start', position: { x: 60, y: 160 }, config: {} }],
    edges: [],
  };
}

export const state = {
  meta: null, // { fieldTypes, nodeTypes, limits }
  workflow: emptyWorkflow(),
  selection: null, // { kind: 'node' | 'edge', id }
  issues: { errors: [], warnings: [] },
  orgs: [],
  org: '',
  result: null,
  lastRunKey: null,
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
  if (history && !coalesce) {
    past.push(JSON.stringify(state.workflow));
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
  }
  lastCoalesce = { key: coalesceKey, at: now };
  fn(state.workflow);
  persist();
  emit(source, 'workflow');
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
  if (state.selection && !findSelection()) state.selection = null;
  persist();
  emit('history', 'workflow');
}

export function select(selection) {
  state.selection = selection;
  emit('app', 'selection');
}

function findSelection() {
  const s = state.selection;
  if (s.kind === 'node') return state.workflow.nodes.find((n) => n.id === s.id);
  return state.workflow.edges.find((e) => edgeId(e) === s.id);
}

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workflow));
  } catch {
    // Storage full or disabled: autosave is a convenience, not a requirement.
  }
}

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function newId(prefix = 'n') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const edgeId = (e) => `${e.from}:${e.fromPort ?? 'next'}`;

export function nodeById(id) {
  return state.workflow.nodes.find((n) => n.id === id);
}

export function nodeType(type) {
  return state.meta?.nodeTypes.find((t) => t.type === type);
}

export function fieldType(type) {
  return state.meta?.fieldTypes.find((t) => t.type === type);
}

/** Aliases of record nodes, for lookup "parent" pickers. */
export function recordAliases(exceptNodeId) {
  return state.workflow.nodes
    .filter((n) => n.type === 'record' && n.id !== exceptNodeId && n.config?.alias)
    .map((n) => ({ alias: n.config.alias, sobject: n.config.sobject, nodeId: n.id }));
}

/** Suggest a short unique alias from an sObject name: Account → acc, My_Thing__c → mything. */
export function suggestAlias(sobject, exceptNodeId) {
  const base = (sobject || 'rec').replace(/__c$/i, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 8) || 'rec';
  const short = base.length > 4 ? base.slice(0, 3) : base;
  const taken = new Set(recordAliases(exceptNodeId).map((a) => a.alias));
  if (!taken.has(short)) return short;
  for (let i = 2; ; i++) if (!taken.has(`${short}${i}`)) return `${short}${i}`;
}

/** Workflow without UI-only data, as sent to the server. Stable key for "same as last preview". */
export function runKey(wf, seed) {
  return JSON.stringify({ seed, nodes: wf.nodes.map(({ position, ...n }) => n), edges: wf.edges });
}
