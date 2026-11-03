// Field-type generator registry. To add a Salesforce type: write a generator object
// (see docs/field-types.md for the contract) and add it to GENERATORS below.

import { resolveOptions, allOptions } from './common.js';
import * as text from './text.js';
import * as num from './number.js';
import * as choice from './choice.js';
import * as dt from './date.js';
import * as reference from './reference.js';
import * as misc from './misc.js';

const GENERATORS = [
  text.text,
  text.textarea,
  text.longtextarea,
  text.richtextarea,
  text.encryptedtext,
  text.email,
  text.phone,
  text.url,
  text.autonumber,
  num.number,
  num.currency,
  num.percent,
  choice.checkbox,
  choice.picklist,
  choice.multipicklist,
  dt.date,
  dt.datetime,
  dt.time,
  reference.lookup,
  reference.masterdetail,
  misc.geolocation,
  misc.template,
  misc.copy,
  misc.constant,
];

const registry = new Map(GENERATORS.map((g) => [g.type, g]));

const UNIQUE_ATTEMPTS = 100;

export function getGenerator(type) {
  return registry.get(type);
}

export function listGenerators() {
  return GENERATORS;
}

/** Kinds of value a field or variable holds (meta.syntax.valueTypes; design 0005). */
export const VALUE_TYPES = [
  { value: 'string', label: 'Chuỗi' },
  { value: 'number', label: 'Số' },
  { value: 'boolean', label: 'Đúng/Sai' },
  { value: 'date', label: 'Ngày' },
  { value: 'datetime', label: 'Ngày giờ' },
  { value: 'time', label: 'Giờ' },
  { value: 'reference', label: 'Tham chiếu' },
  { value: 'object', label: 'Đối tượng' },
  { value: 'any', label: 'Từ org' },
];

/** Serializable description for the UI: types, categories and option schemas. */
export function describeGenerators() {
  return GENERATORS.map((g) => ({
    type: g.type,
    label: g.label,
    category: g.category,
    valueType: g.valueType ?? 'string',
    ...(g.members ? { members: g.members } : {}),
    options: allOptions(g),
  }));
}

/**
 * Generate one field value.
 * ctx: { rng, now, scope, record, fieldName, fieldState, n }
 *   n is the number of the record being generated (`n` in alias#n, for {{this.$n}}).
 *   fieldState is a per-(node, field) object that persists for the whole run
 *   (used for uniqueness sets and counters).
 */
export function generateValue(field, ctx) {
  const gen = registry.get(field.type);
  if (!gen) throw new Error(`Field ${field.name}: kiểu "${field.type}" không được hỗ trợ.`);
  const o = resolveOptions(gen, field.options);
  if (gen.nullable !== false && o.nullRatio > 0 && ctx.rng.bool(o.nullRatio)) return null;

  if (!o.unique) return gen.generate(o, ctx);

  const seen = (ctx.fieldState.seen ??= new Set());
  for (let i = 0; i < UNIQUE_ATTEMPTS; i++) {
    const v = gen.generate(o, ctx);
    const key = typeof v === 'object' ? JSON.stringify(v) : v;
    if (!seen.has(key)) {
      seen.add(key);
      return v;
    }
  }
  throw new Error(
    `Field ${field.name}: không tạo được giá trị duy nhất sau ${UNIQUE_ATTEMPTS} lần thử (đã có ${seen.size} giá trị). Hãy nới rộng option hoặc tắt "Giá trị duy nhất".`,
  );
}

/**
 * Integer / number options of a field outside their declared `min` / `max` (review 0012 S3: a
 * run and POST /api/field-samples refuse them, so a huge word count cannot block the server).
 * → [{ key, message }]
 */
export function optionRangeIssues(field) {
  const gen = registry.get(field?.type);
  const out = [];
  for (const d of gen ? allOptions(gen) : []) {
    if (d.kind !== 'integer' && d.kind !== 'number') continue;
    const raw = field.options?.[d.key];
    if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)) {
      const range = d.min !== undefined && d.max !== undefined ? `từ ${d.min} đến ${d.max}` : d.max !== undefined ? `tối đa ${d.max}` : `ít nhất ${d.min}`;
      out.push({ key: d.key, message: `Field "${field.name}": "${d.label}" phải ${range} (đang là ${raw}). Sửa ô này trong tùy chọn của field.` });
    }
  }
  return out;
}
