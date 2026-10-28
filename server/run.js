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
// Events (emit): start, progress (phase generate | insert), plan, done, error — the NDJSON lines
// of /api/run (docs/workflow-schema.md). `executeRun` resolves with the final event.

import { randomBytes } from 'node:crypto';
import { WorkflowError } from './workflow/schema.js';
import { LIMITS } from './workflow/nodes.js';
import { createInserter, BATCH_SIZE } from './sf/insert.js';

export const YIELD_EVERY = 1000;
export const PROGRESS_INTERVAL_MS = 250;

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const aliasOf = (ref) => String(ref).slice(0, String(ref).lastIndexOf('#'));

/** Runs in progress: runId → AbortController (POST /api/runs/:runId/cancel). */
export function createRunRegistry() {
  const runs = new Map();
  return {
    open() {
      let id;
      do id = `r${randomBytes(4).toString('hex')}`; while (runs.has(id));
      const controller = new AbortController();
      runs.set(id, controller);
      return { id, signal: controller.signal, close: () => runs.delete(id) };
    },
    cancel(id) {
      const c = runs.get(id);
      if (!c) return false;
      c.abort();
      return true;
    },
    get size() {
      return runs.size;
    },
  };
}

/** API calls an insert needs at least: Σ ceil(n / 200) per sObject. */
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
  run, target = null, sfClient, signal, emit = () => {}, start = {}, collect = false,
  previewRows = LIMITS.previewRows, progressIntervalMs = PROGRESS_INTERVAL_MS, clock = () => Date.now(), insertOptions = {},
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
  let it = run.records();
  let end;
  let n = 0;
  try {
    for (;;) {
      const step = it.next();
      if (step.done) {
        end = step.value;
        break;
      }
      const rec = step.value;
      const k = (keptBySobject[rec.sobject] ?? 0);
      if (collect || k < previewRows) {
        kept.push(rec);
        keptBySobject[rec.sobject] = k + 1;
      }
      if (++n % YIELD_EVERY === 0) {
        await nextTick();
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
    seed: run.seed,
    now: run.now,
    warnings: [...run.warnings, ...extraWarnings, ...end.warnings],
    stats: { ...end.stats, durationMs: clock() - started, previewRows, truncated: !collect && Object.entries(bySobject).some(([s, c]) => c > (keptBySobject[s] ?? 0)) },
    records: kept,
    samples: end.samples,
    ...(queries ? { queries } : {}),
  });

  if (!target) return done(resultBase());
  if (signal?.aborted) return finish(resultBase());

  // ---------- pass 2: insert ----------
  emit({ type: 'plan', total, bySobject, apiCalls: estimateApiCalls(bySobject) });
  const previewRefs = new Set(kept.map((r) => r.ref));
  const keepId = collect ? () => true : (ref) => previewRefs.has(ref) || run.referencedAliases.has(aliasOf(ref));
  const insertProgress = (s) => ({
    type: 'progress',
    phase: 'insert',
    inserted: s.inserted,
    failed: s.failed,
    total,
    bySobject: Object.fromEntries(Object.entries(bySobject).map(([so, t]) => [so, { inserted: s.bySobject[so]?.inserted ?? 0, failed: s.bySobject[so]?.failed ?? 0, total: t }])),
  });
  const inserter = createInserter(sfClient, target, {
    ...insertOptions,
    keepId,
    signal,
    onBatch: (s) => { if (due()) emit(insertProgress(s)); },
  });
  it = run.records();
  let pushed = 0;
  let summary;
  try {
    for (;;) {
      if (signal?.aborted || inserter.stopped) break;
      const step = it.next();
      if (step.done) break;
      await inserter.push(step.value);
      if (++pushed % YIELD_EVERY === 0) await nextTick();
    }
    it.return();
    summary = await inserter.end();
  } catch (e) {
    summary = await inserter.end().catch(() => null);
    return fail(e, summary && insertSummary(summary, pushed));
  }
  emit(insertProgress(summary));
  return done({ ...resultBase(), insert: insertSummary(summary, pushed) });

  function insertSummary(s, sent) {
    const notSent = total - sent + s.notSent;
    const cancelled = !s.stopped && (s.cancelled || (Boolean(signal?.aborted) && notSent > 0));
    return { ...s, notSent, cancelled, stopped: s.stopped, total };
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
      result.insert = { inserted: 0, failed: 0, errorsTotal: 0, errors: [], errorGroups: [], ids: {}, bySobject: {}, notSent: t, cancelled: true, stopped: null, total: t };
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
