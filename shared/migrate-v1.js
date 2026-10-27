// Workflow JSON version 1 (graph: nodes + edges) → version 2 (tree of steps), design 0003.
// Shared by client (opening old files / autosave) and server (accepting v1 over the API).
// Pure: no DOM, no I/O. The input is never modified.
//
// Algorithm:
// 1. Normalise edges: drop edges from/to missing nodes; keep only the *last* edge per output
//    port (the one the v1 executor really followed); cut edges that close a cycle.
// 2. Continuation of a node: start/record → next, loop → done, branch → its join point (the
//    first node on the true-chain that is also on the false-chain, or null).
// 3. build(entry, stop) follows continuations: loop → slots.body = build(body, null);
//    branch → slots.true/false = build(true|false, join).
// 4. A node already placed (graph shapes a tree cannot express) is placed again as a copy of
//    it and its tail (cloneSteps: id `x_2`, new aliases). Copies are capped.
// 5. Nodes not reachable from Start are appended at the end, disabled.

import { cloneSteps } from './workflow-tree.js';

const CONTINUE_PORT = { start: 'next', record: 'next', loop: 'done' };

export function emptyReport() {
  return { duplicated: [], disabled: [], droppedEdges: [], truncated: [] };
}

export const reportIsEmpty = (r) => !r || (!r.duplicated.length && !r.disabled.length && !r.droppedEdges.length && !r.truncated.length);

/**
 * @returns {{ workflow: object, report: { duplicated, disabled, droppedEdges, truncated } }}
 * A version-2 input is returned as is, with an empty report.
 */
export function migrateV1(wf) {
  const report = emptyReport();
  if (!wf || typeof wf !== 'object' || wf.version !== 1) return { workflow: wf, report };

  const nodeList = (Array.isArray(wf.nodes) ? wf.nodes : []).filter((n) => n && typeof n === 'object' && n.id !== undefined && n.id !== null);
  const nodes = new Map();
  for (const n of nodeList) if (!nodes.has(n.id)) nodes.set(n.id, n);

  // 1. Normalise edges.
  const out = new Map(); // id -> { port: { to, index } }
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  edges.forEach((e, index) => {
    if (!e || !nodes.has(e.from) || !nodes.has(e.to)) {
      report.droppedEdges.push({ from: e?.from, fromPort: e?.fromPort ?? 'next', to: e?.to, reason: 'missing' });
      return;
    }
    const port = e.fromPort ?? 'next';
    const ports = out.get(e.from) ?? {};
    if (ports[port]) report.droppedEdges.push({ from: e.from, fromPort: port, to: ports[port].to, reason: 'fanout' });
    ports[port] = { to: e.to, index };
    out.set(e.from, ports);
  });
  cutCycles(nodes, out, report);
  const follow = (id, port) => out.get(id)?.[port]?.to ?? null;

  // 2. Continuations and join points.
  const joinMemo = new Map();
  const cont = (id) => {
    const n = nodes.get(id);
    if (n.type === 'branch') return join(id);
    return follow(id, CONTINUE_PORT[n.type] ?? 'next');
  };
  const chain = (entry) => {
    const ids = [];
    const seen = new Set();
    for (let id = entry; id && !seen.has(id); id = cont(id)) {
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  function join(b) {
    if (joinMemo.has(b)) return joinMemo.get(b);
    joinMemo.set(b, null); // guards against re-entry; the graph is acyclic after step 1
    const onFalse = new Set(chain(follow(b, 'false')));
    const j = chain(follow(b, 'true')).find((id) => onFalse.has(id)) ?? null;
    joinMemo.set(b, j);
    return j;
  }

  // 3–4. Build the tree.
  const ids = new Set(nodes.keys());
  const aliases = new Set();
  for (const n of nodes.values()) if (n.type === 'record' && n.config?.alias) aliases.add(n.config.alias);
  const budget = 2 * nodes.size + 50;
  let made = 0;
  const placed = new Set();
  const origin = new Map(); // copy id -> original node id (copies can be copied again)

  function build(entry, stop, ctx) {
    const steps = [];
    const seen = new Set();
    for (let id = entry; id && id !== stop && !seen.has(id); id = cont(id)) {
      seen.add(id);
      const n = nodes.get(id);
      if (n.type === 'start') continue;
      if (ctx.placed.has(id)) {
        // Reached from a second place: copy this node and everything after it in this sequence.
        const before = made;
        let tail;
        try {
          tail = build(id, stop, { placed: new Set(), copying: true });
        } catch (e) {
          if (!(e instanceof Truncated)) throw e;
          made = before;
          if (ctx.copying) throw e;
          report.truncated.push(id);
          break;
        }
        const { steps: copy, renamed } = cloneSteps(tail, { ids, aliases });
        for (const r of renamed) origin.set(r.copyId, origin.get(r.id) ?? r.id);
        if (!ctx.copying) {
          for (const r of renamed) report.duplicated.push({ ...r, id: origin.get(r.copyId) });
        }
        steps.push(...copy);
        break;
      }
      if (++made > budget && ctx.copying) throw new Truncated();
      ctx.placed.add(id);
      if (!ctx.copying) placed.add(id);
      const step = { id: n.id, type: n.type, config: structuredClone(n.config ?? {}) };
      if (n.type === 'loop') step.slots = { body: build(follow(id, 'body'), null, ctx) };
      else if (n.type === 'branch') {
        const j = join(id);
        step.slots = { true: build(follow(id, 'true'), j, ctx), false: build(follow(id, 'false'), j, ctx) };
      }
      steps.push(step);
    }
    return steps;
  }

  const ctx = { placed, copying: false };
  const start = nodeList.find((n) => n.type === 'start');
  const steps = start ? build(start.id, null, ctx) : [];

  // 5. Unreachable nodes: roots first (no incoming edge from another unplaced node), then the rest.
  const appendDisabled = (id) => {
    for (const s of build(id, null, ctx)) {
      s.disabled = true;
      report.disabled.push(s.id);
      steps.push(s);
    }
  };
  const unplaced = () => nodeList.filter((n) => n.type !== 'start' && !placed.has(n.id) && nodes.get(n.id) === n);
  const fedByUnplaced = new Set();
  for (const [from, ports] of out) {
    if (placed.has(from) || nodes.get(from)?.type === 'start') continue;
    for (const { to } of Object.values(ports)) fedByUnplaced.add(to);
  }
  for (const n of unplaced()) if (!fedByUnplaced.has(n.id) && !placed.has(n.id)) appendDisabled(n.id);
  for (const n of unplaced()) if (!placed.has(n.id)) appendDisabled(n.id);

  const { version, nodes: _n, edges: _e, ...rest } = wf;
  return { workflow: { version: 2, ...structuredClone(rest), steps }, report };
}

class Truncated extends Error {}

/** Iterative DFS over the normalised ports; removes every edge that closes a cycle. */
function cutCycles(nodes, out, report) {
  const state = new Map(); // 1 = on stack, 2 = done
  for (const root of nodes.keys()) {
    if (state.get(root)) continue;
    const stack = [[root, Object.keys(out.get(root) ?? {})]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const port = top[1].shift();
      if (port === undefined) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const to = out.get(top[0])?.[port]?.to;
      if (to === undefined) continue;
      const s = state.get(to);
      if (s === 1) {
        delete out.get(top[0])[port];
        report.droppedEdges.push({ from: top[0], fromPort: port, to, reason: 'cycle' });
      } else if (!s) {
        state.set(to, 1);
        stack.push([to, Object.keys(out.get(to) ?? {})]);
      }
    }
  }
}

const PORT_LABELS = { next: 'tiếp', body: 'lặp', done: 'xong', true: 'đúng', false: 'sai' };

/**
 * One Vietnamese sentence per report entry, with the step it concerns, for the migration
 * dialog (client) and as warnings (server).
 */
export function describeReport(report) {
  const items = [];
  for (const d of report?.duplicated ?? []) {
    items.push({
      nodeId: d.copyId,
      message: d.alias
        ? `Bước "${d.id}" được nối tới từ nhiều chỗ nên đã được nhân thành "${d.id}" và "${d.copyId}" (alias "${d.newAlias}"). Kiểm tra các field tham chiếu tới "${d.alias}".`
        : `Bước "${d.id}" được nối tới từ nhiều chỗ nên đã được nhân bản thành "${d.copyId}".`,
    });
  }
  for (const id of report?.disabled ?? []) {
    items.push({ nodeId: id, message: `Bước "${id}" chưa được nối từ Bắt đầu nên đã được đặt ở cuối và đang tắt. Bật lại (Ctrl+/) nếu cần.` });
  }
  for (const e of report?.droppedEdges ?? []) {
    const port = PORT_LABELS[e.fromPort] ?? e.fromPort;
    if (e.reason === 'cycle') items.push({ nodeId: e.from, message: `Bỏ dây "${e.from}" → "${e.to}" vì dây này tạo vòng lặp.` });
    else if (e.reason === 'fanout') {
      items.push({ nodeId: e.from, message: `Cổng "${port}" của "${e.from}" có nhiều dây. Giữ dây sau cùng (dây mà bản cũ thực sự chạy) và bỏ dây tới "${e.to}"; nếu "${e.to}" không còn được nối thì nó được đặt ở cuối và đang tắt.` });
    } else items.push({ nodeId: undefined, message: `Bỏ dây tới node không tồn tại ("${e.from ?? '?'}" → "${e.to ?? '?'}").` });
  }
  for (const id of report?.truncated ?? []) {
    items.push({ nodeId: undefined, message: `Workflow có quá nhiều chỗ nối chéo nên ngừng nhân bản tại "${id}"; nhánh đó bị cắt. Kiểm tra lại các bước sau "${id}".` });
  }
  return items;
}
