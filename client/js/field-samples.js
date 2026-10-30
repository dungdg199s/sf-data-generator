// "Ví dụ" row at the end of an open field's options (design 0012 E): three values of the field
// while its options are edited.
// - A field that stands alone (no Lookup, no reference to another step or a loop variable, also
//   through {{this.X}}): `POST /api/field-samples` (300 ms after the last edit; older answers are
//   dropped by sequence number and AbortController), seed = the Seed box when it is a number,
//   else 1; now = today 00:00 local time, so the values only move with the options.
// - A field that depends on another step: the first three records of the step in the last preview
//   ("Lần xem trước: …", dimmed once the workflow changed), or a hint to preview.

import { h } from './dom.js';
import { state, subscribe, currentScope, fieldType } from './store.js';
import { api } from './api.js';
import { formatSample, samplesStale } from './variables.js';

const DEBOUNCE_MS = 300;
const independentTitle = (seed) => `Ba giá trị sinh riêng cho field này (seed ${seed}) để thấy ngay tác dụng của tùy chọn. Xem trước có thể ra giá trị khác.`;
// request JSON → { values } | { error } (the last 50): answers and 422s only, which the same request
// would get again; a 500 or a lost connection is shown but asked again next time.
const cache = new Map();
const rows = new Set();

// Dependent rows follow a new preview, and every row its field's edits (typed options do not
// re-render the inspector).
subscribe(({ kind }) => {
  if (kind !== 'result' && kind !== 'workflow') return;
  for (const row of rows) {
    if (!row.isConnected) rows.delete(row);
    else row.refresh();
  }
});

/** Seed of the examples: the Seed box when it is a number, else 1. */
function sampleSeed() {
  const raw = document.getElementById('seed')?.value.trim() ?? '';
  return /^\d+$/.test(raw) ? Number(raw) : 1;
}

/** Today 00:00, local time. */
function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Field `index` of step `step` takes data from another step: a reference field type, a reference
 * of its options to another step or a loop variable, or {{this.X}} with X such a field.
 */
export function fieldDepends(step, index) {
  const fields = step.config?.fields ?? [];
  const refs = currentScope().refs.filter((r) => r.nodeId === step.id && !r.hidden && r.fieldIndex !== undefined);
  const memo = new Map();
  const dep = (i) => {
    if (memo.has(i)) return memo.get(i);
    memo.set(i, false); // cycles cannot happen (this.X is above), but stay safe
    const f = fields[i];
    let d = Boolean(f) && fieldType(f.type)?.valueType === 'reference';
    for (const r of refs) {
      if (d) break;
      if (r.fieldIndex !== i) continue;
      if (!r.viaThis) d = true;
      else {
        const above = fields.findIndex((x) => x?.name === String(r.path).split('.')[1]);
        if (above >= 0 && above < i) d = dep(above);
      }
    }
    memo.set(i, d);
    return d;
  };
  return dep(index);
}

/** The row for field `index` of `step` (refreshes itself; `row.refresh()` after an edit). */
export function samplesRow(step, index) {
  const row = h('div', { class: 'field-samples', 'aria-live': 'polite' });
  let timer = 0;
  let seq = 0;
  let controller = null;
  // Only what changed is written: the row is aria-live, and refreshes come on every edit.
  const show = (text, { cls = '', title = '' } = {}) => {
    const className = `field-samples${cls ? ` ${cls}` : ''}`;
    if (row.className !== className) row.className = className;
    if (row.textContent !== text) row.textContent = text;
    if (row.title !== title) row.title = title;
  };
  const showValues = (res, seed) => {
    if (res.error) show(`Không tạo được ví dụ: ${res.error}`, { cls: 'error' });
    else show(`Ví dụ: ${res.values.map(formatSample).join(' · ')}`, { title: independentTitle(seed) });
  };

  row.refresh = () => {
    const field = step.config?.fields?.[index];
    if (!field) return;
    clearTimeout(timer);
    if (fieldDepends(step, index)) {
      controller?.abort();
      seq++;
      row.classList.add('dep');
      if (!state.result) {
        show('Bấm Xem trước (Ctrl+Enter) để thấy giá trị: field này lấy dữ liệu từ bước khác.', { cls: 'dep' });
        return;
      }
      const values = state.result.records.filter((r) => r.nodeId === step.id).slice(0, 3).map((r) => r.fields?.[field.name]);
      const stale = samplesStale();
      show(values.length ? `Lần xem trước: ${values.map(formatSample).join(' · ')}` : 'Lần xem trước không sinh bản ghi nào của bước này.', {
        cls: `dep${stale ? ' stale' : ''}`,
        title: stale ? 'Từ lần xem trước; workflow đã thay đổi sau đó.' : 'Từ lần xem trước gần nhất.',
      });
      return;
    }
    const body = {
      sobject: step.config?.sobject,
      fields: step.config.fields.slice(0, index + 1).map((f) => ({ name: f?.name, type: f?.type, options: f?.options ?? {} })),
      index,
      seed: sampleSeed(),
      now: today(),
      count: 3,
    };
    const key = JSON.stringify(body);
    const hit = cache.get(key);
    if (hit) {
      controller?.abort();
      seq++;
      showValues(hit, body.seed);
      return;
    }
    if (!row.textContent) show('Ví dụ: …', { title: independentTitle(body.seed) });
    const mine = ++seq;
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      let res;
      try {
        res = await api.fieldSamples(body, { signal: controller.signal });
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (!e.status) {
          if (mine === seq) show('Không lấy được ví dụ: mất kết nối với server.', { cls: 'error' });
          return;
        }
        res = { error: e.issues?.[0]?.message ?? e.message };
        if (e.status !== 422) {
          if (mine === seq) showValues(res, body.seed);
          return;
        }
      }
      cache.set(key, res);
      if (cache.size > 50) cache.delete(cache.keys().next().value);
      if (mine === seq) showValues(res, body.seed);
    }, row.isConnected ? DEBOUNCE_MS : 0);
  };

  rows.add(row);
  row.refresh();
  return row;
}
