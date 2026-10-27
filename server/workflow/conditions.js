import { resolvePath } from './paths.js';

// Branch conditions are structured data (never eval'd strings), so the UI can build them
// with plain form controls and the server can validate them up front.

export function evaluateCondition(config, scope, rng) {
  if ((config.kind ?? 'chance') === 'chance') return rng.bool(Number(config.probability ?? 0.5));

  const left = resolvePath(config.left, scope, undefined);
  const right = config.right;
  const ln = toNumber(left);
  const rn = toNumber(right);
  const numeric = ln !== null && rn !== null;

  switch (config.op) {
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
      throw new Error(`Phép so sánh "${config.op}" không hợp lệ.`);
  }
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
