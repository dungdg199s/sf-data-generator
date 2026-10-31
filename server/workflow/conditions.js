import { resolvePath, renderTemplate } from './paths.js';

// Branch conditions are structured data (never eval'd strings), so the UI can build them
// with plain form controls and the server can validate them up front.

/**
 * Design 0013 A: `right` may hold variables ({{opp.Amount}}), rendered like a template — only
 * when it contains "{{", so a fixed value compares exactly as before. A Lookup on the left
 * (`{ $ref }`) compares by its ref (`acc#3`), like the filter of Chọn bản ghi.
 */
export function evaluateCondition(config, scope, rng) {
  if ((config.kind ?? 'chance') === 'chance') return rng.bool(Number(config.probability ?? 0.5));

  const v = resolvePath(config.left, scope, undefined);
  const left = v && typeof v === 'object' && v.$ref ? v.$ref : v;
  const r = config.right;
  const right = typeof r === 'string' && r.includes('{{') ? renderTemplate(r, scope, undefined) : r;
  return compareValues(left, config.op, right);
}

/**
 * Compare two values with one of CONDITION_OPS (server/workflow/nodes.js): numerically when
 * both are numbers (or numeric strings), else as strings. Shared by Rẽ nhánh and the filter of
 * Chọn bản ghi (design 0006).
 */
export function compareValues(left, op, right) {
  const ln = toNumber(left);
  const rn = toNumber(right);
  const numeric = ln !== null && rn !== null;

  switch (op) {
    case 'eq':
      return numeric ? ln === rn : String(left ?? '') === String(right ?? '');
    case 'neq':
      return numeric ? ln !== rn : String(left ?? '') !== String(right ?? '');
    case 'gt':
      return numeric ? ln > rn : String(left ?? '') > String(right ?? '');
    case 'gte':
      return numeric ? ln >= rn : String(left ?? '') >= String(right ?? '');
    case 'lt':
      return numeric ? ln < rn : String(left ?? '') < String(right ?? '');
    case 'lte':
      return numeric ? ln <= rn : String(left ?? '') <= String(right ?? '');
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''));
    case 'empty':
      return left === null || left === undefined || left === '';
    case 'notEmpty':
      return !(left === null || left === undefined || left === '');
    case 'divisibleBy':
      return numeric && rn !== 0 && ln % rn === 0;
    default:
      throw new Error(`Phép so sánh "${op}" không hợp lệ.`);
  }
}

/** A finite number, or a numeric string as a number; anything else → null. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
