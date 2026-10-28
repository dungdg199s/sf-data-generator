// Interprets a validated workflow and produces records. Pure: no I/O, no org access —
// inserting into an org is a separate step (server/sf/insert.js) on the returned records.
//
// Execution model (workflow JSON version 2, a tree of steps; v1 input is migrated first):
// - A sequence of steps runs top to bottom. A step with `disabled: true` is skipped together
//   with everything inside it, without drawing from the rng.
// - record: generates `count` records, each becoming scope.current[alias]; `n` (alias#n) is
//   passed to generators for {{this.$n}}.
// - loop: draws N (rng.int for `range`, even when the body is empty, as v1 did), runs
//   slots.body N times with a loop variable, then the next step.
// - branch: always evaluates its condition, runs slots.true or slots.false, then the next step.
// - query (design 0006): never calls the org. The server reads every Query first
//   (server/sf/query.js) and passes the rows as `opts.queryResults[stepId]`; the step binds them
//   as the pool scope.all[alias] (rows are `existing` records with their real `id`, built once per
//   run), sets no current record and draws nothing from the rng.
// - pick: chooses one record of scope.all[from] (optionally filtered) as scope.current[alias]
//   — the very object, so a Lookup to it still gives `{ $ref }` for a generated record and the
//   real Id for an org row. Nothing to choose: `onEmpty: 'skip'` stops the rest of the run of the
//   innermost loop body (the next iteration starts; at the top level the run ends), with one
//   warning at the end; `'error'` fails.
// Record pools (scope.current / scope.all) are global to the run; loop variables are lexical.
// The rng call order is the same as the v1 graph executor, so a migrated v1 workflow
// produces byte-identical records for the same seed (test/migrate.test.js) — except where the
// migration copied steps: field state (unique sets, Auto Number counters) is keyed by step id,
// so a copy "c_2" counts on its own (reported by shared/migrate-v1.js describeReport).

import { createRandom } from '../random.js';
import { generateValue } from '../generators/index.js';
import { evaluateCondition, compareValues } from './conditions.js';
import { getPath, renderTemplate } from './paths.js';
import { prepareWorkflow, WorkflowError } from './schema.js';
import { LIMITS } from './nodes.js';
import { soqlSobject, keyOf } from '../../shared/soql.js';

/** Returned by runSteps when a Chọn bản ghi step skipped the rest of the current run. */
const SKIP = Symbol('skip');
const PICK_FILTER_CACHE = 1000;

export function runWorkflow(input, opts = {}) {
  const { workflow, errors, warnings } = prepareWorkflow(input);
  if (errors.length) throw new WorkflowError(errors);

  const seed = opts.seed ?? workflow.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRandom(seed);
  const now = opts.now ?? Date.now();
  const maxRecords = Math.min(opts.maxRecords ?? workflow.settings?.maxRecords ?? LIMITS.maxRecordsDefault, LIMITS.maxRecordsHard);
  const started = Date.now();

  const records = [];
  const aliasCounters = new Map();
  const fieldStates = new Map(); // `${stepId}:${field}` -> state object
  const byStep = {};
  let visits = 0;

  const rootScope = { current: {}, all: {}, vars: {} };
  const queryResults = opts.queryResults ?? {};
  const queryPools = new Map(); // Query step id → pool (rows as existing records), built once per run
  const pickStates = new Map(); // Chọn bản ghi step id → { used, cursors, cache, remaining }
  const samples = {}; // Chọn bản ghi step id → fields of its first pick (variable picker samples)

  function fail(step, message) {
    throw new WorkflowError([{ message, nodeId: step.id }]);
  }

  function makeRecord(step, scope) {
    if (records.length >= maxRecords) {
      fail(step, `Vượt giới hạn ${maxRecords} bản ghi cho một lần chạy. Giảm số lần lặp/số bản ghi hoặc tăng maxRecords.`);
    }
    const c = step.config;
    const alias = c.alias || step.id;
    const n = (aliasCounters.get(alias) ?? 0) + 1;
    aliasCounters.set(alias, n);
    const fields = {};
    for (const field of c.fields ?? []) {
      const key = `${step.id}:${field.name}`;
      if (!fieldStates.has(key)) fieldStates.set(key, {});
      try {
        fields[field.name] = generateValue(field, {
          rng,
          now,
          scope,
          record: fields,
          fieldName: field.name,
          fieldState: fieldStates.get(key),
          n,
        });
      } catch (e) {
        if (e instanceof WorkflowError) throw e;
        throw new WorkflowError([{ message: e.message, nodeId: step.id, field: `fields.${field.name}` }]);
      }
    }
    const rec = { ref: `${alias}#${n}`, sobject: c.sobject, alias, nodeId: step.id, fields };
    records.push(rec);
    scope.current[alias] = rec;
    (scope.all[alias] ??= []).push(rec);
  }

  function queryPool(step) {
    let pool = queryPools.get(step.id);
    if (pool) return pool;
    const qr = queryResults[step.id];
    if (!qr) fail(step, 'Bước Query chưa có dữ liệu: server chưa đọc org cho bước này.');
    const c = step.config ?? {};
    const sobject = qr.sobject || soqlSobject(c);
    pool = (qr.records ?? []).map((row, i) => ({
      ref: `${c.alias}#${i + 1}`, sobject, alias: c.alias, nodeId: step.id, id: row?.[keyOf(row, 'Id')] ?? null, existing: true, fields: row ?? {},
    }));
    // Lets a Lookup into an empty pool say that the Query found nothing (generators/reference.js).
    Object.defineProperty(pool, 'queryAlias', { value: c.alias });
    queryPools.set(step.id, pool);
    return pool;
  }

  /** The record a Chọn bản ghi step picks this time, or null when there is nothing to pick. */
  function pickOne(step, scope) {
    const c = step.config ?? {};
    let st = pickStates.get(step.id);
    if (!st) pickStates.set(step.id, (st = { used: new Set(), cursors: new Map(), cache: new Map(), remaining: new Map() }));
    const pool = scope.all[c.from] ?? [];
    let cands = pool;
    let key = '';
    if ((c.filter ?? 'none') === 'compare') {
      // Right side like a template ({ $ref } → its ref, an org row → its Id); the left side is
      // normalised the same way. Filtered lists are cached per (right side, pool size), so a
      // big loop does not filter 2 000 rows on every iteration.
      key = renderTemplate(c.filterValue ?? '', scope, undefined);
      const cacheKey = `${key}\u0000${pool.length}`;
      cands = st.cache.get(cacheKey);
      if (!cands) {
        const op = c.filterOp ?? 'eq';
        cands = pool.filter((r) => {
          const v = getPath(r.fields, c.filterField, { ignoreCase: Boolean(r.existing) });
          return compareValues(v && typeof v === 'object' && v.$ref ? v.$ref : v, op, key);
        });
        if (st.cache.size >= PICK_FILTER_CACHE) st.cache.clear();
        st.cache.set(cacheKey, cands);
      }
    }
    if (!cands.length) return null;
    const mode = c.mode ?? 'random';
    if (mode === 'sequential') {
      const i = st.cursors.get(key) ?? 0;
      st.cursors.set(key, i + 1);
      return cands[i % cands.length];
    }
    if (mode === 'unique') {
      // Not picked yet by this step in this run; swap-remove keeps each pick O(1).
      const rk = `${key}\u0000${cands.length}`;
      let rest = st.remaining.get(rk);
      if (!rest) {
        rest = cands.filter((r) => !st.used.has(r));
        if (st.remaining.size >= PICK_FILTER_CACHE) st.remaining.clear();
        st.remaining.set(rk, rest);
      }
      while (rest.length) {
        const rec = rng.pick(rest);
        const at = rest.indexOf(rec);
        rest[at] = rest[rest.length - 1];
        rest.pop();
        if (st.used.has(rec)) continue; // picked through another filter value meanwhile
        st.used.add(rec);
        return rec;
      }
      return null;
    }
    return rng.pick(cands);
  }

  function runSteps(steps, scope) {
    for (const step of steps ?? []) {
      if (step.disabled === true) continue;
      if (++visits > LIMITS.maxSteps) fail(step, `Workflow chạy quá ${LIMITS.maxSteps} bước. Kiểm tra lại số lần lặp lồng nhau.`);
      const c = step.config ?? {};
      const stat = (byStep[step.id] ??= { runs: 0, records: 0 });
      stat.runs++;
      const before = records.length;
      let stop = false;
      switch (step.type) {
        case 'record': {
          const count = Number(c.count ?? 1);
          for (let i = 0; i < count; i++) makeRecord(step, scope);
          break;
        }
        case 'loop': {
          const times = (c.mode ?? 'fixed') === 'range' ? rng.int(Number(c.min ?? 1), Number(c.max ?? 1)) : Number(c.count ?? 0);
          const body = step.slots?.body ?? [];
          const varName = c.alias || 'loop';
          stat.iterations = (stat.iterations ?? 0) + times;
          if (body.length) {
            for (let i = 0; i < times; i++) {
              // A skip inside the body ends this iteration only.
              runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: times } } });
            }
          }
          break;
        }
        case 'branch': {
          const yes = evaluateCondition(c, scope, rng);
          stat.true ??= 0;
          stat.false ??= 0;
          stat[yes ? 'true' : 'false']++;
          stop = runSteps(step.slots?.[yes ? 'true' : 'false'], scope) === SKIP;
          break;
        }
        case 'query': {
          const pool = queryPool(step);
          scope.all[c.alias] = pool;
          stat.rows = pool.length;
          break;
        }
        case 'pick': {
          const rec = pickOne(step, scope);
          if (!rec) {
            if ((c.onEmpty ?? 'skip') === 'error') {
              fail(step, `Bước Chọn bản ghi "${c.alias}": không còn bản ghi nào trong "${c.from}" thỏa điều kiện (lần thứ ${stat.runs}). Tăng LIMIT của Query, đổi điều kiện lọc, hoặc chọn cách chọn "Ngẫu nhiên (có thể lặp lại)".`);
            }
            stat.skipped = (stat.skipped ?? 0) + 1;
            stop = true;
            break;
          }
          stat.picked = (stat.picked ?? 0) + 1;
          samples[step.id] ??= rec.fields;
          scope.current[c.alias] = rec;
          (scope.all[c.alias] ??= []).push(rec);
          break;
        }
        default:
          fail(step, `Loại bước "${step.type}" không chạy được.`);
      }
      stat.records += records.length - before;
      if (stop) return SKIP;
    }
    return undefined;
  }

  runSteps(workflow.steps, rootScope);

  const runWarnings = [...warnings];
  const visit = (list) => {
    for (const step of list ?? []) {
      const s = byStep[step.id];
      if (step.type === 'pick' && s?.skipped) {
        runWarnings.push({
          message: `Bước Chọn bản ghi "${step.config?.alias}": ${s.skipped}/${s.runs} lần không có bản ghi phù hợp nên đã bỏ qua các bước phía sau. Đổi điều kiện lọc, tăng LIMIT của Query, hoặc chọn "Báo lỗi và dừng" nếu đây là lỗi.`,
          nodeId: step.id,
          code: 'pickSkipped',
        });
      }
      for (const children of Object.values(step.slots ?? {})) visit(children);
    }
  };
  visit(workflow.steps);

  const bySobject = {};
  for (const r of records) bySobject[r.sobject] = (bySobject[r.sobject] ?? 0) + 1;

  return {
    seed,
    records,
    warnings: runWarnings,
    samples,
    stats: { total: records.length, bySobject, byStep, durationMs: Date.now() - started },
  };
}
