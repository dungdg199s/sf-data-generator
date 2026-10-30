// One-line summaries and run-stat chips for step cards (moved out of the old canvas.js).
// Record, Query, Chọn bản ghi, Lặp and Rẽ nhánh have their own sentence; other step types fall
// back to the options marked `summary: true` in /api/meta.

import { state, nodeType, queryResultOf, stepById, slotKeys, currentEstimate } from './store.js';
import { walkSteps } from '/shared/workflow-tree.js';
import { START_ID } from './layout.js';
import { selectFields, soqlSobject } from '/shared/soql.js';
import { exposesOf } from '/shared/scope.js';

const opLabel = (type, key, value) => nodeType(type)?.options.find((o) => o.key === key)?.choices?.find((x) => x.value === value)?.label ?? value;
const PICK_MODE = { random: 'ngẫu nhiên', unique: 'không lặp', sequential: 'lần lượt' };

export function stepSummary(step) {
  const c = step.config ?? {};
  switch (step.type) {
    case 'record':
      return `${c.sobject || '?'} × ${c.count ?? 1} · ${(c.fields ?? []).length} field`;
    case 'loop': {
      // Each record of a pool (0010): "Mỗi bản ghi trong accs → acc · {{loop.index}}".
      if (c.mode === 'each') {
        return c.from ? `Mỗi bản ghi trong ${c.from} → ${c.itemAlias || '?'} · {{${c.alias || 'loop'}.index}}` : 'Mỗi bản ghi trong ? · chọn pool';
      }
      // Same fallbacks as the executor (server/workflow/executor.js) for a missing value.
      const times = (c.mode ?? 'fixed') === 'range' ? `${c.min ?? 1}–${c.max ?? 1} lần` : `${c.count ?? 0} lần`;
      return `${times} · {{${c.alias || 'loop'}.index}}`;
    }
    case 'query': {
      // Builder: "Account · 2 field · ≤200"; SOQL: the start of the statement. Last run: "· đọc 200" / "· mẫu 5".
      const soql = (c.mode ?? 'builder') === 'soql';
      const text = soql
        ? (String(c.soql ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'SOQL trống')
        : `${soqlSobject(c) || '?'} · ${selectFields(c).fields.length} field · ≤${c.limit ?? 200}`;
      const q = queryResultOf(step.id);
      return q ? `${text} · ${q.source === 'sample' ? 'mẫu' : 'đọc'} ${q.count}` : text;
    }
    case 'pick': {
      const base = `${PICK_MODE[c.mode ?? 'random'] ?? c.mode} từ ${c.from || '?'}`;
      if ((c.filter ?? 'none') !== 'compare') return base;
      return `${base} · lọc ${c.filterField || '?'} ${opLabel('pick', 'filterOp', c.filterOp ?? 'eq')} ${c.filterValue ?? ''}`.trim();
    }
    case 'branch': {
      if ((c.kind ?? 'chance') === 'chance') return `${Math.round((c.probability ?? 0.5) * 100)}% đi nhánh Đúng`;
      return `${c.left ?? ''} ${opLabel('branch', 'op', c.op)} ${c.right ?? ''}`;
    }
    default: {
      const defs = (nodeType(step.type)?.options ?? []).filter((o) => o.summary);
      return defs.map((d) => c[d.key] ?? d.default).filter((v) => v !== undefined && v !== '').join(' · ');
    }
  }
}

/**
 * The name shown next to the type label: the name the step exposes (`exposes.name` of the
 * catalogue — record / pool alias, loop variable with its default); a Record without alias shows
 * none. With several names in effect, the last one set: a Lặp `each` shows the record it loops
 * over (`itemAlias`, design 0010), the name the steps inside use.
 */
export function stepAlias(step) {
  const active = exposesOf(nodeType(step?.type), step?.config);
  for (let i = active.length - 1; i >= 0; i--) {
    const key = active[i].ex.name?.key;
    if (key && step.config?.[key]) return step.config[key];
  }
  return active[0]?.ex.name?.default || '';
}

/** "Record "acc"", "Lặp "i"", "Rẽ nhánh" — for toasts and dialogs. */
export function stepLabel(step) {
  const label = nodeType(step?.type)?.label ?? step?.type ?? '?';
  const alias = step ? stepAlias(step) : '';
  return alias ? `${label} "${alias}"` : label;
}

/** Chip text from stats.byStep of the last preview, or null. */
export function statChip(step, byStep) {
  const s = byStep?.[step.id];
  if (!byStep) return null;
  if (!s) return step.disabled ? null : step.type === 'record' ? '0 bản ghi' : null;
  if (step.type === 'record') return `${s.records} bản ghi`;
  if (step.type === 'loop') return `${s.iterations ?? 0} lần lặp`;
  if (step.type === 'branch') return `Đúng ${s.true ?? 0} · Sai ${s.false ?? 0}`;
  if (step.type === 'query') {
    const q = queryResultOf(step.id);
    return q?.source === 'sample' ? `${q.count} bản ghi mẫu` : `${q?.count ?? s.rows ?? 0} bản ghi đọc từ org`;
  }
  if (step.type === 'pick') return `chọn ${s.picked ?? 0} lần${s.skipped ? ` · bỏ qua ${s.skipped}` : ''}`;
  return s.records ? `${s.records} bản ghi` : `${s.runs} lần chạy`;
}

/** A record count of the estimate (design 0012 H), vi-VN: "12", "12,5", "1.250", "> 200.000". */
export function formatEstimate(n) {
  const hard = state.meta?.limits?.maxRecordsHard ?? 200000;
  if (n > hard) return `> ${hard.toLocaleString('vi-VN')}`;
  return n.toLocaleString('vi-VN', { maximumFractionDigits: n < 100 ? 1 : 0 });
}

/**
 * Estimate chip of a Record card before a run (or once the result is stale): { text, title } —
 * "12 bản ghi" when certain, else "≈ 12,5 bản ghi" with the range in the title. Null for other
 * step types (no estimate chip on frames) and turned-off steps.
 */
export function estimateChip(step) {
  if (step?.type !== 'record') return null;
  const e = currentEstimate().byStep[step.id];
  if (!e) return null;
  return {
    text: `${e.exact ? '' : '≈ '}${formatEstimate(e.records)} bản ghi`,
    title: e.exact ? 'Ước tính từ cấu hình, chưa chạy.' : `Ước tính từ cấu hình, chưa chạy (khoảng ${formatEstimate(e.min)}–${formatEstimate(e.max)}).`,
  };
}

/**
 * Start card (design 0012 H): "≈ 1.250 bản ghi · ≤ 50.000", and a warning when the expected
 * count is over the run's limit. → { text, over: { label, title } | null }
 */
export function startEstimate() {
  const max = Number(state.workflow.settings?.maxRecords ?? state.meta?.limits.maxRecordsDefault);
  const t = currentEstimate().total;
  const text = `${t.exact ? '' : '≈ '}${formatEstimate(t.records)} bản ghi · ≤ ${max.toLocaleString('vi-VN')}`;
  const over = t.records > max
    ? {
      label: 'Ước tính vượt giới hạn',
      title: `Ước tính khoảng ${formatEstimate(t.records)} bản ghi, quá giới hạn ${max.toLocaleString('vi-VN')} mỗi lần chạy. Giảm số lần lặp hoặc tăng giới hạn ở bước Bắt đầu.`,
    }
    : null;
  return { text, over };
}

/** Name of a step in labels: its alias, else its type label. */
export const stepName = (step) => stepAlias(step) || nodeType(step.type)?.label || step.type;

/** aria-label of the box of an empty slot: the catalogue's `empty` text, else "… vào nhánh <label>". */
export function emptySlotLabel(def) {
  if (def?.empty) return def.empty;
  return def?.label ? `Thêm bước vào nhánh ${def.label}` : 'Thêm bước ở đây';
}

/** aria-label of the "+" at `index` of `list`: "Thêm bước sau "acc"" (both views). */
export function addPointLabel(list, index) {
  const isStep = (s) => s && typeof s === 'object' && !Array.isArray(s);
  const after = isStep(list[index - 1]) ? list[index - 1] : null;
  const before = isStep(list[index]) ? list[index] : null;
  if (after) return `Thêm bước sau "${stepName(after)}"`;
  if (before) return `Thêm bước trước "${stepName(before)}"`;
  return 'Thêm bước ở đây';
}

/**
 * Current issues grouped by step id: Map id → { errors, warnings }. Issues without a (known)
 * step go to the Start card (START_ID).
 */
export function issuesByStep() {
  const map = new Map();
  for (const [level, list] of [['errors', state.issues.errors], ['warnings', state.issues.warnings]]) {
    for (const i of list) {
      const key = i.nodeId && stepById(i.nodeId) ? i.nodeId : START_ID;
      const entry = map.get(key) ?? { errors: [], warnings: [] };
      entry[level].push(i);
      map.set(key, entry);
    }
  }
  return map;
}

/** Issues of the steps inside a container (a collapsed frame shows them): counts and the first step. */
export function innerIssues(id, issues) {
  const step = stepById(id);
  const out = { errors: 0, warnings: 0, first: null };
  if (!step) return out;
  walkSteps(Object.values(step.slots ?? {}).flat(), (s) => {
    const i = issues.get(s.id);
    if (!i) return;
    out.errors += i.errors.length;
    out.warnings += i.warnings.length;
    if (!out.first && (i.errors.length || i.warnings.length)) out.first = s.id;
  }, slotKeys);
  return out;
}

/** Number of steps inside a container. */
export function innerCount(step) {
  let n = 0;
  walkSteps(Object.values(step.slots ?? {}).flat(), () => { n++; }, slotKeys);
  return n;
}
