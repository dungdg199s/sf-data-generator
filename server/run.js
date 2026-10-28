// Run driver (design 0004): consumes the record stream of a prepared run (executor createRun)
// with sinks, and reports progress as events. The executor stays pure and synchronous; this
// module is where time passes: it yields the event loop every YIELD_EVERY records, throttles
// progress events, honours the cancel signal and awaits the inserter (whose pace is the org's).
//
//   pass 1 (always): preview sink — counts per sObject, keeps the first `previewRows` records of
//                    each sObject (every record with `collect`). For an org target this is the dry
//                    pass: a generation error (unique values exhausted, maxRecords…) stops the run
//                    before anything is written.
//   pass 2 (org target only): a fresh records() — same seed, now and queryResults, so the very same
//                    sequence — streamed into the windowed inserter (server/sf/insert.js).
//
// Events (emit): start, progress (phase generate | insert | stopping), plan, done, error — the
// NDJSON lines of /api/run (docs/workflow-schema.md). `executeRun` resolves with the final event.
//
// Design 0011: before the first write, the plan (shared/insert-plan.js: which Record steps go
// through Bulk API 2.0) is computed from the dry pass, and the run is recorded in the history
// (server/history.js, `record.history`): a history that cannot be written means nothing is written
// to the org. Every Id the inserter gets is appended to the history before its next call.

import { randomBytes } from 'node:crypto';
import { WorkflowError } from './workflow/schema.js';
import { LIMITS } from './workflow/nodes.js';
import { createInserter, BATCH_SIZE } from './sf/insert.js';
import { TICK } from './workflow/executor.js';
import { planInsert } from '../shared/insert-plan.js';

export const YIELD_EVERY = 1000;
export const PROGRESS_INTERVAL_MS = 250;
/** Longest stretch of synchronous generation between two looks at the event loop / Dừng. */
export const YIELD_AFTER_MS = 50;

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const aliasOf = (ref) => String(ref).slice(0, String(ref).lastIndexOf('#'));

/**
 * Runs in progress (inserts, previews, deletes): runId → { controller, force } (POST
 * /api/runs/:runId/cancel). `force` (Dừng ngay, design 0011) also aborts the Bulk job being processed.
 */
export function createRunRegistry() {
  const runs = new Map();
  return {
    open() {
      let id;
      do id = `r${randomBytes(4).toString('hex')}`; while (runs.has(id));
      const controller = new AbortController();
      const force = new AbortController();
      runs.set(id, { controller, force });
      return { id, signal: controller.signal, forceSignal: force.signal, close: () => runs.delete(id) };
    },
    cancel(id, { force = false } = {}) {
      const c = runs.get(id);
      if (!c) return false;
      c.controller.abort();
      if (force) c.force.abort();
      return true;
    },
    get size() {
      return runs.size;
    },
  };
}

/** API calls an all-Collections insert needs at least: Σ ceil(n / 200) per sObject. */
export function estimateApiCalls(bySobject) {
  return Object.values(bySobject).reduce((n, count) => n + Math.ceil(count / BATCH_SIZE), 0);
}

/**
 * @param run       createRun(...) result
 * @param target    org to insert into, or null for a preview
 * @param sfClient  server/sf/client.js client (insert only)
 * @param signal    AbortSignal (Dừng, closed connection)
 * @param emit      (event) → void
 * @param start     extra keys of the `start` event and the result (runId, queries)
 * @param collect   keep every record (JSON response) instead of the first previewRows per sObject
 * → the final event: { type: 'done', result } or { type: 'error', error, issues?, insert }
 */
export async function executeRun({
  run, target = null, sfClient, signal, forceSignal, emit = () => {}, start = {}, collect = false,
  previewRows = LIMITS.previewRows, progressIntervalMs = PROGRESS_INTERVAL_MS, clock = () => Date.now(), insertOptions = {},
  bulk = 'auto', record = null,
}) {
  const started = clock();
  const { runId, queries, warnings: extraWarnings = [] } = start;
  emit({ type: 'start', ...(runId ? { runId } : {}), seed: run.seed, now: run.now, warnings: [...run.warnings, ...extraWarnings], ...(queries ? { queries } : {}) });

  let lastProgress = 0;
  const due = (force) => {
    const t = clock();
    if (!force && t - lastProgress < progressIntervalMs) return false;
    lastProgress = t;
    return true;
  };

  // ---------- pass 1: preview / dry pass ----------
  const kept = [];
  const keptBySobject = {};
  const stepOrder = new Map(); // nodeId → { alias, sobject, records }, in the order of each step's first record
  let it = run.records({ ticks: true });
  let end;
  let n = 0;
  let lastYield = clock();
  try {
    for (;;) {
      const step = it.next();
      if (step.done) {
        end = step.value;
        break;
      }
      const rec = step.value;
      // Yield every YIELD_EVERY records, or after YIELD_AFTER_MS (TICK: steps without records).
      let breathe = false;
      if (rec === TICK) breathe = clock() - lastYield >= YIELD_AFTER_MS;
      else {
        const so = stepOrder.get(rec.nodeId);
        if (so) so.records++;
        else stepOrder.set(rec.nodeId, { alias: rec.alias ?? aliasOf(rec.ref), sobject: rec.sobject, records: 1 });
        const k = (keptBySobject[rec.sobject] ?? 0);
        if (collect || k < previewRows) {
          kept.push(rec);
          keptBySobject[rec.sobject] = k + 1;
        }
        breathe = ++n % YIELD_EVERY === 0 || (n % 64 === 0 && clock() - lastYield >= YIELD_AFTER_MS);
      }
      if (breathe) {
        await nextTick();
        lastYield = clock();
        if (signal?.aborted) {
          it.return();
          return finish();
        }
        if (due()) emit({ type: 'progress', phase: 'generate', generated: it.live.total, bySobject: { ...it.live.bySobject }, byStep: it.live.byStep });
      }
    }
  } catch (e) {
    return fail(e, null);
  }
  const total = end.stats.total;
  const bySobject = end.stats.bySobject;
  const resultBase = () => ({
    ...(runId ? { runId } : {}),
    seed: run.seed,
    now: run.now,
    warnings: [...run.warnings, ...extraWarnings, ...end.warnings],
    stats: { ...end.stats, durationMs: clock() - started, previewRows, truncated: !collect && Object.entries(bySobject).some(([s, c]) => c > (keptBySobject[s] ?? 0)) },
    records: kept,
    samples: end.samples,
    ...(queries ? { queries } : {}),
  });

  if (!target) return done(resultBase());
  // A Dừng (or a closed connection) that arrived while pass 1 ran synchronously is only seen
  // once the event loop turns: look right before writing anything.
  await nextTick();
  if (signal?.aborted) return finish(resultBase());

  // ---------- pass 2: insert ----------
  const plan = planInsert({
    steps: [...stepOrder].map(([nodeId, s]) => ({ nodeId, alias: s.alias, sobject: s.sobject, records: s.records })),
    referenced: run.referencedAliases,
    bulk,
    limits: LIMITS,
  });
  // The history entry exists before the first write; without it nothing is written.
  let entry = null;
  if (record?.history) {
    try {
      const org = await Promise.resolve(record.org).catch(() => null);
      entry = await record.history.create({ org: { alias: target, ...org }, workflow: record.workflow, seed: run.seed, now: run.now, bulk, steps: plan.steps, total });
    } catch (e) {
      const ev = {
        type: 'error',
        error: `Không ghi được Lịch sử (${e.message}), nên chưa ghi gì vào org. Kiểm tra quyền ghi thư mục ${record.history.dir} hoặc đặt SFDG_DATA_DIR.`,
        insert: null,
      };
      emit(ev);
      return ev;
    }
  }
  emit({
    type: 'plan',
    total,
    bySobject,
    apiCalls: plan.apiCalls.total,
    apiCallsBy: { collections: plan.apiCalls.collections, bulk: plan.apiCalls.bulk },
    steps: plan.steps.map(({ nodeId, sobject, mode, probe, jobs }) => ({ nodeId, sobject, mode, probe, jobs })),
    ...(entry ? { historyId: entry.id } : {}),
  });
  const previewRefs = new Set(kept.map((r) => r.ref));
  const keepId = collect ? () => true : (ref) => previewRefs.has(ref) || run.referencedAliases.has(aliasOf(ref));
  const insertProgress = (s) => ({
    type: 'progress',
    phase: 'insert',
    inserted: s.inserted,
    failed: s.failed,
    total,
    bySobject: Object.fromEntries(Object.entries(bySobject).map(([so, t]) => [so, { inserted: s.bySobject[so]?.inserted ?? 0, failed: s.bySobject[so]?.failed ?? 0, total: t }])),
    ...(s.bulk ? { bulk: s.bulk } : {}),
  });
  const inserter = createInserter(sfClient, target, {
    ...insertOptions,
    keepId,
    signal,
    forceSignal,
    plan: Object.fromEntries(plan.steps.map((s) => [s.nodeId, s])),
    onInserted: entry ? (rows) => entry.appendIds(rows) : null,
    onBulkJob: entry ? (job) => entry.recordJob(job) : null,
    onBatch: (s) => {
      // Dừng while a Bulk job is processed: it is waited for (or aborted with Dừng ngay).
      if (s.waitingBulk) emit({ type: 'progress', phase: 'stopping', waitingBulk: s.waitingBulk, inserted: s.inserted, failed: s.failed, total });
      else if (due()) emit(insertProgress(s));
    },
  });
  it = run.records({ ticks: true });
  let pushed = 0;
  let summary;
  lastYield = clock();
  try {
    for (;;) {
      if (signal?.aborted || inserter.stopped) break;
      const step = it.next();
      if (step.done) break;
      if (step.value === TICK) {
        if (clock() - lastYield >= YIELD_AFTER_MS) {
          await nextTick();
          lastYield = clock();
        }
        continue;
      }
      await inserter.push(step.value);
      if (++pushed % YIELD_EVERY === 0) {
        await nextTick();
        lastYield = clock();
      }
    }
    it.return();
    summary = await inserter.end();
  } catch (e) {
    summary = await inserter.end().catch(() => null);
    const partial = summary && insertSummary(summary, pushed);
    await finishEntry(partial, 'error');
    return fail(e, partial);
  }
  emit(insertProgress(summary));
  const ins = insertSummary(summary, pushed);
  await finishEntry(ins, ins.stopped ? 'stopped' : ins.cancelled ? 'cancelled' : 'done');
  const base = resultBase();
  return done({ ...base, warnings: [...base.warnings, ...bulkWarnings(summary.warnings)], insert: ins });

  function insertSummary(s, sent) {
    const notSent = total - sent + s.notSent;
    const cancelled = !s.stopped && (s.cancelled || (Boolean(signal?.aborted) && notSent > 0));
    // The streamed result carries the Ids of the preview rows only (Lookup targets were kept for the insert).
    const ids = collect ? s.ids : Object.fromEntries(Object.entries(s.ids).filter(([ref]) => previewRefs.has(ref)));
    const { bulkJobs, warnings: _w, ...rest } = s;
    return { ...rest, ids, notSent, cancelled, stopped: s.stopped, total, ...(entry ? { historyId: entry.id } : {}) };
  }

  /** "Bước "con": Bulk API 2.0 không nhận …" warnings of steps that fell back to Collections. */
  function bulkWarnings(list) {
    return (list ?? []).map((w) => {
      const step = plan.steps.find((s) => s.nodeId === w.nodeId);
      return { nodeId: w.nodeId, message: `Bước "${step?.alias ?? w.nodeId}": Bulk API 2.0 không nhận ${w.sobject} (${w.error}), nên đã gửi bằng sObject Collections.` };
    });
  }

  /** Final counts and status of the history entry (the Ids are on disk already). */
  async function finishEntry(ins, status) {
    if (!entry) return;
    const byStep = ins?.byStep ?? {};
    try {
      await entry.finish({
        status,
        steps: entry.data.steps.map((st) => ({ ...st, inserted: byStep[st.nodeId]?.inserted ?? 0, failed: byStep[st.nodeId]?.failed ?? 0 })),
        inserted: ins?.inserted ?? 0,
        failed: ins?.failed ?? 0,
        notSent: ins?.notSent ?? 0,
        errorGroups: ins?.errorGroups ?? [],
        errorGroupsOther: ins?.errorGroupsOther ?? null,
        stopped: ins?.stopped ?? null,
        bulkAborted: ins?.bulkAborted ?? null,
        warnings: bulkWarnings(summary?.warnings),
      });
    } catch (e) {
      console.error(e); // the Ids are on disk; only the summary of the json is stale
    }
  }

  function done(result) {
    const ev = { type: 'done', result };
    emit(ev);
    return ev;
  }

  /** Cancelled before anything was written (preview or dry pass); `base` once pass 1 is complete. */
  function finish(base) {
    const live = it.live;
    const result = base ?? {
      ...(runId ? { runId } : {}),
      seed: run.seed,
      now: run.now,
      warnings: [...run.warnings, ...extraWarnings],
      stats: { total: live.total, bySobject: { ...live.bySobject }, byStep: live.byStep, durationMs: clock() - started, previewRows, truncated: true },
      records: kept,
      samples: {},
      ...(queries ? { queries } : {}),
    };
    result.cancelled = true;
    if (target) {
      const t = result.stats.total;
      result.insert = { inserted: 0, failed: 0, errorsTotal: 0, errors: [], errorGroups: [], errorGroupsOther: null, ids: {}, bySobject: {}, notSent: t, cancelled: true, stopped: null, total: t };
    }
    return done(result);
  }

  function fail(e, insert) {
    const ev = e instanceof WorkflowError
      ? {
        type: 'error',
        error: target && !insert ? `Lỗi khi sinh dữ liệu, chưa ghi bản ghi nào vào org: ${e.message}` : 'Workflow chưa hợp lệ.',
        issues: e.issues,
        insert: insert ?? null,
      }
      : { type: 'error', error: e.message || String(e), insert: insert ?? null };
    if (!(e instanceof WorkflowError) && !e.status) console.error(e);
    emit(ev);
    return ev;
  }
}
