// Node canvas: renders nodes as absolutely positioned divs and edges as SVG paths in a
// pan/zoom viewport. Port geometry is computed from constants (must match app.css .node/.port).

import { h } from './dom.js';
import { state, subscribe, updateWorkflow, select, nodeType, edgeId, newId, NODE_COLORS, suggestAlias } from './store.js';

const NODE_W = 210;
const PORT_Y = 25; // centre of first port relative to node top (4px top border + 14px offset + 7px radius)
const PORT_GAP = 22;

const view = { x: 0, y: 0, scale: 1 };
let canvasEl, viewportEl, nodesEl, edgesEl;

export function initCanvas() {
  canvasEl = document.getElementById('canvas');
  viewportEl = document.getElementById('viewport');
  nodesEl = document.getElementById('nodes');
  edgesEl = document.getElementById('edges');

  canvasEl.addEventListener('pointerdown', onBackgroundDown);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  canvasEl.addEventListener('dragover', (e) => e.preventDefault());
  canvasEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/x-node-type');
    if (type) addNode(type, { position: toWorld(e.clientX, e.clientY), connect: false });
  });

  document.getElementById('btn-zoom-in').onclick = () => zoomAt(1.2);
  document.getElementById('btn-zoom-out').onclick = () => zoomAt(1 / 1.2);
  document.getElementById('btn-zoom-fit').onclick = fit;

  subscribe(({ kind, source }) => {
    if (source === 'canvas-drag') return; // the drag handler moves DOM nodes itself
    if (kind === 'workflow' || kind === 'selection' || kind === 'issues' || kind === 'all') render();
  });
  render();
  requestAnimationFrame(fit);
}

// ---------- rendering ----------

function render() {
  applyView();
  const wf = state.workflow;
  const counts = issueCounts();
  nodesEl.replaceChildren(...wf.nodes.map((n) => renderNode(n, counts.get(n.id))));
  renderEdges();
}

function renderNode(node, issue) {
  const type = nodeType(node.type);
  const selected = state.selection?.kind === 'node' && state.selection.id === node.id;
  const outs = type?.outputs ?? [];
  const el = h(
    'div',
    {
      class: `node${selected ? ' selected' : ''}${issue?.errors ? ' has-error' : ''}${issue?.warnings ? ' has-warning' : ''}`,
      'data-id': node.id,
      style: {
        left: `${node.position?.x ?? 0}px`,
        top: `${node.position?.y ?? 0}px`,
        minHeight: `${Math.max(56, PORT_Y + outs.length * PORT_GAP)}px`,
        '--c': NODE_COLORS[node.type],
      },
    },
    h(
      'div',
      { class: 'title' },
      type?.label ?? node.type,
      node.type === 'record' && node.config?.alias ? h('span', { class: 'alias' }, node.config.alias) : null,
      issue?.errors ? h('span', { class: 'badge', title: 'Lỗi' }, issue.errors) : issue?.warnings ? h('span', { class: 'badge warn', title: 'Cảnh báo' }, issue.warnings) : null,
    ),
    h('div', { class: 'summary', title: nodeSummary(node) }, nodeSummary(node)),
  );
  if (type?.inputs) el.append(h('div', { class: 'port in' }));
  outs.forEach((p, i) => {
    const top = PORT_Y - 4 - 7 + i * PORT_GAP;
    el.append(h('div', { class: 'port out', 'data-port': p.port, title: p.label || 'Kéo để nối', style: { top: `${top}px` } }));
    if (p.label) el.append(h('div', { class: 'port-label', style: { top: `${top}px` } }, p.label));
  });
  el.addEventListener('pointerdown', (e) => onNodeDown(e, node));
  return el;
}

export function nodeSummary(node) {
  const c = node.config ?? {};
  switch (node.type) {
    case 'start':
      return 'Điểm bắt đầu';
    case 'record':
      return `${c.sobject || '?'} × ${c.count ?? 1} · ${(c.fields ?? []).length} field`;
    case 'loop': {
      const times = (c.mode ?? 'fixed') === 'range' ? `${c.min ?? 1}–${c.max ?? 5} lần` : `${c.count ?? 3} lần`;
      return `${times} · {{${c.alias || 'loop'}.index}}`;
    }
    case 'branch': {
      if ((c.kind ?? 'chance') === 'chance') return `${Math.round((c.probability ?? 0.5) * 100)}% đi nhánh đúng`;
      const op = nodeType('branch').options.find((o) => o.key === 'op').choices.find((x) => x.value === c.op)?.label ?? c.op;
      return `${c.left ?? ''} ${op} ${c.right ?? ''}`;
    }
    default:
      return '';
  }
}

function portPos(node, port) {
  const x = node.position?.x ?? 0;
  const y = node.position?.y ?? 0;
  if (port === null) return { x, y: y + PORT_Y };
  const idx = Math.max(0, (nodeType(node.type)?.outputs ?? []).findIndex((p) => p.port === port));
  return { x: x + NODE_W, y: y + PORT_Y + idx * PORT_GAP };
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function renderEdges(temp) {
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const byId = new Map(state.workflow.nodes.map((n) => [n.id, n]));
  const children = [];
  for (const e of state.workflow.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const d = curve(portPos(from, e.fromPort ?? 'next'), portPos(to, null));
    const id = edgeId(e);
    const g = mk('g', { class: state.selection?.kind === 'edge' && state.selection.id === id ? 'selected' : '' });
    g.append(mk('path', { class: 'edge', d }));
    const hit = mk('path', { class: 'hit', d });
    hit.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      select({ kind: 'edge', id });
    });
    g.append(hit);
    children.push(g);
  }
  if (temp) children.push(mk('path', { class: 'temp', d: curve(temp.a, temp.b) }));
  edgesEl.replaceChildren(...children);
}

function issueCounts() {
  const map = new Map();
  for (const [kind, list] of [['errors', state.issues.errors], ['warnings', state.issues.warnings]]) {
    for (const i of list) {
      if (!i.nodeId) continue;
      const c = map.get(i.nodeId) ?? { errors: 0, warnings: 0 };
      c[kind]++;
      map.set(i.nodeId, c);
    }
  }
  return map;
}

// ---------- view ----------

function applyView() {
  viewportEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function toWorld(clientX, clientY) {
  const r = canvasEl.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.scale, y: (clientY - r.top - view.y) / view.scale };
}

function zoomAt(factor, clientX, clientY) {
  const r = canvasEl.getBoundingClientRect();
  const cx = clientX ?? r.left + r.width / 2;
  const cy = clientY ?? r.top + r.height / 2;
  const before = toWorld(cx, cy);
  view.scale = Math.min(2, Math.max(0.25, view.scale * factor));
  view.x = cx - r.left - before.x * view.scale;
  view.y = cy - r.top - before.y * view.scale;
  applyView();
}

export function fit() {
  const nodes = state.workflow.nodes;
  if (!nodes.length || !canvasEl) return;
  const r = canvasEl.getBoundingClientRect();
  const xs = nodes.map((n) => n.position?.x ?? 0);
  const ys = nodes.map((n) => n.position?.y ?? 0);
  const minX = Math.min(...xs) - 40;
  const minY = Math.min(...ys) - 40;
  const w = Math.max(...xs) + NODE_W + 40 - minX;
  const hgt = Math.max(...ys) + 120 - minY;
  view.scale = Math.min(1.2, Math.max(0.25, Math.min(r.width / w, r.height / hgt)));
  view.x = (r.width - w * view.scale) / 2 - minX * view.scale;
  view.y = (r.height - hgt * view.scale) / 2 - minY * view.scale;
  applyView();
}

function onWheel(e) {
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
}

// ---------- interactions ----------

function onBackgroundDown(e) {
  if (e.button !== 0 || e.target.closest('.node')) return;
  canvasEl.focus();
  const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  let moved = false;
  canvasEl.classList.add('panning');
  const move = (ev) => {
    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
    view.x = start.vx + ev.clientX - start.x;
    view.y = start.vy + ev.clientY - start.y;
    applyView();
  };
  const up = () => {
    canvasEl.classList.remove('panning');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!moved && state.selection) select(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onNodeDown(e, node) {
  if (e.button !== 0) return;
  e.stopPropagation();
  canvasEl.focus();
  const portEl = e.target.closest('.port.out');
  if (portEl) return startConnect(e, node, portEl.dataset.port);

  if (state.selection?.id !== node.id) select({ kind: 'node', id: node.id });
  const el = nodesEl.querySelector(`[data-id="${CSS.escape(node.id)}"]`);
  const start = toWorld(e.clientX, e.clientY);
  const origin = { ...(node.position ?? { x: 0, y: 0 }) };
  let moved = false;
  const move = (ev) => {
    const p = toWorld(ev.clientX, ev.clientY);
    const x = Math.round((origin.x + p.x - start.x) / 10) * 10;
    const y = Math.round((origin.y + p.y - start.y) / 10) * 10;
    if (!moved && (x !== origin.x || y !== origin.y)) {
      moved = true;
      // One undo step for the whole drag.
      updateWorkflow(() => {}, { source: 'canvas-drag' });
    }
    node.position = { x, y };
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    renderEdges();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) updateWorkflow(() => {}, { history: false, source: 'canvas' });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startConnect(e, node, port) {
  const a = portPos(node, port);
  let target = null;
  const move = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    if (target && target !== over) target.classList.remove('drop-target');
    target = over && over.dataset.id !== node.id && nodeType(state.workflow.nodes.find((n) => n.id === over.dataset.id)?.type)?.inputs ? over : null;
    target?.classList.add('drop-target');
    renderEdges({ a, b: toWorld(ev.clientX, ev.clientY) });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    target?.classList.remove('drop-target');
    if (target) connect(node.id, port, target.dataset.id);
    else renderEdges();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function connect(from, fromPort, to) {
  updateWorkflow((wf) => {
    // An output port feeds exactly one node: reconnecting replaces the old edge.
    wf.edges = wf.edges.filter((x) => !(x.from === from && (x.fromPort ?? 'next') === fromPort));
    wf.edges.push({ from, fromPort, to });
  });
}

/**
 * Add a node. With connect=true (palette click) it is placed right of the selected node and
 * wired from that node's first free output port — the common "keep building" flow is one click.
 */
export function addNode(type, { position, connect: autoConnect = true, config } = {}) {
  const def = nodeType(type);
  const wf = state.workflow;
  const anchor = state.selection?.kind === 'node' ? wf.nodes.find((n) => n.id === state.selection.id) : null;
  const freePort = anchor && nodeType(anchor.type)?.outputs.map((p) => p.port).find((p) => !wf.edges.some((e) => e.from === anchor.id && (e.fromPort ?? 'next') === p));
  // Second output ports ("done", "false") get their node placed below the first one's.
  const portIndex = anchor && freePort ? nodeType(anchor.type).outputs.findIndex((p) => p.port === freePort) : 0;
  const pos =
    position ??
    (anchor
      ? { x: (anchor.position?.x ?? 0) + NODE_W + 70, y: (anchor.position?.y ?? 0) + portIndex * 110 }
      : { x: 100 + wf.nodes.length * 30, y: 100 + wf.nodes.length * 30 });

  const node = {
    id: newId(),
    type,
    position: { x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10 },
    config: Object.fromEntries((def?.options ?? []).filter((o) => o.default !== '').map((o) => [o.key, o.default])),
  };
  if (type === 'record') {
    node.config.alias = suggestAlias(node.config.sobject);
    node.config.fields = [{ name: 'Name', type: 'text', options: { mode: node.config.sobject === 'Account' ? 'company' : 'name' } }];
  }
  Object.assign(node.config, config);

  updateWorkflow((w) => {
    w.nodes.push(node);
    if (autoConnect && anchor && freePort && def?.inputs) w.edges.push({ from: anchor.id, fromPort: freePort, to: node.id });
  });
  select({ kind: 'node', id: node.id });
  ensureVisible(node);
  return node;
}

/** Pan just enough to bring a node fully into view (keeps the user's zoom level). */
function ensureVisible(node) {
  const r = canvasEl.getBoundingClientRect();
  const pad = 30;
  const left = node.position.x * view.scale + view.x;
  const top = node.position.y * view.scale + view.y;
  const right = left + NODE_W * view.scale;
  const bottom = top + 80 * view.scale;
  if (right > r.width - pad) view.x -= right - (r.width - pad);
  if (left < pad) view.x += pad - left;
  if (bottom > r.height - pad) view.y -= bottom - (r.height - pad);
  if (top < pad) view.y += pad - top;
  applyView();
}

export function deleteSelection() {
  const s = state.selection;
  if (!s) return;
  if (s.kind === 'node') {
    const node = state.workflow.nodes.find((n) => n.id === s.id);
    if (!node || node.type === 'start') return;
    updateWorkflow((wf) => {
      wf.nodes = wf.nodes.filter((n) => n.id !== s.id);
      wf.edges = wf.edges.filter((e) => e.from !== s.id && e.to !== s.id);
    });
  } else {
    updateWorkflow((wf) => {
      wf.edges = wf.edges.filter((e) => edgeId(e) !== s.id);
    });
  }
  select(null);
}

export function duplicateSelection() {
  const s = state.selection;
  if (s?.kind !== 'node') return;
  const node = state.workflow.nodes.find((n) => n.id === s.id);
  if (!node || node.type === 'start') return;
  const copy = structuredClone(node);
  copy.id = newId();
  copy.position = { x: (node.position?.x ?? 0) + 30, y: (node.position?.y ?? 0) + 30 };
  if (copy.type === 'record') copy.config.alias = suggestAlias(copy.config.sobject);
  updateWorkflow((wf) => wf.nodes.push(copy));
  select({ kind: 'node', id: copy.id });
}
