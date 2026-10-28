// Interprets a validated workflow and produces records. Pure: no I/O, no timers, no org access —
// inserting into an org is a separate step (server/sf/insert.js) on the records it yields.
//
// Streaming (design 0004): `createRun(workflow, opts)` validates once and returns `records()`, a
// synchronous generator that yields every record in generation order (parents before children).
// Each call of `records()` is a fresh run (new rng, unique sets, counters), so two calls with the
// same seed, `now` and queryResults yield the same sequence. server/run.js drives it (preview,
// dry pass, insert, export); stopping is simply not calling next() again (or calling return()).
// `runWorkflow` collects everything, as before, for tests and the JSON response of /api/run.
//
// Execution model (workflow JSON version 2, a tree of steps; v1 input is migrated first):
// - A sequence of steps runs top to bottom. A step with `disabled: true` is skipped together
//   with everything inside it, without drawing from the rng.
// - record: generates `count` records, each becoming scope.current[alias]; `n` (alias#n) is
//   passed to generators for {{this.$n}}.
// - loop: draws N (rng.int for `range`, even when the body is empty, as v1 did), runs
//   slots.body N times with a loop variable, then the next step. `mode: 'each'` (design 0010)
//   draws nothing: it snapshots the pool scope.all[from] when it starts and runs the body once
//   per record, in pool order, with that very object as scope.current[itemAlias] (not added to
//   scope.all); an empty or missing pool runs 0 times, with one warning per step at the end.
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
// Memory (0004 + 0007 conflict 1): the pool of a Record alias is count-only
// ({ kind: 'generated', length, refAt(i) } → `alias#(i+1)`), unless a step reads whole records
// of it (shared/scope.js poolUsage `readers`: Chọn bản ghi `from`, Lặp `each` `from`); Query and pick pools are
// arrays. A Lookup "random" draws the same single number from a count-only pool as rng.pick.
// The rng call order is the same as the v1 graph executor, so a migrated v1 workflow
// produces byte-identical records for the same seed (test/migrate.test.js) — except where the
// migration copied steps: field state (unique sets, Auto Number counters) is keyed by step id,
// so a copy "c_2" counts on its own (reported by shared/migrate-v1.js describeReport).
// test/stream.test.js pins the records to the collect-everything executor of before 0004.

import { createRandom } from '../random.js';
import { generateValue } from '../generators/index.js';
import { evaluateCondition, compareValues } from './conditions.js';
import { getPath, renderTemplate } from './paths.js';
import { prepareWorkflow, WorkflowError, scopeCatalog } from './schema.js';
import { LIMITS } from './nodes.js';
import { soqlSobject, keyOf } from '../../shared/soql.js';
import { poolUsage } from '../../shared/scope.js';

/** Returned by runSteps when a Chọn bản ghi step skipped the rest of the current run. */
const SKIP = Symbol('skip');
const PICK_FILTER_CACHE = 1000;

/** Count-only pool of a Record alias: `refAt(i)` is the ref of record i (0-based). */
function countPool(alias) {
  return { kind: 'generated', length: 0, refAt: (i) => `${alias}#${i + 1}` };
}

/**
 * Validates `input` (v1 or v2) once and prepares a streamable run.
 * → { seed, now, maxRecords, warnings, referencedAliases, keptPools, columnsBySobject, records }
 *   records(): Generator yielding { ref, sobject, alias, nodeId, fields } in generation order
 *   (records({ ticks: true }) also yields TICK now and then, see below).
 *   Its return value (the `done` result) is { warnings, samples, stats: { total, bySobject,
 *   byStep } }; `generator.live` holds the same counters while it runs (progress events) and
 *   `generator.pools` the record pools by alias.
 * Throws WorkflowError (validation) here, and from next() for errors found while generating
 * (unique values exhausted, maxRecords, maxSteps, …), always with nodeId / field.
 */
export function createRun(input, opts = {}) {
  const { workflow, errors, warnings } = prepareWorkflow(input);
  if (errors.length) throw new WorkflowError(errors);

  const seed = opts.seed ?? workflow.seed ?? Math.floor(Math.random() * 2 ** 31);
  const now = opts.now ?? Date.now();
  const maxRecords = Math.min(opts.maxRecords ?? workflow.settings?.maxRecords ?? LIMITS.maxRecordsDefault, LIMITS.maxRecordsHard);
  const queryResults = opts.queryResults ?? {};
  const { readers, referenced } = poolUsage(workflow, scopeCatalog());

  return {
    seed,
    now,
    maxRecords,
    warnings,
    /** Aliases whose inserted Ids later records need (Lookups, and the pools behind picks). */
    referencedAliases: referenced,
    /** Record aliases whose pool keeps whole records (read by Chọn bản ghi `from`, …). */
    keptPools: readers,
    columnsBySobject: columnsBySobject(workflow),
    records: ({ ticks = false } = {}) => generate(workflow, { seed, now, maxRecords, queryResults, keptPools: readers, ticks }),
  };
}

/** CSV columns per sObject: fields in workflow order (steps in reading order), not data order. */
function columnsBySobject(workflow) {
  const out = {};
  const visit = (list) => {
    for (const step of list ?? []) {
      if (!step || step.disabled === true) continue;
      if (step.type === 'record') {
        const cols = (out[step.config?.sobject] ??= []);
        for (const f of step.config?.fields ?? []) if (f?.name && !cols.includes(f.name)) cols.push(f.name);
      }
      for (const children of Object.values(step.slots ?? {})) visit(children);
    }
  };
  visit(workflow.steps);
  return out;
}

/**
 * Yielded by records({ ticks: true }) every TICK_EVERY step visits: lets the driver look at the
 * clock and the cancel signal while a workflow runs many steps without producing records. Draws
 * nothing from the rng, so the records are the same with or without ticks.
 */
export const TICK = Symbol('tick');
const TICK_EVERY = 5000;

function generate(workflow, { seed, now, maxRecords, queryResults, keptPools, ticks = false }) {
  const live = { total: 0, bySobject: {}, byStep: {} };
  const rootScope = { current: {}, all: {}, vars: {} };
  const it = run();
  it.live = live;
  it.pools = rootScope.all; // record pools of this run (tests check which ones are count-only)
  return it;

  function* run() {
    const rng = createRandom(seed);
    const aliasCounters = new Map();
    const fieldStates = new Map(); // `${stepId}:${field}` -> state object
    const { byStep, bySobject } = live;
    let visits = 0;

    const queryPools = new Map(); // Query step id → pool (rows as existing records), built once per run
    const pickStates = new Map(); // Chọn bản ghi step id → { used, cursors, cache, remaining }
    const samples = {}; // Chọn bản ghi step id → fields of its first pick (variable picker samples)
    const emptyEach = new Set(); // Lặp `each` step ids that met an empty pool (one warning each)

    function fail(step, message, field) {
      throw new WorkflowError([{ message, nodeId: step.id, ...(field ? { field } : {}) }]);
    }

    function makeRecord(step, scope) {
      if (live.total >= maxRecords) {
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
      live.total++;
      bySobject[rec.sobject] = (bySobject[rec.sobject] ?? 0) + 1;
      scope.current[alias] = rec;
      let pool = scope.all[alias];
      if (!pool) pool = scope.all[alias] = keptPools.has(alias) ? [] : countPool(alias);
      if (Array.isArray(pool)) pool.push(rec);
      else pool.length++;
      return rec;
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
      // keptPools comes from the same catalogue rule that makes `from` a pool reader.
      if (!Array.isArray(pool)) fail(step, `Pool "${c.from}" không giữ bản ghi để chọn (lỗi nội bộ). Báo lại kèm file workflow.`);
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

    /**
     * Lặp `each` (design 0010): the body once per record of the pool as it is now (a snapshot:
     * records added to it meanwhile are not visited), in pool order, without the rng.
     */
    function* runEach(step, c, stat, scope) {
      const pool = scope.all[c.from];
      // keptPools comes from the same catalogue rule that makes `from` a pool reader.
      if (pool && !Array.isArray(pool)) fail(step, `Pool "${c.from}" không giữ bản ghi để lặp (lỗi nội bộ). Báo lại kèm file workflow.`, 'from');
      // Pools only grow (records are appended), so the snapshot is the length: no copy.
      const n = pool ? pool.length : 0;
      if (n > LIMITS.maxCountPerNode) {
        fail(step, `Pool "${c.from}" có ${n.toLocaleString('vi-VN')} bản ghi, quá giới hạn ${LIMITS.maxCountPerNode.toLocaleString('vi-VN')} lần lặp của một bước Lặp. Thu hẹp pool (WHERE/LIMIT của Query) hoặc giảm số bản ghi.`, 'from');
      }
      stat.iterations = (stat.iterations ?? 0) + n;
      if (!n) emptyEach.add(step.id);
      const body = step.slots?.body ?? [];
      if (!body.length) return;
      const varName = c.alias || 'loop';
      for (let i = 0; i < n; i++) {
        if (countVisit(step)) yield TICK;
        scope.current[c.itemAlias] = pool[i];
        // A skip inside the body ends this iteration only.
        yield* runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: n } } });
      }
    }

    /**
     * One step visit or one loop iteration: counts toward LIMITS.maxSteps and the TICK cadence
     * (a loop whose body only holds turned-off steps still iterates, review of 0010).
     * → true when the caller should yield TICK.
     */
    function countVisit(step) {
      if (++visits > LIMITS.maxSteps) fail(step, `Workflow chạy quá ${LIMITS.maxSteps} bước. Kiểm tra lại số lần lặp lồng nhau.`);
      return ticks && visits % TICK_EVERY === 0;
    }

    /** Yields the records of `steps`; returns SKIP when a Chọn bản ghi step skipped the rest. */
    function* runSteps(steps, scope) {
      for (const step of steps ?? []) {
        if (step.disabled === true) continue;
        if (countVisit(step)) yield TICK;
        const c = step.config ?? {};
        const stat = (byStep[step.id] ??= { runs: 0, records: 0 });
        stat.runs++;
        const before = live.total;
        let stop = false;
        switch (step.type) {
          case 'record': {
            const count = Number(c.count ?? 1);
            for (let i = 0; i < count; i++) yield makeRecord(step, scope);
            break;
          }
          case 'loop': {
            if (c.mode === 'each') {
              yield* runEach(step, c, stat, scope);
              break;
            }
            const times = (c.mode ?? 'fixed') === 'range' ? rng.int(Number(c.min ?? 1), Number(c.max ?? 1)) : Number(c.count ?? 0);
            const body = step.slots?.body ?? [];
            const varName = c.alias || 'loop';
            stat.iterations = (stat.iterations ?? 0) + times;
            if (body.length) {
              for (let i = 0; i < times; i++) {
                if (countVisit(step)) yield TICK;
                // A skip inside the body ends this iteration only.
                yield* runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: times } } });
              }
            }
            break;
          }
          case 'branch': {
            const yes = evaluateCondition(c, scope, rng);
            stat.true ??= 0;
            stat.false ??= 0;
            stat[yes ? 'true' : 'false']++;
            stop = (yield* runSteps(step.slots?.[yes ? 'true' : 'false'], scope)) === SKIP;
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
        stat.records += live.total - before;
        if (stop) return SKIP;
      }
      return undefined;
    }

    yield* runSteps(workflow.steps, rootScope);

    const runWarnings = [];
    const visit = (list) => {
      for (const step of list ?? []) {
        const s = byStep[step.id];
        if (emptyEach.has(step.id)) {
          runWarnings.push({
            message: `Bước Lặp "${step.config?.itemAlias || step.config?.alias || 'loop'}": pool "${step.config?.from}" không có bản ghi nào nên các bước bên trong không chạy. Kiểm tra bước "${step.config?.from}" (WHERE của Query hoặc số bản ghi).`,
            nodeId: step.id,
            field: 'from',
            code: 'eachEmpty',
          });
        }
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
    return { warnings: runWarnings, samples, stats: { total: live.total, bySobject, byStep } };
  }
}

/**
 * Runs the whole workflow and collects every record (synchronous, as before 0004): tests and the
 * JSON (non-streaming) response of /api/run.
 * → { seed, now, records, warnings, samples, stats: { total, bySobject, byStep, durationMs } }
 */
export function runWorkflow(input, opts = {}) {
  const run = createRun(input, opts);
  const started = Date.now();
  const records = [];
  const it = run.records();
  let step;
  while (!(step = it.next()).done) records.push(step.value);
  const end = step.value;
  return {
    seed: run.seed,
    now: run.now,
    records,
    warnings: [...run.warnings, ...end.warnings],
    samples: end.samples,
    stats: { ...end.stats, durationMs: Date.now() - started },
  };
}
