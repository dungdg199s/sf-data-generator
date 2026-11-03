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
//   slots.body N times with a loop variable, then the next step. `count`/`min`/`max` may be one
//   variable `{{path}}` (design 0013), read each time the loop is reached (empty, negative or not a
//   number → 0, above maxCountPerNode → clamped, one warning each per step). `mode: 'each'` (design
//   0010) snapshots the pool scope.all[from] when it starts and runs the body once per record, in
//   pool order, with that very object as scope.current[itemAlias] (not added to scope.all); an
//   empty or missing pool runs 0 times, with one warning per step at the end. Design 0013 adds a
//   filter (filterValue rendered once at the start; `eq` through a per-step index), `order:
//   'shuffle'` (rng.shuffleTake, exactly min(limit, matches) numbers when the loop starts) and
//   `limit`; without shuffle it draws nothing. `mode: 'values'` runs once per value of the list,
//   with `{{loop.value}}`, without the rng.
// - branch: always evaluates its condition, runs slots.true or slots.false, then the next step.
// - query (design 0006): never calls the org. The server reads every Query first
//   (server/sf/query.js) and passes the rows as `opts.queryResults[stepId]`; the step binds them
//   as the pool scope.all[alias] (rows are `existing` records with their real `id`, built once per
//   run), sets no current record and draws nothing from the rng.
// - pick: chooses one record of scope.all[from] (optionally filtered) as scope.current[alias]
//   — the very object, so a Lookup to it still gives `{ $ref }` for a generated record and the
//   real Id for an org row. `mode: 'weighted'` (design 0013) draws exactly one number and picks
//   with probability proportional to `weightField` (all weights 0: uniformly, with one warning).
//   Nothing to choose: `onEmpty: 'skip'` stops the rest of the run of the
//   innermost loop body (the next iteration starts; at the top level the run ends), with one
//   warning at the end; `'error'` fails.
// Record pools (scope.current / scope.all) are global to the run; loop variables are lexical.
// `scope.run` = { seed, now (ISO, UTC), today (YYYY-MM-DD, UTC) } (design 0013): the same for the
// preview, the insert and /api/export, which re-run the preview's seed and now. `samples` holds the
// fields of the first record of every Record step and the first pick of every Chọn bản ghi.
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
const nf = (n) => n.toLocaleString('vi-VN');

/** Key of a value in the `eq` index of a Lặp `each` filter: equal keys ⇔ compareValues(·, 'eq', ·). */
function eqKey(v) {
  const x = toNumber(v);
  return x !== null ? `n:${x}` : `s:${String(v ?? '')}`;
}

/** Two ascending position lists merged (they never share a position). */
function mergeSorted(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i] < b[j]) ? a[i++] : b[j++]);
  return out;
}

/** Message for a `now` a Date cannot hold (server/index.js answers it with a 400 too). */
export const NOW_MESSAGE = 'Tham số now không hợp lệ: phải là số mili giây từ -8640000000000000 đến 8640000000000000. Bỏ now để dùng giờ hiện tại, hoặc bấm Xem trước rồi chạy lại.';
/** `now` (ms) that a Date can represent. */
export const isValidNow = (now) => typeof now === 'number' && Number.isFinite(now) && Math.abs(now) <= 8.64e15;

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
 *   byStep } }; `generator.live` holds the same counters while it runs (progress events),
 *   `generator.pools` the record pools by alias and `generator.samples` the samples so far (a
 *   cancelled run still returns them).
 * Throws WorkflowError (validation) here, and from next() for errors found while generating
 * (unique values exhausted, maxRecords, maxSteps, …), always with nodeId / field.
 */
export function createRun(input, opts = {}) {
  const { workflow, errors, warnings } = prepareWorkflow(input);
  if (errors.length) throw new WorkflowError(errors);

  const seed = opts.seed ?? workflow.seed ?? Math.floor(Math.random() * 2 ** 31);
  const now = opts.now ?? Date.now();
  // A Date can hold |now| ≤ 8.64e15 ms (review 0013 N1): {{run.now}} and date fields need one.
  if (!isValidNow(now)) throw new WorkflowError([{ message: NOW_MESSAGE }]);
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
  const rootScope = { current: {}, all: {}, vars: {}, run: { seed, now: iso, today: iso.slice(0, 10) } };
  // Step id → fields of its first record (Record) or first pick (Chọn bản ghi): variable picker samples.
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
    // Design 0013 run warnings, counted apart from byStep (whose hashes are pinned):
    const numberWarns = new Map(); // `${stepId}|${key}` → { runs, empty, clamped, path }
    const eachFilterStats = new Map(); // Lặp `each` step id → { visits, matched }
    const eachFilters = new Map(); // Lặp `each` step id → { pool, scanned, index, cache }
    const weightZero = new Map(); // Chọn bản ghi step id → picks where every weight was 0
    const weightHuge = new Map(); // Chọn bản ghi step id → picks whose total weight was not finite
    // Chọn bản ghi step id → WeakMap(candidate array → prefix sums of that step's weightField).
    // Per step (review 0013 B1): two weighted picks on one pool with different fields must not
    // share a table.
    const weightSums = new Map();

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
     * Chọn bản ghi `weighted` (design 0013): one number r = rng.next(); the first candidate whose
     * prefix sum of weights exceeds r · total (weights: the number in `weightField`; empty, negative
     * or not a number count 0). All 0: cands[floor(r · len)] and a warning. Prefix sums are cached
     * per candidate array and extended when it grows (an unfiltered pool is the pool array).
     */
    function pickWeighted(step, c, cands) {
      let byCands = weightSums.get(step.id);
      if (!byCands) weightSums.set(step.id, (byCands = new WeakMap()));
      let pre = byCands.get(cands);
      if (!pre) byCands.set(cands, (pre = { sums: [] }));
      const { sums } = pre;
      for (let i = sums.length; i < cands.length; i++) {
        const r = cands[i];
        const w = toNumber(getPath(r.fields, c.weightField, { ignoreCase: Boolean(r.existing) }));
        sums.push((i ? sums[i - 1] : 0) + (w !== null && Number.isFinite(w) && w > 0 ? w : 0));
      }
      const x = rng.next();
      const total = sums[cands.length - 1];
      // All 0, or a total too big for a number (review 0013 N2): uniformly, with a warning.
      if (!(total > 0) || !Number.isFinite(total)) {
        const counter = total > 0 ? weightHuge : weightZero;
        counter.set(step.id, (counter.get(step.id) ?? 0) + 1);
        return cands[Math.floor(x * cands.length)];
      }
      const target = x * total;
      let lo = 0;
      let hi = cands.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sums[mid] > target) hi = mid;
        else lo = mid + 1;
      }
      return cands[lo];
    }

    /**
     * Value of a number option (`vars: 'number'`, design 0013) at this visit. A number (or numeric
     * string) takes the path of before; one variable is read in `scope` (outside the body).
     */
    function numberOption(step, key, fallback, scope) {
      const raw = step.config?.[key] ?? fallback;
      const path = numberVarPath(raw);
      if (path === null) return Number(raw);
      const wk = `${step.id}|${key}`;
      let w = numberWarns.get(wk);
      if (!w) numberWarns.set(wk, (w = { runs: 0, empty: 0, clamped: 0, path }));
      w.runs++;
      const x = toNumber(resolvePath(path, scope, undefined));
      if (x === null || !Number.isFinite(x) || x < 0) {
        w.empty++;
        return 0;
      }
      if (x > LIMITS.maxCountPerNode) {
        w.clamped++;
        return LIMITS.maxCountPerNode;
      }
      return Math.trunc(x);
    }

    /**
     * Positions (ascending, pool order) of the first `n` records of `pool` matching the filter of
     * a Lặp `each` against `right`. `eq` goes through an index built once per step and extended as
     * the pool grows (pools only grow); other operators filter linearly, cached per (right, n).
     * The returned array belongs to the cache: do not modify it.
     */
    function filterIndices(step, c, pool, n, right) {
      let st = eachFilters.get(step.id);
      if (!st || st.pool !== pool) eachFilters.set(step.id, (st = { pool, scanned: 0, index: new Map(), cache: new Map() }));
      const leftOf = (r) => {
        const v = getPath(r.fields, c.filterField, { ignoreCase: Boolean(r.existing) });
        return v && typeof v === 'object' && v.$ref ? v.$ref : v;
      };
      const op = c.filterOp ?? 'eq';
      if (op === 'eq') {
        for (; st.scanned < n; st.scanned++) {
          const k = eqKey(leftOf(pool[st.scanned]));
          const list = st.index.get(k);
          if (list) list.push(st.scanned);
          else st.index.set(k, [st.scanned]);
        }
        // A numeric right side also equals, as text, a left value that is not a number.
        const rn = toNumber(right);
        const hit = rn !== null ? mergeSorted(st.index.get(`n:${rn}`) ?? [], st.index.get(`s:${right}`) ?? []) : st.index.get(`s:${right}`) ?? [];
        if (st.scanned === n || !hit.length || hit[hit.length - 1] < n) return hit;
        return hit.filter((i) => i < n);
      }
      const ck = `${right}\u0000${n}`;
      let out = st.cache.get(ck);
      if (!out) {
        out = [];
        for (let i = 0; i < n; i++) if (compareValues(leftOf(pool[i]), op, right)) out.push(i);
        if (st.cache.size >= PICK_FILTER_CACHE) st.cache.clear();
        st.cache.set(ck, out);
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
      // Design 0013: filter (positions in pool order) → shuffle → limit.
      let idx = null; // null = 0…n−1, nothing allocated
      const filtered = (c.filter ?? 'none') === 'compare';
      if (filtered) {
        const right = renderTemplate(c.filterValue ?? '', scope, undefined); // once, scope at the start
        idx = n ? filterIndices(step, c, pool, n, right) : [];
        if (n) {
          let f = eachFilterStats.get(step.id);
          if (!f) eachFilterStats.set(step.id, (f = { visits: 0, matched: 0 }));
          f.visits++;
          if (idx.length) f.matched++;
        }
      }
      const m0 = idx ? idx.length : n;
      const limit = Number(c.limit ?? 0) || 0;
      const m = limit > 0 ? Math.min(limit, m0) : m0;
      if (m > LIMITS.maxCountPerNode) {
        fail(step, filtered
          ? `Pool "${c.from}" còn ${nf(m)} bản ghi sau khi lọc, quá giới hạn ${nf(LIMITS.maxCountPerNode)} lần lặp của một bước Lặp. Đặt "Tối đa số bản ghi" hoặc thu hẹp điều kiện lọc.`
          : `Pool "${c.from}" có ${nf(n)} bản ghi, quá giới hạn ${nf(LIMITS.maxCountPerNode)} lần lặp của một bước Lặp. Thu hẹp pool (WHERE/LIMIT của Query) hoặc giảm số bản ghi.`, 'from');
      }
      // Exactly m numbers, before any step of the body (also when the body is empty).
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

    /** Lặp "Mỗi giá trị trong danh sách" (design 0013): once per value, in order, without the rng. */
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
              // Only with a variable: an old workflow without `min` and `max: 0` still draws rng.int(1, 0).
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
        for (const key of ['count', 'min', 'max']) {
          const w = numberWarns.get(`${step.id}|${key}`);
          if (!w) continue;
          const name = step.config?.alias || 'loop';
          const label = nodeTypeMap.get(step.type)?.options.find((o) => o.key === key)?.label ?? key;
          if (w.empty) {
            // What 0 means for each option (review 0013 S2): no iteration for "Số lần lặp"; for a
            // range, 0 as "Ít nhất", and "Nhiều nhất" 0 → the run uses "Ít nhất" (max < min).
            const minLabel = nodeTypeMap.get(step.type)?.options.find((o) => o.key === 'min')?.label ?? 'min';
            const effect = key === 'count'
              ? 'nên các lần đó lặp 0 lần'
              : key === 'min' ? `nên các lần đó lấy "${label}" = 0` : `nên các lần đó lặp đúng "${minLabel}" lần`;
            runWarnings.push({
              message: `Bước Lặp "${name}": "${label}" = {{${w.path}}} trống, âm hoặc không phải số ở ${nf(w.empty)}/${nf(w.runs)} lần chạy qua, ${effect}. Kiểm tra field trong org hoặc chọn biến khác.`,
              nodeId: step.id,
              field: key,
              code: 'numberVarEmpty',
            });
          }
          if (w.clamped) {
            runWarnings.push({
              message: `Bước Lặp "${name}": "${label}" = {{${w.path}}} lớn hơn ${nf(LIMITS.maxCountPerNode)} ở ${nf(w.clamped)}/${nf(w.runs)} lần chạy qua, nên đã dùng ${nf(LIMITS.maxCountPerNode)}.`,
              nodeId: step.id,
              field: key,
              code: 'numberVarClamped',
            });
          }
        }
        const ef = eachFilterStats.get(step.id);
        if (ef && ef.visits && !ef.matched) {
          runWarnings.push({
            message: `Bước Lặp "${step.config?.itemAlias || step.config?.alias || 'loop'}": không bản ghi nào của pool "${step.config?.from}" thỏa điều kiện lọc ở cả ${nf(ef.visits)} lần chạy qua, nên các bước bên trong không chạy. Kiểm tra field lọc (có trong "Field cần lấy" của Query chưa?) và giá trị so sánh.`,
            nodeId: step.id,
            field: 'filterValue',
            code: 'eachFilterEmpty',
          });
        }
        if (step.type === 'pick' && weightZero.get(step.id)) {
          runWarnings.push({
            message: `Bước Chọn bản ghi "${step.config?.alias}": ${nf(weightZero.get(step.id))}/${nf(s?.runs ?? 0)} lần mọi bản ghi có trọng số 0 (field "${step.config?.weightField}" trống hoặc không phải số) nên đã chọn đều. Kiểm tra field trọng số hoặc thêm nó vào "Field cần lấy" của Query.`,
            nodeId: step.id,
            field: 'weightField',
            code: 'pickWeightZero',
          });
        }
        if (step.type === 'pick' && weightHuge.get(step.id)) {
          runWarnings.push({
            message: `Bước Chọn bản ghi "${step.config?.alias}": ${nf(weightHuge.get(step.id))}/${nf(s?.runs ?? 0)} lần tổng trọng số của field "${step.config?.weightField}" quá lớn để tính nên đã chọn đều. Dùng field có giá trị nhỏ hơn (ví dụ NumberOfEmployees thay cho một số rất lớn).`,
            nodeId: step.id,
            field: 'weightField',
            code: 'pickWeightZero',
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
