// Workflow JSON version 1 (graph: nodes + edges) → version 2 (tree of steps), design 0003.
// Shared by client (opening old files / autosave) and server (accepting v1 over the API).
// Pure: no DOM, no I/O. The input is never modified.
//
// Algorithm:
// 1. Normalise nodes and edges: of several nodes with one id keep the *last* (the one the v1
//    executor looked up); drop edges from/to missing nodes; keep only the *last* edge per
//    output port (the one the v1 executor really followed); cut edges that close a cycle.
// 2. Continuation of a node: start/record → next, loop → done, branch → its join point (the
//    first node on the true-chain that is also on the false-chain, or null). Join points are
//    computed iteratively in reverse topological order, so long graphs cannot overflow the stack.
// 3. build(entry, stop) follows continuations: loop → slots.body = build(body, null);
//    branch → slots.true/false = build(true|false, join). Nesting stops one level below
//    `maxDepth` (reported as tooDeep) so validation gives its friendly depth error.
// 4. A node already placed (graph shapes a tree cannot express) is placed again as a copy of
//    it and its tail (cloneSteps: id `x_2`, new aliases). Copies are capped.
// 5. Nodes not reachable from Start are appended at the end, disabled.
//
// A copy generates its own values: `unique` fields and Auto Number counters are tracked per
// step, so they can repeat between "c" and "c_2", and the rng sequence after the copy differs
// from v1. Such copies are listed in `uniqueFields` and described in the report.

import { cloneSteps } from './workflow-tree.js';

const CONTINUE_PORT = { start: 'next', record: 'next', loop: 'done' };

const DEFAULT_MAX_DEPTH = 32; // LIMITS.maxDepth (server/workflow/nodes.js)
const REPORT_KEYS = ['duplicated', 'disabled', 'droppedEdges', 'truncated', 'duplicateIds', 'tooDeep'];

export function emptyReport() {
  return Object.fromEntries(REPORT_KEYS.map((k) => [k, []]));
}

export const reportIsEmpty = (r) => !r || REPORT_KEYS.every((k) => !r[k]?.length);

/**
 * True when the conversion changed what the workflow does (copies or a cut), so it must be
 * reviewed in the editor before inserting into an org.
 */
export const reportNeedsReview = (r) => Boolean(r && (r.duplicated?.length || r.truncated?.length || r.tooDeep?.length));

/** Names of fields whose values depend on per-step state (unique sets, Auto Number counters). */
function statefulFields(fields, fieldTypes) {
  const uniqueDefault = (type) => fieldTypes?.find((t) => t.type === type)?.options?.find((o) => o.key === 'unique')?.default === true;
  const out = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f?.name) continue;
    const raw = f.options?.unique;
    const unique = raw === undefined || raw === null || raw === '' ? uniqueDefault(f.type) : raw === true || raw === 'true';
    if (unique || f.type === 'autonumber') out.push(f.name);
  }
  return out;
}

/**
 * @param opts.maxDepth   LIMITS.maxDepth (nesting deeper than this is cut and reported)
 * @param opts.fieldTypes /api/meta fieldTypes (for the default of the "unique" option)
 * @returns {{ workflow: object, report: { duplicated, disabled, droppedEdges, truncated, duplicateIds, tooDeep } }}
 * A version-2 input is returned as is, with an empty report.
 */
export function migrateV1(wf, { maxDepth = DEFAULT_MAX_DEPTH, fieldTypes } = {}) {
  const report = emptyReport();
  if (!wf || typeof wf !== 'object' || wf.version !== 1) return { workflow: wf, report };

  const nodeList = (Array.isArray(wf.nodes) ? wf.nodes : []).filter((n) => n && typeof n === 'object' && n.id !== undefined && n.id !== null);
  const nodes = new Map();
  for (const n of nodeList) {
    // Same id twice: the v1 executor (new Map(nodes)) used the last one.
    if (nodes.has(n.id) && !report.duplicateIds.includes(n.id)) report.duplicateIds.push(n.id);
    nodes.set(n.id, n);
  }

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
  const finished = cutCycles(nodes, out, report);
  const follow = (id, port) => out.get(id)?.[port]?.to ?? null;

  // 2. Continuations and join points. `finished` lists every node after all nodes reachable
  // from it, so each join is computed after the joins its chains depend on.
  const joinMemo = new Map();
  const cont = (id) => {
    const n = nodes.get(id);
    if (n.type === 'branch') return joinMemo.get(id) ?? null;
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
  for (const b of finished) {
    if (nodes.get(b).type !== 'branch') continue;
    const onFalse = new Set(chain(follow(b, 'false')));
    joinMemo.set(b, chain(follow(b, 'true')).find((id) => onFalse.has(id)) ?? null);
  }
  const join = (b) => joinMemo.get(b) ?? null;

  /** Every node reachable from `id` (all ports), iteratively. */
  const reachable = (id) => {
    const seen = new Set([id]);
    const todo = [id];
    while (todo.length) {
      for (const { to } of Object.values(out.get(todo.pop()) ?? {})) {
        if (!seen.has(to)) {
          seen.add(to);
          todo.push(to);
        }
      }
    }
    return seen;
  };

  // 3–4. Build the tree.
  const ids = new Set(nodes.keys());
  const aliases = new Set();
  for (const n of nodes.values()) if (n.type === 'record' && n.config?.alias) aliases.add(n.config.alias);
  const budget = 2 * nodes.size + 50;
  let made = 0;
  const placed = new Set();
  const origin = new Map(); // copy id -> original node id (copies can be copied again)

  function build(entry, stop, ctx, depth = 0) {
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
          tail = build(id, stop, { placed: new Set(), copying: true }, depth);
        } catch (e) {
          if (!(e instanceof Truncated)) throw e;
          made = before;
          if (ctx.copying) throw e;
          report.truncated.push(id);
          break;
        }
        const { steps: copy, renamed } = cloneSteps(tail, { ids, aliases });
        for (const r of renamed) origin.set(r.copyId, origin.get(r.id) ?? r.id);
        if (!ctx.copying && renamed.length) {
          const root = renamed[0].copyId;
          for (const r of renamed) {
            const entry = { ...r, id: origin.get(r.copyId), root };
            const unique = statefulFields(nodes.get(entry.id)?.config?.fields, fieldTypes);
            if (unique.length) entry.uniqueFields = unique;
            report.duplicated.push(entry);
          }
        }
        steps.push(...copy);
        break;
      }
      if (++made > budget && ctx.copying) throw new Truncated();
      ctx.placed.add(id);
      if (!ctx.copying) placed.add(id);
      const step = { id: n.id, type: n.type, config: structuredClone(n.config ?? {}) };
      if (n.type === 'loop') {
        // Write down the values the executor falls back to, so the form shows what really runs.
        if ((step.config.mode ?? 'fixed') === 'range') {
          step.config.min ??= 1;
          step.config.max ??= 1;
        } else step.config.count ??= 0;
      }
      if ((n.type === 'loop' || n.type === 'branch') && depth > maxDepth) {
        // One level deeper than allowed: keep the step (validation reports the depth) but
        // not what is inside it.
        step.slots = n.type === 'loop' ? { body: [] } : { true: [], false: [] };
        if (!ctx.copying && !report.tooDeep.length) report.tooDeep.push(id);
        for (const r of reachable(id)) {
          ctx.placed.add(r);
          if (!ctx.copying) placed.add(r);
        }
      } else if (n.type === 'loop') step.slots = { body: build(follow(id, 'body'), null, ctx, depth + 1) };
      else if (n.type === 'branch') {
        const j = join(id);
        step.slots = { true: build(follow(id, 'true'), j, ctx, depth + 1), false: build(follow(id, 'false'), j, ctx, depth + 1) };
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

/**
 * Iterative DFS over the normalised ports; removes every edge that closes a cycle.
 * Returns the node ids in the order they finished (descendants before ancestors).
 */
function cutCycles(nodes, out, report) {
  const finished = [];
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
        finished.push(top[0]);
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
  return finished;
}

const PORT_LABELS = { next: 'tiếp', body: 'lặp', done: 'xong', true: 'đúng', false: 'sai' };

/**
 * One Vietnamese sentence per report entry, with the step it concerns, for the migration
 * dialog (client) and as warnings (server).
 */
export function describeReport(report) {
  const items = [];
  // Copies: one line per copied sequence (its first step), then one per copy with stateful fields.
  const groups = new Map();
  for (const d of report?.duplicated ?? []) {
    const key = d.root ?? d.copyId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const quoted = (list) => list.map((x) => `"${x}"`).join(', ');
  for (const [, [d, ...rest]] of groups) {
    const after = rest.length ? ` và ${rest.length} bước phía sau (${quoted(rest.slice(0, 5).map((r) => r.copyId))}${rest.length > 5 ? ', …' : ''})` : '';
    const aliased = [d, ...rest].filter((r) => r.alias);
    const renamed = aliased.length
      ? ` Bản sao dùng alias mới (${aliased.slice(0, 5).map((r) => `"${r.alias}" → "${r.newAlias}"`).join(', ')}${aliased.length > 5 ? ', …' : ''}); kiểm tra các field tham chiếu tới ${quoted(aliased.slice(0, 5).map((r) => r.alias))}.`
      : '';
    items.push({
      nodeId: d.copyId,
      message: `Bước "${d.id}" được nối tới từ nhiều chỗ nên đã được nhân thành "${d.id}" và "${d.copyId}"${after}.${renamed}`,
    });
    for (const r of [d, ...rest]) {
      if (!r.uniqueFields?.length) continue;
      items.push({
        nodeId: r.copyId,
        message: `Field ${quoted(r.uniqueFields)} của "${r.id}" là giá trị duy nhất hoặc số tự tăng, nhưng bản sao "${r.copyId}" đếm riêng nên giá trị duy nhất có thể trùng giữa "${r.id}" và "${r.copyId}", và dữ liệu từ đây trở đi khác bản cũ với cùng seed. Thêm Tiền tố/Hậu tố khác cho field đó ở "${r.copyId}" (hoặc sửa bản gốc để chỉ còn một dây nối tới "${r.id}").`,
      });
    }
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
  for (const id of report?.duplicateIds ?? []) {
    items.push({ nodeId: id, message: `Có nhiều node cùng id "${id}". Giữ node khai báo sau cùng (node mà bản cũ thực sự chạy) và bỏ các node còn lại; kiểm tra lại bước "${id}".` });
  }
  for (const id of report?.tooDeep ?? []) {
    items.push({ nodeId: id, message: `Workflow lồng nhau quá sâu nên các bước bên trong "${id}" đã bị bỏ. Bỏ bớt Lặp/Rẽ nhánh lồng nhau trong bản gốc (v1) rồi mở lại.` });
  }
  for (const id of report?.truncated ?? []) {
    items.push({ nodeId: undefined, message: `Workflow có quá nhiều chỗ nối chéo nên ngừng nhân bản tại "${id}"; nhánh đó bị cắt. Kiểm tra lại các bước sau "${id}".` });
  }
  return items;
}
