// Validates workflow JSON before execution. Every issue carries nodeId (and field when
// relevant) so the UI can highlight the exact node/field instead of showing a bare message.
// The schema itself is documented in docs/workflow-schema.md — keep the two in sync.

import { nodeTypeMap, CONDITION_OPS, LIMITS } from './nodes.js';
import { getGenerator } from '../generators/index.js';

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ALIASES = new Set(['this']);
const REF_TYPES = new Set(['lookup', 'masterdetail']);

export class WorkflowError extends Error {
  constructor(issues) {
    super(issues.map((i) => i.message).join('\n'));
    this.issues = issues;
  }
}

export function validateWorkflow(wf) {
  const errors = [];
  const warnings = [];
  const err = (message, nodeId, field) => errors.push({ message, nodeId, field });
  const warn = (message, nodeId, field) => warnings.push({ message, nodeId, field });

  if (!wf || typeof wf !== 'object') {
    err('Workflow phải là một object JSON.');
    return { errors, warnings };
  }
  if (wf.version !== 1) err(`Không hỗ trợ workflow version ${wf.version}. Version hiện tại là 1.`);
  if (!Array.isArray(wf.nodes)) err('Thiếu danh sách "nodes".');
  if (!Array.isArray(wf.edges)) err('Thiếu danh sách "edges".');
  if (errors.length) return { errors, warnings };

  // Nodes
  const nodes = new Map();
  for (const n of wf.nodes) {
    if (!n?.id) {
      err('Có node không có id.');
      continue;
    }
    if (nodes.has(n.id)) err(`Trùng id node "${n.id}".`, n.id);
    if (!nodeTypeMap.has(n.type)) err(`Loại node "${n.type}" không tồn tại.`, n.id);
    nodes.set(n.id, n);
  }
  const starts = wf.nodes.filter((n) => n?.type === 'start');
  if (starts.length !== 1) err(starts.length ? 'Chỉ được có một node Bắt đầu.' : 'Workflow cần một node Bắt đầu.');

  // Edges
  const outEdges = new Map(); // nodeId -> { port: targetId }
  const adjacency = new Map(); // nodeId -> [targetId] (every edge, even invalid duplicates)
  for (const e of wf.edges) {
    const from = nodes.get(e?.from);
    const to = nodes.get(e?.to);
    if (!from || !to) {
      err(`Cạnh nối tới node không tồn tại (${e?.from} → ${e?.to}).`, from ? from.id : undefined);
      continue;
    }
    const fromType = nodeTypeMap.get(from.type);
    const toType = nodeTypeMap.get(to.type);
    const port = e.fromPort ?? 'next';
    if (fromType && !fromType.outputs.some((p) => p.port === port)) err(`Node không có cổng ra "${port}".`, from.id);
    if (toType && !toType.inputs) err(`Không thể nối vào node ${toType.label}.`, to.id);
    if (e.from === e.to) err('Node không thể nối vào chính nó.', from.id);
    adjacency.set(from.id, [...(adjacency.get(from.id) ?? []), to.id]);
    const ports = outEdges.get(from.id) ?? {};
    if (ports[port]) err(`Cổng "${port}" chỉ được nối tới một node.`, from.id);
    ports[port] = to.id;
    outEdges.set(from.id, ports);
  }

  if (hasCycle(nodes, adjacency)) err('Workflow có vòng lặp bằng cạnh nối. Dùng node Lặp thay vì nối ngược lại.');

  // Reachability + ancestors (needed to check that lookups point to an upstream node).
  const start = starts[0];
  const reachable = new Set();
  if (start) walk(start.id, outEdges, reachable);
  for (const n of nodes.values()) {
    if (n.type !== 'start' && !reachable.has(n.id)) warn('Node chưa được nối từ Bắt đầu nên sẽ không chạy.', n.id);
  }

  // Aliases
  const aliasOwner = new Map();
  for (const n of nodes.values()) {
    const alias = n.type === 'record' ? n.config?.alias : n.type === 'loop' ? (n.config?.alias || 'loop') : null;
    if (!alias) continue;
    if (!ALIAS.test(alias) || RESERVED_ALIASES.has(alias)) {
      err(`Alias "${alias}" không hợp lệ (chỉ chữ, số, gạch dưới; không bắt đầu bằng số; không dùng "this").`, n.id, 'alias');
      continue;
    }
    if (n.type === 'record' && aliasOwner.has(alias)) err(`Alias "${alias}" đã được dùng ở node khác.`, n.id, 'alias');
    if (n.type === 'record') aliasOwner.set(alias, n.id);
  }
  for (const n of nodes.values()) {
    if (n.type === 'loop' && aliasOwner.has(n.config?.alias || 'loop')) {
      err(`Tên biến lặp "${n.config?.alias || 'loop'}" trùng alias của một node Record.`, n.id, 'alias');
    }
  }

  // Per-node config
  for (const n of nodes.values()) {
    const c = n.config ?? {};
    if (n.type === 'record') validateRecord(n, c, { err, warn, aliasOwner, outEdges });
    if (n.type === 'loop') {
      const mode = c.mode ?? 'fixed';
      const check = (key) => {
        const v = c[key];
        if (v !== undefined && (!Number.isInteger(Number(v)) || v < 0 || v > LIMITS.maxCountPerNode)) {
          err(`Số lần lặp phải là số nguyên từ 0 đến ${LIMITS.maxCountPerNode}.`, n.id, key);
        }
      };
      if (mode === 'fixed') check('count');
      else if (mode === 'range') {
        check('min');
        check('max');
        if (Number(c.min) > Number(c.max)) err('"Ít nhất" lớn hơn "Nhiều nhất".', n.id, 'min');
      } else err(`Chế độ lặp "${mode}" không hợp lệ.`, n.id, 'mode');
      if (!outEdges.get(n.id)?.body) warn('Nhánh "lặp" chưa nối tới node nào.', n.id);
    }
    if (n.type === 'branch') {
      const kind = c.kind ?? 'chance';
      if (kind === 'chance') {
        const p = Number(c.probability ?? 0.5);
        if (!(p >= 0 && p <= 1)) err('Xác suất phải nằm trong khoảng 0–1.', n.id, 'probability');
      } else if (kind === 'compare') {
        if (!c.left) err('Chưa nhập giá trị cần so sánh.', n.id, 'left');
        if (!CONDITION_OPS.some((o) => o.value === c.op)) err('Phép so sánh không hợp lệ.', n.id, 'op');
      } else err(`Loại điều kiện "${kind}" không hợp lệ.`, n.id, 'kind');
    }
  }

  return { errors, warnings };
}

function validateRecord(n, c, { err, warn, aliasOwner, outEdges }) {
  if (!c.sobject || !API_NAME.test(c.sobject)) err('Chưa nhập sObject hợp lệ (API name).', n.id, 'sobject');
  const count = c.count ?? 1;
  if (!Number.isInteger(Number(count)) || count < 1 || count > LIMITS.maxCountPerNode) {
    err(`Số bản ghi phải là số nguyên từ 1 đến ${LIMITS.maxCountPerNode}.`, n.id, 'count');
  }
  const fields = c.fields ?? [];
  if (!Array.isArray(fields)) {
    err('"fields" phải là một danh sách.', n.id);
    return;
  }
  if (!fields.length) warn('Node chưa có field nào; bản ghi sẽ rỗng.', n.id);
  const names = new Set();
  for (const f of fields) {
    const key = `fields.${f?.name}`;
    if (!f?.name || !API_NAME.test(f.name)) {
      err(`Tên field "${f?.name ?? ''}" không hợp lệ.`, n.id, key);
      continue;
    }
    if (names.has(f.name.toLowerCase())) err(`Field "${f.name}" bị khai báo hai lần.`, n.id, key);
    names.add(f.name.toLowerCase());
    if (!getGenerator(f.type)) {
      err(`Field "${f.name}": kiểu "${f.type}" không được hỗ trợ.`, n.id, key);
      continue;
    }
    if (REF_TYPES.has(f.type)) {
      const mode = f.options?.mode ?? 'current';
      const ref = f.options?.ref;
      if (mode !== 'fixed') {
        if (!ref) err(`Field "${f.name}": chưa chọn node cha.`, n.id, key);
        else if (!aliasOwner.has(ref)) err(`Field "${f.name}": không có node Record nào có alias "${ref}".`, n.id, key);
        else if (!isAncestor(aliasOwner.get(ref), n.id, outEdges)) {
          err(`Field "${f.name}": node "${ref}" phải nằm phía trước node này trong workflow.`, n.id, key);
        }
      }
    }
  }
}

function walk(id, outEdges, seen) {
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of Object.values(outEdges.get(cur) ?? {})) stack.push(next);
  }
}

function isAncestor(ancestorId, nodeId, outEdges) {
  if (ancestorId === nodeId) return false;
  const seen = new Set();
  walk(ancestorId, outEdges, seen);
  return seen.has(nodeId);
}

function hasCycle(nodes, adjacency) {
  const state = new Map(); // 1 = visiting, 2 = done
  for (const id of nodes.keys()) {
    if (state.get(id)) continue;
    const stack = [[id, [...(adjacency.get(id) ?? [])]]];
    state.set(id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top[1].pop();
      if (next === undefined) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const s = state.get(next);
      if (s === 1) return true;
      if (!s) {
        state.set(next, 1);
        stack.push([next, [...(adjacency.get(next) ?? [])]]);
      }
    }
  }
  return false;
}
