// Deletes the records of one insert of the history (design 0011). Only the Ids the app recorded
// in <hid>.ids.csv (server/history.js) are ever sent: no Id list or SOQL comes from the client,
// Query rows are never in that file, and nothing is hard-deleted (records go to the Recycle Bin).
//
// Order: steps in the reverse order of their first record (children before parents), and inside a
// step the reverse insert order (self-lookups). A step goes through Collections `client.destroy`
// (200 Ids per call); with at least bulkMinRecords Ids it sends a probe through destroy first (the
// fail-fast rule of the insert: the first 3 calls of an sObject all failing ⇒ stop, typically no
// Delete permission), then Bulk `delete` jobs of bulkJobRecords Ids, one at a time. A step starts
// once the previous one is done.
//
// Outcomes per Id: deleted; gone (ENTITY_IS_DELETED, INVALID_CROSS_REFERENCE_KEY, NOT_FOUND:
// deleted by hand, already in the Recycle Bin, or removed with its parent) — not an error; failed
// (grouped like insert errors). Each batch of outcomes is appended to <hid>.deleted.csv and awaited
// before the next call. After every step, Ids that failed with DELETE_FAILED (another record still
// depends on them) are retried once, in the same order.
//
// Bulk insert jobs whose results were never read (interrupted run): their successfulResults are
// fetched first (read only) and appended to the Ids, so they can be deleted too.

import { idsCsv, parseBulkError } from './bulk-csv.js';
import { createErrorGroups, pollBulkJob, interruptibleSleep, BULK_DEFAULTS, FAIL_FAST_BATCHES } from './insert.js';
import { BATCH_SIZE } from '../../shared/insert-plan.js';

export const GONE_CODES = new Set(['ENTITY_IS_DELETED', 'INVALID_CROSS_REFERENCE_KEY', 'NOT_FOUND']);
const RETRY_CODE = 'DELETE_FAILED';

/**
 * Bulk insert jobs of a run whose Ids were not collected. Only a job the app itself knows never
 * reached Salesforce's queue (`neverProcessed`: aborted before its close) is left out — a Failed
 * job can have processed part of its records (review S3).
 */
export function pendingBulkJobs(run) {
  return (run?.bulkJobs ?? []).filter((j) => j?.jobId && !j.idsCollected && !j.neverProcessed);
}

const DONE_STATES = new Set(['JobComplete', 'Failed', 'Aborted']);

/**
 * @param client   server/sf/client.js client (destroy, bulkJob)
 * @param target   org alias / username of the insert
 * @param entry    history handle (server/history.js open()) of the run
 * @param history  the history (remaining())
 * @param bulk     'auto' | 'off'
 * @param signal / forceSignal  Dừng / Dừng ngay
 * @param onProgress ({ deleted, gone, failed, total, bySobject, bulk }) after every call / job check
 * @param limits   { bulkMinRecords, bulkJobRecords }
 * → { deleted, gone, failed, errorGroups, errorGroupsOther, bySobject, remaining, cancelled, stopped, bulkAborted, fetched }
 */
export async function deleteRun({
  client, target, entry, history, bulk = 'auto', signal, forceSignal, onProgress, limits = {}, options = {},
}) {
  const { sleep = interruptibleSleep, clock = () => Date.now(), failFast = FAIL_FAST_BATCHES, ...over } = options;
  const B = { ...BULK_DEFAULTS, jobRecords: limits.bulkJobRecords ?? BULK_DEFAULTS.jobRecords, ...over };
  const minBulk = limits.bulkMinRecords ?? 10000;
  const run = entry.data;

  // Ids of Bulk insert jobs never read: fetched (read only) before anything is deleted.
  let fetched = 0;
  const stillRunning = []; // jobs not finished in Salesforce yet: left pending, the user tries later
  for (const job of pendingBulkJobs(run)) {
    try {
      const h = client.bulkJob(target, { id: job.jobId, operation: 'insert' });
      // Results of a job still running are partial: read them only once the job has ended.
      const st = await h.check();
      if (!DONE_STATES.has(st?.state)) {
        stillRunning.push({ jobId: job.jobId, sobject: job.sobject, state: st?.state ?? '?' });
        continue;
      }
      job.state = st.state;
      const ok = await h.successfulResults();
      const rows = (ok ?? []).filter((l) => l?.sf__Id).map((l) => ({ sobject: job.sobject, step: job.nodeId, ref: '', id: l.sf__Id }));
      if (rows.length) await entry.appendIds(rows);
      fetched += rows.length;
      job.idsCollected = true;
      job.inserted = rows.length;
      await entry.save({ bulkJobs: run.bulkJobs, inserted: (run.inserted ?? 0) + rows.length });
    } catch {
      // Not readable now (network, job deleted by Salesforce after 7 days…): stays pending.
      stillRunning.push({ jobId: job.jobId, sobject: job.sobject, state: 'unreadable' });
    }
  }
  const pendingMessage = stillRunning.length
    ? `Job Bulk ${stillRunning.map((j) => `${j.jobId} (${j.sobject})`).join(', ')} chưa xong hoặc chưa đọc được nên chưa lấy được Id của nó; bản ghi của job đó chưa bị xóa. Thử lại sau bằng "Xóa phần còn lại…" trong Lịch sử.`
    : null;

  const rem = await history.remaining(entry.id, { withIds: true });
  const total = rem.total;
  const groups = createErrorGroups();
  const bySobject = {};
  for (const g of rem.bySteps) bySobject[g.sobject] ??= { total: 0, deleted: 0, gone: 0, failed: 0 };
  for (const g of rem.bySteps) bySobject[g.sobject].total += g.count;
  let deleted = 0;
  let gone = 0;
  let failed = 0;
  let cancelled = false;
  let stopped = null;
  let bulkAborted = null;
  let activeBulk = null;
  const firstCalls = new Map(); // sObject → { calls, anySuccess, failed, message }
  const retry = []; // [{ sobject, nodeId, id }] DELETE_FAILED

  const report = () => onProgress?.({
    deleted, gone, failed, total, bySobject,
    bulk: activeBulk ? { ...activeBulk } : null,
    waitingBulk: activeBulk && signal?.aborted ? { jobId: activeBulk.jobId, sobject: activeBulk.sobject, processed: activeBulk.processed, records: activeBulk.records, forced: Boolean(forceSignal?.aborted) } : null,
  });

  /** Outcomes of one call / job: counted, written to deleted.csv (awaited), failures grouped. */
  async function settle(sobject, nodeId, outcomes, { retrying = false } = {}) {
    const rows = [];
    for (const o of outcomes) {
      if (o.ok) {
        deleted++;
        bySobject[sobject].deleted++;
        rows.push({ id: o.id, outcome: 'deleted' });
      } else if (GONE_CODES.has(o.statusCode)) {
        gone++;
        bySobject[sobject].gone++;
        rows.push({ id: o.id, outcome: 'gone' });
      } else if (!retrying && o.statusCode === RETRY_CODE) {
        retry.push({ sobject, nodeId, id: o.id, message: o.message });
      } else {
        failed++;
        bySobject[sobject].failed++;
        groups.add({ sobject, nodeId, message: o.message, ref: o.id });
      }
    }
    if (rows.length) {
      try {
        await entry.appendDeleted(rows);
      } catch (e) {
        stopped ??= { reason: 'history', message: e.message };
      }
    }
    report();
  }

  const destroyOutcomes = (ids, results, error) => ids.map((id, i) => {
    if (error) return { id, ok: false, statusCode: error.cause?.errorCode, message: error.message };
    const r = results?.[i];
    if (r?.success) return { id, ok: true };
    const e = r?.errors?.[0] ?? {};
    return { id, ok: false, statusCode: e.statusCode, message: `${e.statusCode ? `${e.statusCode}: ` : ''}${e.message ?? 'Lỗi không rõ.'}` };
  });

  const stopNow = () => {
    if (signal?.aborted) cancelled = true;
    return cancelled || Boolean(stopped);
  };

  /** One destroy call (≤ 200 Ids); fail fast on the first calls of an sObject. → any success (deleted or gone) */
  async function destroyCall(sobject, nodeId, ids, opts) {
    let results;
    let error = null;
    try {
      results = await client.destroy(target, sobject, ids);
    } catch (e) {
      error = e;
    }
    const outcomes = destroyOutcomes(ids, results, error);
    const success = outcomes.some((o) => o.ok || GONE_CODES.has(o.statusCode));
    const fc = firstCalls.get(sobject) ?? { calls: 0, anySuccess: false, failed: 0, message: null };
    fc.calls++;
    if (success) fc.anySuccess = true;
    else {
      fc.failed += ids.length;
      fc.message ??= outcomes[0]?.message;
    }
    firstCalls.set(sobject, fc);
    await settle(sobject, nodeId, outcomes, opts);
    if (!opts?.retrying && !fc.anySuccess && fc.calls >= failFast) {
      stopped ??= { reason: 'allFailing', sobject, nodeId, message: fc.message, batches: fc.calls, records: fc.failed };
    }
    return success;
  }

  /** One Bulk delete job; waits for it (Dừng waits, Dừng ngay aborts). */
  async function bulkJob(sobject, nodeId, ids) {
    const job = client.bulkJob(target, { object: sobject, operation: 'delete' });
    try {
      await job.open();
    } catch (e) {
      return { fallback: true, error: e };
    }
    activeBulk = { nodeId, sobject, jobId: job.id, processed: 0, failed: 0, records: ids.length };
    report();
    try {
      await job.upload(idsCsv(ids));
      if (signal?.aborted || forceSignal?.aborted) {
        try { await job.abort(); } catch { /* best effort */ }
        cancelled = true;
        activeBulk = null;
        return { sent: 0 };
      }
      await job.close();
    } catch (e) {
      try { await job.abort(); } catch { /* best effort */ }
      activeBulk = null;
      await settle(sobject, nodeId, ids.map((id) => ({ id, ok: false, message: e.message })));
      return { sent: ids.length };
    }
    const end = await pollBulkJob(job, {
      forceSignal, sleep, clock, opts: B,
      onCheck: (st) => {
        activeBulk.processed = Number(st.numberRecordsProcessed) || 0;
        activeBulk.failed = Number(st.numberRecordsFailed) || 0;
        report();
      },
    });
    let ok = null;
    let ko = null;
    try { ok = await job.successfulResults(); } catch { ok = null; }
    try { ko = await job.failedResults(); } catch { ko = null; }
    const outcomes = [];
    const seen = new Set();
    for (const l of ok ?? []) {
      const id = l.Id || l.sf__Id;
      if (id && !seen.has(id)) {
        seen.add(id);
        outcomes.push({ id, ok: true });
      }
    }
    for (const l of ko ?? []) {
      const id = l.Id || l.sf__Id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const e = parseBulkError(l.sf__Error);
      outcomes.push({ id, ok: false, statusCode: e.statusCode, message: `${e.statusCode ? `${e.statusCode}: ` : ''}${e.message}` });
    }
    if (end.state === 'Failed' && !seen.size) {
      for (const id of ids) outcomes.push({ id, ok: false, message: `Job Bulk ${job.id} (${sobject}) thất bại: ${end.info?.errorMessage ?? 'không rõ lỗi'}.` });
    }
    await settle(sobject, nodeId, outcomes);
    if (end.forced || end.state === 'Aborted') {
      cancelled = true;
      bulkAborted = { jobId: job.id, sobject, nodeId, processed: Math.max(activeBulk.processed, outcomes.length), records: ids.length, idsKnown: ok !== null };
    }
    if (end.timedOut || end.error) {
      stopped ??= { reason: 'bulkTimeout', sobject, nodeId, jobId: job.id, message: `Job Bulk ${job.id} (${sobject}) chưa xong sau ${Math.round(B.timeoutMs / 60000)} phút nên app đã ngừng theo dõi. Job có thể vẫn đang chạy trong org: xem Setup → Bulk Data Load Jobs. Bấm "Xóa phần còn lại…" sau khi nó xong.` };
    }
    activeBulk = null;
    report();
    return { sent: ids.length };
  }

  for (const g of rem.bySteps) {
    const ids = rem.ids.get(g.nodeId) ?? [];
    let i = 0;
    const useBulk = bulk !== 'off' && ids.length >= minBulk;
    let bulkOk = false; // the probe went through (or the sObject cannot go Bulk)
    let noBulk = !useBulk;
    while (i < ids.length) {
      await new Promise((resolve) => setImmediate(resolve));
      if (stopNow()) break;
      if (!noBulk && bulkOk) {
        const chunk = ids.slice(i, i + B.jobRecords);
        const r = await bulkJob(g.sobject, g.nodeId, chunk);
        if (r.fallback) {
          noBulk = true; // this sObject cannot go Bulk: Collections for the rest
          continue;
        }
        i += r.sent;
        if (!r.sent) break;
        continue;
      }
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const success = await destroyCall(g.sobject, g.nodeId, chunk);
      if (success) bulkOk = true;
      i += chunk.length;
    }
    if (stopNow()) break;
  }

  // One more try for the Ids another record still depended on, in the same order. Ids never
  // retried (Dừng, stopped) are failures with their first message.
  let i = 0;
  while (i < retry.length) {
    await new Promise((resolve) => setImmediate(resolve));
    if (stopNow()) break;
    const { sobject, nodeId } = retry[i];
    const chunk = [];
    while (i < retry.length && chunk.length < BATCH_SIZE && retry[i].sobject === sobject && retry[i].nodeId === nodeId) chunk.push(retry[i++].id);
    await destroyCall(sobject, nodeId, chunk, { retrying: true });
  }
  for (const r of retry.slice(i)) {
    failed++;
    bySobject[r.sobject].failed++;
    groups.add({ sobject: r.sobject, nodeId: r.nodeId, message: r.message, ref: r.id });
  }
  report();

  const after = await history.remaining(entry.id);
  return {
    total,
    deleted,
    gone,
    failed,
    errorGroups: groups.list(),
    errorGroupsOther: groups.other(),
    bySobject,
    remaining: after?.total ?? 0,
    cancelled,
    stopped,
    bulkAborted,
    fetched,
    pendingJobs: stillRunning,
    pendingMessage,
  };
}
