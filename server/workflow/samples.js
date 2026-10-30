// Sample values of one field for the inspector (design 0012 E, POST /api/field-samples): a few
// records made of the step's fields up to and including that field (so `{{this.FirstName}}` and
// Email "theo tên" see the fields above), with a seeded rng and the given `now`, in an empty
// scope (no other step, no loop). No I/O, no org. The client only asks for fields that do not
// depend on another step; a reference to one gives an empty string (template) or is skipped.

import { createRandom } from '../random.js';
import { generateValue, getGenerator } from '../generators/index.js';

export const SAMPLE_LIMITS = { maxFields: 500, maxCount: 5, defaultCount: 3 };

/** A 400 / 422 for the HTTP layer: { status, message, issues? }. */
const bad = (status, message, issues) => Object.assign(new Error(message), { status, ...(issues ? { issues } : {}) });

/**
 * @param body { fields: [{ name, type, options }], index, seed?, now, count? }
 * → { values: [v1, v2, v3] } (`null` stays null). Throws { status: 400 } for a malformed request,
 *   { status: 422, issues: [{ field: 'fields.<Name>', message }] } for an unknown type of the
 *   field, { status: 422 } with the generator's message when generating it fails (unique values
 *   exhausted…).
 */
export function fieldSamples(body) {
  const fields = body?.fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > SAMPLE_LIMITS.maxFields) {
    throw bad(400, `"fields" phải là danh sách từ 1 đến ${SAMPLE_LIMITS.maxFields} field.`);
  }
  const index = body.index;
  if (!Number.isInteger(index) || index < 0 || index >= fields.length) throw bad(400, '"index" phải là vị trí của một field trong "fields".');
  if (!(typeof body.now === 'number' && Number.isFinite(body.now))) throw bad(400, 'Tham số now không hợp lệ.');
  const seed = body.seed === undefined || body.seed === null || body.seed === '' ? 1 : body.seed;
  if (typeof seed !== 'number' && typeof seed !== 'string') throw bad(400, 'Seed không hợp lệ.');
  const raw = Number(body.count ?? SAMPLE_LIMITS.defaultCount);
  const count = Number.isFinite(raw) ? Math.min(SAMPLE_LIMITS.maxCount, Math.max(1, Math.trunc(raw))) : SAMPLE_LIMITS.defaultCount;

  const list = fields.slice(0, index + 1).map((f) => (f && typeof f === 'object' ? f : {}));
  const target = list[index];
  const key = `fields.${target.name ?? ''}`;
  if (typeof target.name !== 'string' || !target.name) throw bad(422, 'Field chưa có tên.', [{ field: key, message: 'Field chưa có tên. Đặt tên field trước.' }]);
  if (!getGenerator(target.type)) {
    const message = `Field "${target.name}": kiểu "${target.type}" không được hỗ trợ.`;
    throw bad(422, message, [{ field: key, message }]);
  }

  const rng = createRandom(seed);
  const states = list.map(() => ({}));
  const scope = { current: {}, all: {}, vars: {} };
  const values = [];
  for (let n = 1; n <= count; n++) {
    const record = {};
    list.forEach((f, i) => {
      if (i < index && (!f.name || !getGenerator(f.type))) return;
      const ctx = { rng, now: body.now, scope, record, fieldName: f.name, fieldState: states[i], n };
      if (i < index) {
        // A field above that cannot be made here (a Lookup, a reference to another step) is left out.
        try {
          record[f.name] = generateValue(f, ctx);
        } catch {
          // ignored: only the asked field's errors are reported
        }
        return;
      }
      try {
        record[f.name] = generateValue(f, ctx);
      } catch (e) {
        throw bad(422, e.message);
      }
    });
    values.push(record[target.name] ?? null);
  }
  return { values };
}
