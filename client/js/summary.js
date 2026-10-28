// One-line summaries and run-stat chips for step cards (moved out of the old canvas.js).
// Record, Query, Chọn bản ghi, Lặp and Rẽ nhánh have their own sentence; other step types fall
// back to the options marked `summary: true` in /api/meta.

import { nodeType, queryResultOf } from './store.js';
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
