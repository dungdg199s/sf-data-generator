// One-line summaries and run-stat chips for step cards (moved out of the old canvas.js).
// Record, Lặp and Rẽ nhánh have their own sentence; other step types (0006) fall back to the
// options marked `summary: true` in /api/meta.

import { nodeType } from './store.js';

export function stepSummary(step) {
  const c = step.config ?? {};
  switch (step.type) {
    case 'record':
      return `${c.sobject || '?'} × ${c.count ?? 1} · ${(c.fields ?? []).length} field`;
    case 'loop': {
      const times = (c.mode ?? 'fixed') === 'range' ? `${c.min ?? 1}–${c.max ?? 5} lần` : `${c.count ?? 3} lần`;
      return `${times} · {{${c.alias || 'loop'}.index}}`;
    }
    case 'branch': {
      if ((c.kind ?? 'chance') === 'chance') return `${Math.round((c.probability ?? 0.5) * 100)}% đi nhánh Đúng`;
      const op = nodeType('branch')?.options.find((o) => o.key === 'op')?.choices.find((x) => x.value === c.op)?.label ?? c.op;
      return `${c.left ?? ''} ${op} ${c.right ?? ''}`;
    }
    default: {
      const defs = (nodeType(step.type)?.options ?? []).filter((o) => o.summary);
      return defs.map((d) => c[d.key] ?? d.default).filter((v) => v !== undefined && v !== '').join(' · ');
    }
  }
}

/** The name shown next to the type label: record alias or loop variable. */
export function stepAlias(step) {
  if (step.type === 'record') return step.config?.alias || '';
  if (step.type === 'loop') return step.config?.alias || 'loop';
  return '';
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
  return s.records ? `${s.records} bản ghi` : `${s.runs} lần chạy`;
}
