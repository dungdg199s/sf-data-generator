// Data for the variable picker and the chip strip (design 0005): what can be inserted at a
// step/field, with type labels and sample values from the last preview. Everything comes from
// the shared scope analysis (store.currentScope → shared/scope.js analyzeScope) and /api/meta;
// only the `this` group is built here from the current field order (fields above the one being
// edited), so it never lags behind a field that was just added or moved.

import { state, currentScope, fieldType, stepById, runKey } from './store.js';
import { stepAlias } from './summary.js';
import { tokenize } from '/shared/scope.js';

export { tokenize };

export const MAX_ROWS = 200;

const valueTypeLabel = (vt) => state.meta?.syntax?.valueTypes?.find((v) => v.value === vt)?.label ?? vt ?? '';

/** Type label of a member: field type label ("Currency"), else the value type ("Số"). */
export function typeLabel(member) {
  return (member.type && fieldType(member.type)?.label) || valueTypeLabel(member.valueType ?? 'string');
}

let firstCache = { result: null, map: new Map() };
/**
 * First record of every step in the last preview: generated records, the first row each Query
 * read (`queries[]`) and the first record each Chọn bản ghi picked (`samples`), design 0006.
 */
function firstRecords() {
  if (firstCache.result !== state.result) {
    const map = new Map();
    for (const r of state.result?.records ?? []) if (!map.has(r.nodeId)) map.set(r.nodeId, r);
    for (const q of state.result?.queries ?? []) if (q.records?.length) map.set(q.nodeId, { fields: q.records[0] });
    for (const [id, fields] of Object.entries(state.result?.samples ?? {})) map.set(id, { fields });
    firstCache = { result: state.result, map };
  }
  return firstCache.map;
}

/** The workflow changed since the last preview: samples are shown dimmed. */
export function samplesStale() {
  return Boolean(state.result) && state.lastRunKey !== runKey(state.workflow, state.result.seed);
}

export function formatSample(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return `"${v.length > 24 ? `${v.slice(0, 24)}…` : v}"`;
  if (typeof v === 'object' && v.$ref) return `→ ${v.$ref}`;
  if (typeof v === 'object' && 'latitude' in v && 'longitude' in v) return `${Number(v.latitude).toFixed(2)}, ${Number(v.longitude).toFixed(2)}`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 26);
  return String(v);
}

/**
 * Sample for member path `keys` of step `nodeId`: { text, title, stale } or null when there
 * is no preview yet. Built-ins and loop variables use their `example` instead.
 */
export function sampleFor(nodeId, keys) {
  if (!state.result) return null;
  const rec = firstRecords().get(nodeId);
  let v = rec?.fields;
  let found = Boolean(rec);
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== 'object' || !(k in v)) {
      found = false;
      break;
    }
    v = v[k];
  }
  if (!found) return { text: '—', title: 'Chưa có trong lần xem trước.', stale: false };
  const stale = samplesStale();
  return { text: formatSample(v), title: stale ? 'Từ lần xem trước; workflow đã thay đổi sau đó.' : 'Từ lần xem trước.', stale };
}

function flatten(members, prefix = []) {
  const out = [];
  for (const m of members ?? []) {
    out.push({ m, keys: [...prefix, m.key] });
    if (m.members?.length && m.valueType !== 'reference') out.push(...flatten(m.members, [...prefix, m.key]));
  }
  return out;
}

function item(group, m, keys, nodeId) {
  const sample = m.example ? { text: m.example, title: m.label ?? '' } : m.builtin ? null : sampleFor(nodeId, keys);
  const valueType = m.valueType ?? (m.type && fieldType(m.type)?.valueType) ?? 'string';
  return { path: [group.name, ...keys].join('.'), key: keys.join('.'), typeLabel: typeLabel(m), help: m.label ?? '', sample, valueType };
}

/**
 * Sample of a run variable (design 0013 G): the value it had in the last preview (`run.seed` is
 * that preview's seed), else the catalogue's example (none for the seed: it changes every run
 * unless fixed).
 */
function runSample(m) {
  const r = state.result;
  // An empty Seed box: every run draws a new seed.
  const random = !(document.getElementById('seed')?.value.trim());
  const seedNote = random ? ' (đổi mỗi lần chạy nếu không giữ seed)' : '';
  if (!r) return m.key === 'seed' ? { text: '—', title: `Seed của lần chạy${seedNote}. Bấm Xem trước để thấy giá trị.` } : m.example ? { text: m.example, title: `Ví dụ. ${m.label ?? ''}` } : null;
  const iso = Number.isFinite(Number(r.now)) ? new Date(Number(r.now)).toISOString() : null;
  const v = m.key === 'seed' ? r.seed : m.key === 'now' ? iso : m.key === 'today' ? iso?.slice(0, 10) : undefined;
  if (v === undefined || v === null) return m.example ? { text: m.example, title: m.label ?? '' } : null;
  const stale = samplesStale();
  const title = stale ? 'Từ lần xem trước; workflow đã thay đổi sau đó.' : 'Từ lần xem trước.';
  return { text: m.key === 'seed' ? String(v) : formatSample(v), title: m.key === 'seed' ? `${title}${seedNote}` : title, stale };
}

/** Value types a number option takes (design 0013 B): Số, and org fields whose type is unknown. */
const NUMBER_TYPES = new Set(['number', 'any']);

const BADGES = {
  last: ['bản ghi cuối', 'Tạo trong vòng lặp đã kết thúc: giá trị là bản ghi của lần lặp cuối. Lookup "Ngẫu nhiên" sẽ chọn trong tất cả.'],
};

/**
 * Groups for the picker at `stepId` (field `fieldIndex` of a record step, or a step option):
 * → { groups: [{ id, nodeType, name, label, badge?, badgeTitle?, note?, items: [...] }], hidden: [{ text }] }
 * `mode: 'number'` (a number option, design 0013 B) keeps only Số variables and org fields of
 * unknown type; groups left empty are dropped. The run variables (`run`, "Lần chạy") come last.
 */
export function groupsFor(stepId, fieldIndex, { mode } = {}) {
  const scope = currentScope();
  const step = stepById(stepId);
  const here = scope.at[stepId];
  const groups = [];
  const hidden = [];
  if (step && fieldIndex !== undefined) {
    const fields = step.config?.fields ?? [];
    const self = scope.sources[stepId];
    const g = { id: 'this', nodeType: step.type, name: 'this', label: `${step.config?.sobject || '?'} (bản ghi đang tạo)`, items: [] };
    for (const b of self?.members.filter((m) => m.builtin) ?? []) g.items.push(item(g, b, [b.key], stepId));
    fields.forEach((f, i) => {
      if (!f?.name || i === fieldIndex) return;
      const m = self?.members.find((x) => x.key === f.name && !x.builtin) ?? { key: f.name, type: f.type };
      if (i < fieldIndex) for (const { m: mm, keys } of flatten([m])) g.items.push(item(g, mm, keys, stepId));
      else hidden.push({ text: `this.${f.name} — nằm dưới field "${fields[fieldIndex]?.name ?? ''}", kéo lên để dùng` });
    });
    groups.push(g);
  }
  for (const v of here?.visible ?? []) {
    const src = scope.sources[v.source];
    if (!src) continue;
    const g = {
      // Run variables are neutral like the built-ins ($n): the Start colour (docs/ui-design-system.md §3).
      id: src.id ?? src.nodeId, nodeType: src.global ? 'start' : src.nodeType, name: src.name, label: src.label || src.sobject || '', items: [],
      ...(v.certainty === 'last' ? { badge: BADGES.last[0], badgeTitle: BADGES.last[1] } : {}),
      ...(v.certainty === 'maybe' ? { badge: 'có thể trống', badgeTitle: v.note ?? '' } : {}),
    };
    const builtins = src.members.filter((m) => m.builtin);
    const fields = src.current === 'none' ? [] : src.members.filter((m) => !m.builtin);
    if (src.current === 'none') {
      // Inside a Lặp over each record of this pool, its record is the way to a field (0010 review).
      const item = (here?.visible ?? []).map((x) => scope.sources[x.source]).find((x) => x?.current === 'item' && x.from === src.name && x.name);
      g.note = item ? `không có bản ghi hiện tại: dùng bản ghi đang lặp "${item.name}"` : 'không có bản ghi hiện tại: dùng bước Chọn bản ghi';
    }
    if (src.current === 'picked') g.note = 'bản ghi vừa chọn';
    if (src.current === 'item') g.note = 'bản ghi đang lặp';
    // The record a Lặp `each` loops over (0010) shows the first record of its pool as sample.
    const sampleId = src.current === 'item' ? src.root ?? src.nodeId : src.nodeId;
    for (const b of builtins) g.items.push(item(g, b, [b.key], sampleId));
    for (const { m, keys } of flatten(fields)) {
      const it = item(g, m, keys, sampleId);
      if (src.global) it.sample = runSample(m);
      g.items.push(it);
    }
    groups.push(g);
  }
  for (const hdn of here?.hidden ?? []) {
    const src = scope.sources[hdn.source];
    if (!src || src.nodeId === stepId) continue;
    hidden.push({ text: `${src.name} · ${src.label || src.sobject || ''} — ${hdn.note}` });
  }
  // Only the usable groups are filtered by type: "Không dùng được ở đây" keeps every source.
  if (mode === 'number') {
    for (const g of groups) g.items = g.items.filter((it) => NUMBER_TYPES.has(it.valueType));
    return { groups: groups.filter((g) => g.items.length), hidden };
  }
  return { groups, hidden };
}

/** Score of an item for `q` (lower first); null when it does not match. */
export function matchScore(it, group, q) {
  if (!q) return 1;
  const s = q.toLowerCase();
  const key = it.key.toLowerCase();
  const path = it.path.toLowerCase();
  if (key.startsWith(s) || path.startsWith(s)) return 0;
  const hay = `${path} ${key} ${it.typeLabel} ${group.label}`.toLowerCase();
  return hay.includes(s) ? 1 : null;
}

/** "con › Title" for each place a reference lives (toasts after delete/rename). */
export function placesText(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const step = stepById(r.nodeId);
    const where = r.field.startsWith('fields.') ? r.field.slice(7) : step ? optionLabel(step, r.option) : r.field;
    const text = `${(step && stepAlias(step)) || r.nodeId} › ${where}`;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function optionLabel(step, key) {
  return state.meta?.nodeTypes.find((t) => t.type === step.type)?.options.find((o) => o.key === key)?.label ?? key;
}

const refIndex = new WeakMap(); // scope → Map("nodeId|field|option|path" → ref)
/** The analysed reference at one place of the workflow (for chip colours / tooltips). */
export function refAt(nodeId, field, option, path) {
  const scope = currentScope();
  let index = refIndex.get(scope);
  if (!index) {
    index = new Map();
    for (const r of scope.refs) {
      const k = `${r.nodeId}|${r.field}|${r.option}|${r.path}`;
      if (!index.has(k)) index.set(k, r);
    }
    refIndex.set(scope, index);
  }
  return index.get(`${nodeId}|${field}|${option}|${path}`) ?? null;
}
