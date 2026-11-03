// Example values of one field for the inspector (design 0012 E, POST /api/field-samples): a few
// records made only of the fields of a Record step up to and including that one (so {{this.X}}
// and Email "theo tên" see the fields above), with the seeded rng and the `now` the browser sends.
// No I/O, no org, no scope: the browser asks only for fields that do not read other steps (a
// template naming another step gives ''). Same generators as a run (server/generators).

import { generateValue, getGenerator, optionRangeIssues } from '../generators/index.js';
import { createRandom } from '../random.js';
import { NOW_MESSAGE } from './executor.js';

// timeMs (review 0012 S3): a request that takes longer stops with a 422 instead of holding the server.
export const FIELD_SAMPLES_LIMITS = { maxFields: 500, maxCount: 5, defaultCount: 3, timeMs: 1000 };
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const unprocessable = (error, issues) => Object.assign(new Error(error), { status: 422, ...(issues ? { issues } : {}) });

/**
 * body { sobject?, fields: [{ name, type, options }], index, seed?, now, count? } → { values }.
 * Throws a 422 error ({ status, message, issues? }) for a bad request or a generator error.
 */
export function fieldSamples(body) {
  const fields = body?.fields;
  if (!Array.isArray(fields) || !fields.length) throw unprocessable('Thiếu danh sách field ("fields").');
  if (fields.length > FIELD_SAMPLES_LIMITS.maxFields) throw unprocessable(`Tối đa ${FIELD_SAMPLES_LIMITS.maxFields} field mỗi lần.`);
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= fields.length) throw unprocessable('"index" phải là vị trí của một field trong "fields".');
  const used = fields.slice(0, index + 1);
  const issues = [];
  for (const f of used) {
    const key = `fields.${f?.name ?? ''}`;
    if (!f || typeof f !== 'object' || !API_NAME.test(String(f.name ?? ''))) issues.push({ field: key, message: `Tên field "${f?.name ?? ''}" không hợp lệ. Dùng API name, ví dụ Industry.` });
    else if (!getGenerator(f.type)) issues.push({ field: key, message: `Field "${f.name}": kiểu "${f.type}" không được hỗ trợ. Chọn kiểu khác trong danh sách.` });
    else if (f.options !== undefined && (typeof f.options !== 'object' || f.options === null || Array.isArray(f.options))) issues.push({ field: key, message: `Field "${f.name}": "options" phải là một object.` });
    else for (const i of optionRangeIssues(f)) issues.push({ field: key, message: i.message });
  }
  if (issues.length) throw unprocessable(issues[0].message, issues);
  const count = Math.min(FIELD_SAMPLES_LIMITS.maxCount, Math.max(1, Math.trunc(Number(body.count ?? FIELD_SAMPLES_LIMITS.defaultCount)) || FIELD_SAMPLES_LIMITS.defaultCount));
  const seed = typeof body.seed === 'number' || (typeof body.seed === 'string' && body.seed !== '') ? body.seed : 1;
  const now = Number(body.now);
  // Same rule and message as a run (review 0012 S4): outside what a Date holds is refused.
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) throw unprocessable(NOW_MESSAGE);
  const deadline = performance.now() + FIELD_SAMPLES_LIMITS.timeMs;
  const rng = createRandom(seed);
  const iso = new Date(now).toISOString();
  const scope = { current: {}, all: {}, vars: {}, run: { seed, now: iso, today: iso.slice(0, 10) } };
  const states = used.map(() => ({}));
  const values = [];
  for (let n = 1; n <= count; n++) {
    const record = {};
    used.forEach((f, i) => {
      if (performance.now() > deadline) throw unprocessable(`Tạo ví dụ quá ${FIELD_SAMPLES_LIMITS.timeMs / 1000} giây nên đã dừng. Giảm số từ / số câu hoặc số field phía trên.`);
      try {
        record[f.name] = generateValue({ ...f, options: f.options ?? {} }, { rng, now, scope, record, fieldName: f.name, fieldState: states[i], n });
      } catch (e) {
        throw unprocessable(e.message, [{ field: `fields.${f.name}`, message: e.message }]);
      }
    });
    values.push(record[used[index].name] ?? null);
  }
  return { values };
}
