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
//   slots.body N times with a loop variable, then the next step. A count may be a number
//   variable (design 0013 B, `"{{acc.N}}"`), read on every visit in the scope around the loop:
//   empty / negative / not a number → 0, above maxCountPerNode → maxCountPerNode, one warning
//   per step and option at the end. `mode: 'each'` (design 0010) snapshots the pool
//   scope.all[from] when it starts and runs the body once per record, in pool order, with that
//   very object as scope.current[itemAlias] (not added to scope.all); an empty or missing pool
//   runs 0 times, with one warning per step at the end. Design 0013 C: optionally filtered
//   (`filterValue` rendered once as the loop starts; `eq` through a per-step index), shuffled
//   (`order: 'shuffle'`: rng.shuffleTake draws exactly k numbers) and cut to `limit`, in that
//   order; without shuffle it draws nothing. `mode: 'values'` (0013 D) runs once per value of
//   the list, with `{{loop.value}}`, drawing nothing.
// - branch: always evaluates its condition, runs slots.true or slots.false, then the next step.
//   (`right` with "{{" is rendered first, design 0013 A.)
// - query (design 0006): never calls the org. The server reads every Query first
//   (server/sf/query.js) and passes the rows as `opts.queryResults[stepId]`; the step binds them
//   as the pool scope.all[alias] (rows are `existing` records with their real `id`, built once per
//   run), sets no current record and draws nothing from the rng.
// - pick: chooses one record of scope.all[from] (optionally filtered) as scope.current[alias]
//   — the very object, so a Lookup to it still gives `{ $ref }` for a generated record and the
//   real Id for an org row. Nothing to choose: `onEmpty: 'skip'` stops the rest of the run of the
//   innermost loop body (the next iteration starts; at the top level the run ends), with one
//   warning at the end; `'error'` fails. `mode: 'weighted'` (design 0013 E) always draws one
//   number and picks in proportion to `weightField` (all zero → uniform, with a warning).
// - samples: the fields of the first record of every Record step and the first pick of every
//   Chọn bản ghi (variable picker), also on `generator.samples` while it runs (0013 F).
// - scope.run = { seed, now, today } (design 0013 G), read after every name the user gave.
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
import { evaluateCondition, compareValues, toNumber } from './conditions.js';
import { getPath, renderTemplate, resolvePath } from './paths.js';
import { prepareWorkflow, WorkflowError, scopeCatalog } from './schema.js';
import { LIMITS, nodeTypeMap } from './nodes.js';
import { soqlSobject, keyOf } from '../../shared/soql.js';
import { poolUsage, numberVarPath, isVar, valueList } from '../../shared/scope.js';

/** Returned by runSteps when a Chọn bản ghi step skipped the rest of the current run. */
const SKIP = Symbol('skip');
const PICK_FILTER_CACHE = 1000;
const vi = (n) => n.toLocaleString('vi-VN');

/** Left side of a filter: the field of a pool record, a Lookup `{ $ref }` as its ref. */
function filterLeft(rec, field) {
  const v = getPath(rec.fields, field, { ignoreCase: Boolean(rec.existing) });
  return v && typeof v === 'object' && v.$ref ? v.$ref : v;
}

/**
 * Key of a value in the `eq` index of a Lặp `each` filter: `n:<number>` for a number or numeric
 * string, `s:<text>` otherwise. compareValues(l, 'eq', r) is true exactly when key(l) = key(r),
 * or r is numeric and `s:${String(r)}` = key(l) (l not numeric but reading like r: `[5]`): the
 * lookup merges both lists then (eachIndices).
 */
const eqKey = (v) => {
  const n = toNumber(v);
  return n !== null ? `n:${n}` : `s:${v === null || v === undefined ? '' : String(v)}`;
};

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
  const iso = new Date(now).toISOString();
  // `run` (design 0013 G): the same seed + now in preview, insert and export give the same values.
  const rootScope = { current: {}, all: {}, vars: {}, run: { seed, now: iso, today: iso.slice(0, 10) } };
  // Step id → fields of its first record (Record) or first pick (Chọn bản ghi): variable picker
  // samples, also readable while the run goes (a cancelled preview still returns them).
  const samples = {};
  const it = run();
  it.live = live;
  it.pools = rootScope.all; // record pools of this run (tests check which ones are count-only)
  it.samples = samples;
  return it;

  function* run() {
    const rng = createRandom(seed);
    const aliasCounters = new Map();
    const fieldStates = new Map(); // `${stepId}:${field}` -> state object
    const { byStep, bySobject } = live;
    let visits = 0;

    const queryPools = new Map(); // Query step id → pool (rows as existing records), built once per run
    const pickStates = new Map(); // Chọn bản ghi step id → { used, cursors, cache, remaining }
    const emptyEach = new Set(); // Lặp `each` step ids that met an empty pool (one warning each)
    // Counters of the run warnings of design 0013, apart from byStep (whose shape the golden
    // hashes pin): `${stepId}|${key}` → { runs, empty, clamped } for number variables, step id →
    // { visits, matched } for each filters and → zero-weight picks.
    const numberWarn = new Map();
    const eachFilterStats = new Map();
    const weightZero = new Map();
    const eachStates = new Map(); // Lặp `each` step id → { pool, scanned, index, cache } (filter)
    const weightSums = new WeakMap(); // candidate list → { n, sums } (prefix sums of the weights)

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
      samples[step.id] ??= fields;
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
      if (mode === 'weighted') return pickWeighted(step, c, cands);
      return rng.pick(cands);
    }

    /**
     * Chọn bản ghi "theo trọng số" (design 0013 E): always one number r; the first candidate whose
     * running total of weights passes r · total. Weights: the numeric value of `weightField`
     * (missing, negative, not a number → 0); all zero → uniform, counted for a warning. The
     * running totals are cached per candidate list and extended when it grows (the pool itself).
     */
    function pickWeighted(step, c, cands) {
      const r = rng.next();
      let w = weightSums.get(cands);
      if (!w) weightSums.set(cands, (w = { n: 0, sums: [] }));
      for (let total = w.n ? w.sums[w.n - 1] : 0; w.n < cands.length; w.n++) {
        const x = toNumber(filterLeft(cands[w.n], c.weightField));
        total += x !== null && x > 0 && Number.isFinite(x) ? x : 0;
        w.sums.push(total);
      }
      const len = cands.length;
      const total = w.sums[len - 1];
      if (!(total > 0)) {
        weightZero.set(step.id, (weightZero.get(step.id) ?? 0) + 1);
        return cands[Math.floor(r * len)];
      }
      const target = r * total;
      let lo = 0;
      let hi = len - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (w.sums[mid] > target) hi = mid;
        else lo = mid + 1;
      }
      return cands[lo];
    }

    /**
     * Value of a `vars: 'number'` option for this visit (design 0013 B). A number (or a numeric
     * string) goes the way it always did, so saved workflows give the same data; a `{{path}}` is
     * read in `scope` and clamped to 0…maxCountPerNode, counting the visits for the warnings.
     */
    function numberOption(step, key, fallback, scope) {
      const raw = step.config?.[key] ?? fallback;
      const path = numberVarPath(raw);
      if (path === null) return Number(raw);
      const k = `${step.id}|${key}`;
      let w = numberWarn.get(k);
      if (!w) numberWarn.set(k, (w = { runs: 0, empty: 0, clamped: 0 }));
      w.runs++;
      const x = toNumber(resolvePath(path, scope, undefined));
      if (x === null || Number.isNaN(x) || x < 0) {
        w.empty++;
        return 0;
      }
      if (x > LIMITS.maxCountPerNode) {
        w.clamped++;
        return LIMITS.maxCountPerNode;
      }
      return Math.trunc(x);
    }

    /** Lặp "Mỗi giá trị trong danh sách" (design 0013 D): no rng. */
    function* runValues(step, c, stat, scope) {
      const values = valueList(c.values);
      stat.iterations = (stat.iterations ?? 0) + values.length;
      const body = step.slots?.body ?? [];
      if (!body.length) return;
      const varName = c.alias || 'loop';
      for (let i = 0; i < values.length; i++) {
        if (countVisit(step)) yield TICK;
        yield* runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: values.length, value: values[i] } } });
      }
    }

    /**
     * Positions (ascending, pool order) of the first `n` records of `pool` matching the filter of
     * Lặp `each` step `step` against `right` (design 0013 C). `eq` goes through an index built
     * once per step and extended as the pool grows (pools only grow); other operators filter
     * linearly, cached per (right side, n). The array may be shared: do not change it.
     */
    function eachIndices(step, c, pool, n, right) {
      let st = eachStates.get(step.id);
      if (!st || st.pool !== pool) eachStates.set(step.id, (st = { pool, scanned: 0, index: new Map(), cache: new Map() }));
      const op = c.filterOp ?? 'eq';
      if (op === 'eq') {
        for (; st.scanned < n; st.scanned++) {
          const key = eqKey(filterLeft(pool[st.scanned], c.filterField));
          let list = st.index.get(key);
          if (!list) st.index.set(key, (list = []));
          list.push(st.scanned);
        }
        const key = eqKey(right);
        const a = st.index.get(key) ?? [];
        // A numeric right side also equals, as text, a left value that is not a number but reads
        // like one (`[5]`, `Infinity`): those are keyed `s:<text>`. (No string is: it would be numeric.)
        const b = key[0] === 'n' ? st.index.get(`s:${String(right ?? '')}`) : null;
        const cut = (list) => {
          // Positions beyond the snapshot `n` (the pool grew since another visit) are dropped.
          if (!list.length || list[list.length - 1] < n) return list;
          let k = list.length;
          while (k > 0 && list[k - 1] >= n) k--;
          return list.slice(0, k);
        };
        if (!b?.length) return cut(a);
        return cut([...a, ...b].sort((x, y) => x - y));
      }
      const cacheKey = `${right}\u0000${n}`;
      let out = st.cache.get(cacheKey);
      if (!out) {
        out = [];
        for (let i = 0; i < n; i++) if (compareValues(filterLeft(pool[i], c.filterField), op, right)) out.push(i);
        if (st.cache.size >= PICK_FILTER_CACHE) st.cache.clear();
        st.cache.set(cacheKey, out);
      }
      return out;
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
      // Filter → shuffle → limit (design 0013 C). `idx` null: positions 0…n-1, not allocated.
      let idx = null;
      const filtered = (c.filter ?? 'none') === 'compare';
      if (filtered && n) {
        // Rendered once, in the scope around the loop (`{{acc.Id}}` of an outer loop).
        const right = renderTemplate(c.filterValue ?? '', scope, undefined);
        idx = eachIndices(step, c, pool, n, right);
        let f = eachFilterStats.get(step.id);
        if (!f) eachFilterStats.set(step.id, (f = { visits: 0, matched: 0 }));
        f.visits++;
        if (idx.length) f.matched++;
      }
      const m0 = idx ? idx.length : n;
      const limit = Math.trunc(Number(c.limit ?? 0)) || 0;
      const m = limit > 0 ? Math.min(limit, m0) : m0;
      if (m > LIMITS.maxCountPerNode) {
        fail(step, filtered
          ? `Pool "${c.from}" còn ${vi(m)} bản ghi sau khi lọc, quá giới hạn ${vi(LIMITS.maxCountPerNode)} lần lặp của một bước Lặp. Đặt "Tối đa số bản ghi" hoặc thu hẹp điều kiện lọc.`
          : `Pool "${c.from}" có ${vi(n)} bản ghi, quá giới hạn ${vi(LIMITS.maxCountPerNode)} lần lặp của một bước Lặp. Thu hẹp pool (WHERE/LIMIT của Query) hoặc giảm số bản ghi.`, 'from');
      }
      // Exactly m numbers, drawn as the loop starts (none for pool order).
      if ((c.order ?? 'pool') === 'shuffle' && m) idx = rng.shuffleTake(idx ?? Array.from({ length: n }, (_, i) => i), m);
      stat.iterations = (stat.iterations ?? 0) + m;
      if (!n) emptyEach.add(step.id);
      const body = step.slots?.body ?? [];
      if (!body.length) return;
      const varName = c.alias || 'loop';
      for (let i = 0; i < m; i++) {
        if (countVisit(step)) yield TICK;
        scope.current[c.itemAlias] = pool[idx ? idx[i] : i];
        // A skip inside the body ends this iteration only.
        yield* runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: m } } });
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
            if (c.mode === 'values') {
              yield* runValues(step, c, stat, scope);
              break;
            }
            let times;
            if ((c.mode ?? 'fixed') === 'range') {
              const lo = numberOption(step, 'min', 1, scope);
              let hi = numberOption(step, 'max', 1, scope);
              // Only with a variable: a saved `min` > `max` still draws rng.int(min, max) as before.
              if (isVar(c.min) || isVar(c.max)) hi = Math.max(lo, hi);
              times = rng.int(lo, hi); // always exactly one number, even with an empty body
            } else times = numberOption(step, 'count', 0, scope);
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
    const optionLabel = (step, key) => nodeTypeMap.get(step.type)?.options.find((o) => o.key === key)?.label ?? key;
    const visit = (list) => {
      for (const step of list ?? []) {
        const s = byStep[step.id];
        const name = step.config?.itemAlias || step.config?.alias || 'loop';
        if (emptyEach.has(step.id)) {
          runWarnings.push({
            message: `Bước Lặp "${name}": pool "${step.config?.from}" không có bản ghi nào nên các bước bên trong không chạy. Kiểm tra bước "${step.config?.from}" (WHERE của Query hoặc số bản ghi).`,
            nodeId: step.id,
            field: 'from',
            code: 'eachEmpty',
          });
        }
        const f = eachFilterStats.get(step.id);
        if (f?.visits && !f.matched) {
          runWarnings.push({
            message: `Bước Lặp "${name}": không bản ghi nào của pool "${step.config?.from}" thỏa điều kiện lọc ở cả ${vi(f.visits)} lần chạy qua, nên các bước bên trong không chạy. Kiểm tra field lọc (có trong "Field cần lấy" của Query chưa?) và giá trị so sánh.`,
            nodeId: step.id,
            field: 'filterValue',
            code: 'eachFilterEmpty',
          });
        }
        for (const key of ['count', 'min', 'max']) {
          const w = numberWarn.get(`${step.id}|${key}`);
          if (!w) continue;
          const head = `Bước Lặp "${step.config?.alias || 'loop'}": "${optionLabel(step, key)}" = {{${numberVarPath(step.config?.[key])}}}`;
          if (w.empty) {
            runWarnings.push({
              message: `${head} trống, âm hoặc không phải số ở ${vi(w.empty)}/${vi(w.runs)} lần chạy qua, nên các lần đó ${key === 'count' ? 'lặp 0 lần' : 'dùng 0'}. Kiểm tra field trong org hoặc chọn biến khác.`,
              nodeId: step.id,
              field: key,
              code: 'numberVarEmpty',
            });
          }
          if (w.clamped) {
            runWarnings.push({
              message: `${head} lớn hơn ${vi(LIMITS.maxCountPerNode)} ở ${vi(w.clamped)}/${vi(w.runs)} lần chạy qua, nên đã dùng ${vi(LIMITS.maxCountPerNode)}.`,
              nodeId: step.id,
              field: key,
              code: 'numberVarClamped',
            });
          }
        }
        if (step.type === 'pick' && s?.skipped) {
          runWarnings.push({
            message: `Bước Chọn bản ghi "${step.config?.alias}": ${s.skipped}/${s.runs} lần không có bản ghi phù hợp nên đã bỏ qua các bước phía sau. Đổi điều kiện lọc, tăng LIMIT của Query, hoặc chọn "Báo lỗi và dừng" nếu đây là lỗi.`,
            nodeId: step.id,
            code: 'pickSkipped',
          });
        }
        if (weightZero.has(step.id)) {
          runWarnings.push({
            message: `Bước Chọn bản ghi "${step.config?.alias}": ${vi(weightZero.get(step.id))}/${vi(s?.runs ?? 0)} lần mọi bản ghi có trọng số 0 (field "${step.config?.weightField}" trống hoặc không phải số) nên đã chọn đều. Kiểm tra field trọng số hoặc thêm nó vào "Field cần lấy" của Query.`,
            nodeId: step.id,
            field: 'weightField',
            code: 'pickWeightZero',
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
