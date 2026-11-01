// Delete the records of one insert (design 0011 §7). Only Ids the server wrote to that insert's
// history file are ever sent — no endpoint takes Ids or SOQL from a client — and only through
// client.destroy (sObject Collections, Recycle Bin) or a Bulk API 2.0 job with operation 'delete'
// (never hardDelete). The endpoint (server/index.js) checks every precondition (confirm, org
// identity, production name, nothing running) before this module is called.
//
// Order: the entry's steps in reverse insert order (children before parents: a parent is always
// inserted before its children), and within a step the Ids in reverse order (self-lookups). A step
// with fewer than bulkMinRecords Ids left (or bulk 'off') goes 200 Ids per destroy call; a larger
// one goes by destroy until one call succeeds (the probe: a missing Delete permission is caught by
// the fail-fast rule of the insert, 3 calls of an sObject failing completely), then by Bulk delete
// jobs of bulkJobRecords Ids, one at a time. The next step starts when the previous one is done.
//
// Outcomes per Id: deleted; gone (ENTITY_IS_DELETED, INVALID_CROSS_REFERENCE_KEY, NOT_FOUND:
// deleted by hand, already in the Recycle Bin, or cascaded from a parent) — not an error; failed
// (grouped like insert errors). Each batch of outcomes is appended to <hid>.deleted.csv and
// awaited before the next call; if that write fails the delete stops (`stopped.reason: 'history'`).
// Ids failing with DELETE_FAILED (another record still depends on them) get one more try at the end.
//
// Bulk insert jobs whose results were never collected (interrupted run) are read first (read-only)
// and their Ids appended to the history file, so they are deleted too.

import { errorPattern, BATCH_SIZE, FAIL_FAST_BATCHES, MAX_ERROR_GROUPS } from './insert.js';
import { parseResultCsv, parseBulkError } from './bulk-csv.js';
import { waitForJob } from './bulk-job.js';
import { BULK_DEFAULTS } from '../../shared/insert-plan.js';

export const GONE_CODES = new Set(['ENTITY_IS_DELETED', 'INVALID_CROSS_REFERENCE_KEY', 'NOT_FOUND']);
const RETRY_CODE = 'DELETE_FAILED';
const ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const GROUP_EXAMPLES = 3;

/**
 * @param client   server/sf/client.js client (destroy, bulkJob)
 * @param history  server/history.js store
 * @param hid      history entry
 * @param target   org alias / username (checked by the caller)
 * @param bulk     'auto' | 'off'
 * @param signal / forceSignal  Dừng / Dừng ngay
 * @param onProgress ({ deleted, gone, failed, total, bySobject, bulk? })
 * → { deleted, gone, failed, errorGroups, errorGroupsOther, bySobject, remaining, cancelled, stopped, bulkAborted, collected }
 */
export async function deleteRun({
  client, history, hid, target, bulk = 'auto', signal, forceSignal, onProgress,
  bulkOptions = {}, failFast = FAIL_FAST_BATCHES, batchSize = BATCH_SIZE,
  minBulk = BULK_DEFAULTS.bulkMinRecords, jobRecords = BULK_DEFAULTS.bulkJobRecords,
}) {
  const entry = await history.read(hid);
  const collected = await collectPendingJobs({ client, history, hid, target, entry });
  const rem = await history.remaining(hid);
  const total = rem.total;
  const bySobject = {};
  for (const s of rem.steps) {
    if (!s.ids.length) continue;
    const c = (bySobject[s.sobject] ??= { deleted: 0, gone: 0, failed: 0, total: 0 });
    c.total += s.ids.length;
  }
  let deleted = 0;
  let gone = 0;
  let failed = 0;
  let cancelled = false;
  let stopped = null;
  let bulkAborted = null;
  let active = null;
  const groups = new Map();
  const otherGroups = { groups: 0, count: 0 };
  const retry = []; // { sobject, nodeId, id }
  const firstCalls = new Map(); // sObject → { calls, anySuccess, failed, message }
  const sent = new Set(); // never the same Id twice in one run

  const progress = () => onProgress?.({ deleted, gone, failed, total, bySobject, ...(active ? { bulk: { ...active } } : {}) });
  const isStopped = () => {
    if (signal?.aborted) cancelled = true;
    return cancelled || Boolean(stopped);
  };

  function failOne(sobject, nodeId, id, message, code) {
    failed++;
    bySobject[sobject].failed++;
    const key = `${sobject}\u0000${nodeId ?? ''}\u0000${errorPattern(message)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (g.ids.length < GROUP_EXAMPLES) g.ids.push(id);
    } else if (groups.size < MAX_ERROR_GROUPS) groups.set(key, { sobject, ...(nodeId ? { nodeId } : {}), message, ...(code ? { statusCode: code } : {}), count: 1, ids: [id] });
    else {
      otherGroups.count++;
      otherGroups.groups = Math.min(otherGroups.groups + 1, 10000);
    }
  }

  /** Outcomes of one call: [{ id, ok, code, message }] → counts, history file, retry list. */
  async function settle(sobject, nodeId, outcomes, { retrying = false } = {}) {
    const rows = [];
    let ok = 0;
    let bad = 0;
    let firstMessage = null;
    for (const o of outcomes) {
      if (o.ok) {
        deleted++;
        bySobject[sobject].deleted++;
        rows.push({ id: o.id, outcome: 'deleted' });
        ok++;
      } else if (GONE_CODES.has(o.code)) {
        gone++;
        bySobject[sobject].gone++;
        rows.push({ id: o.id, outcome: 'gone' });
        ok++;
      } else if (o.code === RETRY_CODE && !retrying) {
        retry.push({ sobject, nodeId, id: o.id, message: o.message, code: o.code });
        bad++;
        firstMessage ??= o.message;
      } else {
        failOne(sobject, nodeId, o.id, o.message, o.code);
        bad++;
        firstMessage ??= o.message;
      }
    }
    try {
      await history.appendDeleted(hid, rows);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
    }
    return { ok, bad, firstMessage };
  }

  async function destroyCall(sobject, nodeId, ids, opts) {
    for (const id of ids) sent.add(id);
    let results;
    try {
      results = await client.destroy(target, sobject, ids);
    } catch (e) {
      results = ids.map(() => ({ success: false, errors: [{ message: e.message }] }));
    }
    const outcomes = ids.map((id, i) => {
      const r = results?.[i];
      if (r?.success) return { id, ok: true };
      const er = r?.errors?.[0] ?? {};
      const message = (r?.errors ?? []).map((x) => `${x.statusCode ? `${x.statusCode}: ` : ''}${x.message}`).join('; ') || 'Lỗi không rõ.';
      return { id, ok: false, code: er.statusCode ?? null, message };
    });
    const r = await settle(sobject, nodeId, outcomes, opts);
    const fc = firstCalls.get(sobject) ?? { calls: 0, anySuccess: false, message: null, failed: 0 };
    fc.calls++;
    if (r.ok) fc.anySuccess = true;
    fc.failed += r.bad;
    fc.message ??= r.firstMessage;
    firstCalls.set(sobject, fc);
    if (!fc.anySuccess && fc.calls >= failFast) {
      stopped ??= {
        reason: 'allFailing', sobject, nodeId, batches: fc.calls, records: fc.failed, message: fc.message,
        text: `Đã dừng xóa: ${fc.calls} lời gọi xóa ${sobject} đầu tiên đều lỗi "${fc.message}". Kiểm tra quyền Delete của user trên ${sobject}. Chưa xóa bản ghi ${sobject} nào.`,
      };
    }
    progress();
    return fc;
  }

  /** One Bulk delete job of `ids`. → false when the step must go on by destroy (job could not open). */
  async function bulkDelete(sobject, nodeId, ids) {
    active = { nodeId, sobject, jobId: null, processed: 0, failed: 0, records: ids.length, state: 'Open' };
    let handle;
    try {
      handle = client.bulkJob(target, { object: sobject, operation: 'delete' });
      await handle.open();
    } catch {
      active = null;
      return false;
    }
    active.jobId = handle.id;
    for (const id of ids) sent.add(id);
    const abortOpen = async () => {
      try {
        await handle.abort();
      } catch {
        // an Open job holds nothing
      }
      active = null;
      return true;
    };
    try {
      await handle.upload(`Id\n${ids.join('\n')}\n`);
      if (isStopped() || forceSignal?.aborted) return abortOpen();
      await handle.close();
    } catch (e) {
      try {
        await handle.abort();
      } catch {
        // ignore
      }
      await settle(sobject, nodeId, ids.map((id) => ({ id, ok: false, code: null, message: e.message })));
      active = null;
      return true;
    }
    let w;
    try {
      w = await waitForJob(handle, {
        sleep: bulkOptions.sleep, clock: bulkOptions.clock, timeoutMs: bulkOptions.timeoutMs ?? BULK_DEFAULTS.bulkJobTimeoutMs, forceSignal,
        pollStart: bulkOptions.pollStart, pollMax: bulkOptions.pollMax,
        onCheck: (info) => {
          active.processed = info.numberRecordsProcessed;
          active.failed = info.numberRecordsFailed;
          active.state = info.state;
          progress();
        },
      });
    } catch (e) {
      stopped ??= { reason: 'bulkError', sobject, nodeId, jobId: handle.id, message: e.message };
      active = null;
      return true;
    }
    if (w.timedOut) {
      stopped ??= { reason: 'bulkTimeout', sobject, nodeId, jobId: handle.id, message: `Job Bulk ${handle.id} (${sobject}) chưa xong sau ${Math.round((bulkOptions.timeoutMs ?? BULK_DEFAULTS.bulkJobTimeoutMs) / 60000)} phút.` };
      active = null;
      return true;
    }
    let okRows = [];
    let badRows = [];
    try {
      okRows = parseResultCsv(await handle.successfulResults()).rows;
      badRows = parseResultCsv(await handle.failedResults()).rows;
    } catch (e) {
      if (w.state === 'Aborted') bulkAborted = { jobId: handle.id, sobject, nodeId, processed: w.info.numberRecordsProcessed, records: ids.length, idsKnown: false };
      else stopped ??= { reason: 'bulkError', sobject, nodeId, jobId: handle.id, message: e.message };
      active = null;
      return true;
    }
    const mine = new Set(ids);
    const outcomes = [];
    for (const r of okRows) if (mine.has(r.sf__Id)) outcomes.push({ id: r.sf__Id, ok: true });
    for (const r of badRows) {
      const id = r.sf__Id || r.Id;
      if (!mine.has(id)) continue;
      const e = parseBulkError(r.sf__Error);
      outcomes.push({ id, ok: false, code: e.statusCode, message: `${e.statusCode ? `${e.statusCode}: ` : ''}${e.message}` });
    }
    if (w.state === 'Failed') {
      const seen = new Set(outcomes.map((o) => o.id));
      const message = `Job Bulk ${handle.id} (${sobject}) thất bại: ${w.info.errorMessage ?? 'không rõ lỗi'}.`;
      for (const id of ids) if (!seen.has(id)) outcomes.push({ id, ok: false, code: null, message });
    } else if (w.state === 'Aborted') {
      bulkAborted = { jobId: handle.id, sobject, nodeId, processed: w.info.numberRecordsProcessed, records: ids.length, idsKnown: true };
    }
    await settle(sobject, nodeId, outcomes);
    active = null;
    progress();
    return true;
  }

  progress();
  const skipped = []; // steps refused by the key-prefix check: nothing of them is sent
  const prefixOf = new Map(); // sObject → keyPrefix (describe, read-only)
  for (const step of [...rem.steps].reverse()) {
    if (isStopped()) break;
    if (!step.ids.length) continue;
    // Every Id of a step must be a record of that step's sObject: one 3-character key prefix, the
    // one describe gives for the sObject. Anything else (edited or corrupted history file) ⇒ the
    // whole step is left alone (review of 0011, B1).
    const refusal = await checkPrefix(step);
    if (refusal) {
      skipped.push({ nodeId: step.nodeId, sobject: step.sobject, count: step.ids.length, reason: refusal });
      continue;
    }
    const ids = [...step.ids].reverse();
    const useBulk = bulk !== 'off' && ids.length >= minBulk;
    let i = 0;
    let bulkOk = useBulk;
    while (i < ids.length) {
      await new Promise((resolve) => setImmediate(resolve));
      if (isStopped()) break;
      const fc = firstCalls.get(step.sobject);
      if (bulkOk && fc?.anySuccess) {
        const part = ids.slice(i, i + jobRecords).filter((id) => !sent.has(id));
        if (await bulkDelete(step.sobject, step.nodeId, part)) {
          i += jobRecords;
          continue;
        }
        bulkOk = false; // Bulk refused the job: the rest of the step by destroy
      }
      const part = ids.slice(i, i + batchSize).filter((id) => !sent.has(id));
      i += batchSize;
      if (part.length) await destroyCall(step.sobject, step.nodeId, part);
    }
  }
  // One more try for Ids another record still depended on (DELETE_FAILED), in the same order.
  const again = retry.splice(0);
  let r = 0;
  while (r < again.length && !isStopped()) {
    const so = again[r].sobject;
    const part = [];
    while (r < again.length && again[r].sobject === so && part.length < batchSize) part.push(again[r++]);
    await new Promise((resolve) => setImmediate(resolve));
    if (isStopped()) {
      r -= part.length;
      break;
    }
    let results;
    try {
      results = await client.destroy(target, so, part.map((x) => x.id));
    } catch (e) {
      results = part.map(() => ({ success: false, errors: [{ message: e.message }] }));
    }
    await settle(so, part[0].nodeId, part.map((x, k) => {
      const res = results?.[k];
      if (res?.success) return { id: x.id, ok: true };
      const er = res?.errors?.[0] ?? {};
      return { id: x.id, ok: false, code: er.statusCode ?? null, message: (res?.errors ?? []).map((e) => `${e.statusCode ? `${e.statusCode}: ` : ''}${e.message}`).join('; ') || 'Lỗi không rõ.' };
    }), { retrying: true });
    progress();
  }
  // Retries a stop prevented are failures of this run (still in the org, deletable later).
  for (const x of again.slice(r)) failOne(x.sobject, x.nodeId, x.id, x.message, x.code);

  const remaining = Math.max(0, total - deleted - gone);
  const errorGroups = [...groups.values()].sort((a, b) => b.count - a.count);
  const errorGroupsOther = otherGroups.count ? { ...otherGroups } : null;
  const prev = entry?.deletion ?? {};
  await history.update(hid, (d) => ({
    deletion: {
      status: remaining === 0 ? 'done' : 'partial',
      deleted: (d.deletion?.deleted ?? prev.deleted ?? 0) + deleted,
      gone: (d.deletion?.gone ?? prev.gone ?? 0) + gone,
      failed,
      lastAt: new Date().toISOString(),
      errorGroups: errorGroups.slice(0, 20).map(({ sobject, nodeId, message, count }) => ({ sobject, nodeId, message, count })),
      ...(stopped ? { stopped } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    },
  })).catch((e) => {
    stopped ??= { reason: 'history', message: e.message };
  });
  return { deleted, gone, failed, total, errorGroups, errorGroupsOther, bySobject, remaining, cancelled: cancelled && !stopped, stopped, bulkAborted, collected, skipped };

  async function checkPrefix(step) {
    const n = step.ids.length;
    const label = `${n} bản ghi ${step.sobject} của bước "${step.nodeId}"`;
    if (!step.ids.every((id) => ID_RE.test(id))) return `Không xóa ${label}: Lịch sử có Id không hợp lệ (file có thể đã bị sửa). Không gửi Id nào của bước này.`;
    if (!prefixOf.has(step.sobject)) {
      try {
        const d = await client.describe(target, step.sobject);
        prefixOf.set(step.sobject, typeof d?.keyPrefix === 'string' ? d.keyPrefix : null);
      } catch (e) {
        return `Không xóa ${label}: không đọc được describe của ${step.sobject} (${e.message}). Thử lại sau.`;
      }
    }
    const keyPrefix = prefixOf.get(step.sobject);
    const prefixes = new Set(step.ids.map((id) => id.slice(0, 3)));
    if (!keyPrefix || prefixes.size !== 1 || !prefixes.has(keyPrefix)) {
      return `Không xóa ${label}: Id trong Lịch sử không cùng tiền tố ${keyPrefix ?? '?'} của ${step.sobject} (${[...prefixes].slice(0, 3).join(', ')}), có thể file Lịch sử đã bị sửa. Không gửi Id nào của bước này.`;
    }
    return null;
  }
}

/**
 * Bulk insert jobs of the entry whose results were never read (interrupted run): read their
 * successful results (read-only) and append the Ids to the history file. → number of Ids added.
 */
async function collectPendingJobs({ client, history, hid, target, entry }) {
  let added = 0;
  for (const job of entry?.bulkJobs ?? []) {
    if (job.idsCollected || job.idsUnknown) continue;
    try {
      const handle = client.bulkJob(target, { jobId: job.jobId });
      const info = await handle.check();
      if (!['JobComplete', 'Failed', 'Aborted'].includes(info.state)) continue;
      const rows = parseResultCsv(await handle.successfulResults()).rows.filter((r) => r.sf__Id);
      await history.appendIds(hid, rows.map((r) => ({ sobject: job.sobject, nodeId: job.nodeId, ref: '', id: r.sf__Id })));
      added += rows.length;
      await history.update(hid, (d) => ({ bulkJobs: (d.bulkJobs ?? []).map((j) => (j.jobId === job.jobId ? { ...j, state: info.state, idsCollected: true } : j)) }));
    } catch {
      // Results not available (job purged, aborted without results): the Ids stay unknown.
    }
  }
  return added;
}
