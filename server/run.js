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
// Between the two passes (design 0011): `planInsert` (shared/insert-plan.js) decides which Record
// steps go through Bulk API 2.0, and the insert history entry is created (server/history.js) — if
// it cannot be, the run ends with an error before anything is written. Every Id the inserter gets
// back is appended to the entry before its next write call.
//
// Events (emit): start, progress (phase generate | insert), plan, done, error — the NDJSON lines
// of /api/run (docs/workflow-schema.md). `executeRun` resolves with the final event.

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
 * Runs in progress (inserts, previews and deletes): runId → AbortControllers
 * (POST /api/runs/:runId/cancel). `force` (Dừng ngay, design 0011) also aborts the Bulk job in flight.
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

/** API calls an insert needs through sObject Collections only: Σ ceil(n / 200) per sObject. */
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
 * @param forceSignal AbortSignal: Dừng ngay (abort the Bulk job in flight)
 * @param bulk      'auto' | 'off' (target.bulk)
 * @param history   server/history.js store: an insert gets an entry (none ⇒ no history: scripts, tests)
 * @param org       org identity for history (or a Promise of it): { alias, username, orgId, instanceUrl, kind }
 * @param workflow  the workflow snapshot stored in history
 * → the final event: { type: 'done', result } or { type: 'error', error, issues?, insert }
 */
export async function executeRun({
  run, target = null, sfClient, signal, forceSignal, emit = () => {}, start = {}, collect = false,
  previewRows = LIMITS.previewRows, progressIntervalMs = PROGRESS_INTERVAL_MS, clock = () => Date.now(), insertOptions = {},
  bulk = 'auto', history = null, org = null, workflow = null,
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
  const stepsSeen = new Map(); // Record step → { nodeId, alias, sobject, records }, in first-record order
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
        if (rec.nodeId) {
          const st = stepsSeen.get(rec.nodeId);
          if (st) st.records++;
          else stepsSeen.set(rec.nodeId, { nodeId: rec.nodeId, alias: rec.alias, sobject: rec.sobject, records: 1 });
        }
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
  const plan = planInsert({ steps: [...stepsSeen.values()], referenced: run.referencedAliases, bulk, limits: LIMITS });
  // Who the org is, from the connection that writes (review of 0011, S5): unknown ⇒ no write.
  let orgIdentity = null;
  if (org) {
    try {
      orgIdentity = await org;
    } catch (e) {
      const ev = { type: 'error', error: `Không xác định được org "${target}" (${e.message}), nên chưa ghi gì vào org. Đăng nhập lại: sf org login web --alias ${target} rồi chạy lại.`, insert: null };
      emit(ev);
      return ev;
    }
  }
  // History entry before the first write; no entry ⇒ nothing is written (design 0011 §5).
  let hid = null;
  let releaseHistory = () => {};
  let historyWarnings = [];
  if (history) {
    try {
      // S4: a full history drops the oldest entries; one that still has records in an org is named.
      const doomed = await history.prunePreview?.() ?? [];
      historyWarnings = doomed.map((e) => ({
        code: 'historyPruned',
        historyId: e.id,
        message: `Lịch sử đã đầy nên lần insert này bỏ ghi chép của lần insert lúc ${e.startedAt} vào org "${e.org?.alias ?? e.org?.username ?? '?'}"${e.workflowName ? ` (workflow "${e.workflowName}")` : ''}, còn ${e.remaining} bản ghi trong org: sau đó không tải Id hay xóa dữ liệu của lần đó qua app được nữa.`,
      }));
      hid = await history.create({ org: orgIdentity ?? { alias: target }, workflow, seed: run.seed, now: run.now, bulk, steps: plan.steps, total });
      releaseHistory = history.markActive(hid, 'insert');
    } catch (e) {
      const ev = { type: 'error', error: `Không ghi được Lịch sử (${e.message}), nên chưa ghi gì vào org.${e.locked ? '' : ` Kiểm tra quyền ghi thư mục ${history.dir} hoặc đặt SFDG_DATA_DIR.`}`, insert: null };
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
    ...(hid ? { historyId: hid } : {}),
    ...(historyWarnings.length ? { warnings: historyWarnings } : {}),
  });
  const previewRefs = new Set(kept.map((r) => r.ref));
  const keepId = collect ? () => true : (ref) => previewRefs.has(ref) || run.referencedAliases.has(aliasOf(ref));
  try {
    return await insertPass();
  } finally {
    releaseHistory();
  }

  async function insertPass() {
    const insertProgress = (s) => ({
      type: 'progress',
      phase: 'insert',
      inserted: s.inserted,
      failed: s.failed,
      total,
      bySobject: Object.fromEntries(Object.entries(bySobject).map(([so, t]) => [so, { inserted: s.bySobject[so]?.inserted ?? 0, failed: s.bySobject[so]?.failed ?? 0, total: t }])),
      // Design 0012 D: per Record step (only steps with records sent or skipped so far).
      byStep: Object.fromEntries(Object.entries(s.byStep ?? {}).map(([id, c]) => [id, { inserted: c.inserted, failed: c.failed }])),
      // Design 0011: the Bulk job in flight (its processed records are already in `inserted`).
      ...(s.bulk ? { bulk: s.bulk } : {}),
    });
    // Writes go through the session whoami checked (pinned connection), the alias only without one.
    const inserter = createInserter(sfClient, orgIdentity?.session ?? target, {
      ...insertOptions,
      keepId,
      signal,
      forceSignal,
      plan,
      onInserted: hid ? (rows) => history.appendIds(hid, rows) : null,
      onJob: hid ? (job) => history.update(hid, (d) => ({ bulkJobs: [...(d.bulkJobs ?? []).filter((j) => j.jobId !== job.jobId), { ...job }] })) : null,
      onBatch: (s) => {
        if (!due()) return;
        // Dừng while a Bulk job is processed: the run waits for it (design 0011 §3).
        if (signal?.aborted && s.bulk && s.bulk.state !== 'Open') {
          emit({ type: 'progress', phase: 'stopping', waitingBulk: { jobId: s.bulk.jobId, sobject: s.bulk.sobject, nodeId: s.bulk.nodeId, processed: s.bulk.processed, records: s.bulk.records } });
        } else emit(insertProgress(s));
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
      await finishHistory(partial, 'error', e.message);
      return fail(e, partial);
    }
    emit(insertProgress(summary));
    const insert = insertSummary(summary, pushed);
    await finishHistory(insert);
    const base = resultBase();
    if (summary.warnings?.length) base.warnings = [...base.warnings, ...summary.warnings];
    return done({ ...base, insert });
  }

  function insertSummary(s, sent) {
    const notSent = total - sent + s.notSent;
    const cancelled = !s.stopped && (s.cancelled || (Boolean(signal?.aborted) && notSent > 0));
    // The streamed result carries the Ids of the preview rows only (Lookup targets were kept for the insert).
    const ids = collect ? s.ids : Object.fromEntries(Object.entries(s.ids).filter(([ref]) => previewRefs.has(ref)));
    return { ...s, ids, notSent, cancelled, stopped: s.stopped, total, ...(hid ? { historyId: hid } : {}) };
  }

  /** Final state of the history entry (never throws: the insert result matters more). */
  async function finishHistory(s, status, error) {
    if (!hid) return;
    const st = status ?? (s?.stopped ? 'stopped' : s?.cancelled ? 'cancelled' : 'done');
    const steps = plan.steps.map((p) => ({
      nodeId: p.nodeId, alias: p.alias, sobject: p.sobject, mode: p.mode, total: p.records,
      inserted: s?.byStep?.[p.nodeId]?.inserted ?? 0, failed: s?.byStep?.[p.nodeId]?.failed ?? 0,
      ...(s?.bulk?.find((b) => b.nodeId === p.nodeId)?.fallback ? { fallback: true } : {}),
    }));
    await history.finish(hid, {
      status: st,
      steps,
      inserted: s?.inserted ?? 0,
      failed: s?.failed ?? 0,
      notSent: s?.notSent ?? 0,
      ...(s?.bulkJobs ? { bulkJobs: s.bulkJobs } : {}),
      errorGroups: (s?.errorGroups ?? []).map(({ sobject, nodeId, field, message, count }) => ({ sobject, nodeId, field, message, count })),
      errorGroupsOther: s?.errorGroupsOther ?? null,
      stopped: s?.stopped ?? null,
      warnings: s?.warnings ?? [],
      bulkAborted: s?.bulkAborted ?? null,
      bulkUnknown: s?.bulkUnknown ?? 0,
      ...(error ? { error } : {}),
    }).catch((e) => console.error('history:', e.message));
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
      // The samples met so far (design 0013 F): a cancelled preview still feeds the variable picker.
      samples: it.samples ?? {},
      ...(queries ? { queries } : {}),
    };
    result.cancelled = true;
    if (target) {
      const t = result.stats.total;
      result.insert = { inserted: 0, failed: 0, errorsTotal: 0, errors: [], errorGroups: [], errorGroupsOther: null, ids: {}, bySobject: {}, byStep: {}, notSent: t, cancelled: true, stopped: null, total: t };
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
