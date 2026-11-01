// Inserts generated records into an org, resolving { $ref } lookup placeholders.
//
// Records arrive as a stream (design 0004): `createInserter` gathers a window of records
// (INSERT_WINDOW) and inserts it in "waves": a record is ready once every record it references has
// an Id. Parents therefore land before children, and self-lookups (Account.ParentId) work across
// waves. The executor yields parents before children, so a parent is either in an earlier window
// (Id already known) or in the same window (sent in an earlier wave). A child whose parent failed
// is reported as skipped without being sent. Each call sends at most BATCH_SIZE records of one
// sObject through sObject Collections (`client.create`, allOrNone: false); the SaveResults come
// back in order and are mapped to the records' refs.
//
// Memory: only the Ids (and failures) of refs that `keepId(ref)` accepts outlive their window
// (aliases a Lookup points at, preview rows); `errors` keeps the first MAX_ERRORS_REPORTED
// records while `errorGroups` counts every failure (grouped by message pattern — Ids and quoted
// values masked — at most MAX_ERROR_GROUPS groups, the rest summed in `errorGroupsOther`).
// `bySobject` and `byStep` (design 0012 D: by the record's `nodeId`, the Record step) count
// inserted / failed records; both are bounded by the workflow, not by the record count.
//
// Stopping: `signal` (Dừng, closed connection) is checked before each call, and the call in flight
// is always awaited, so `inserted` is exact. Fail fast: when the first FAIL_FAST_BATCHES calls of
// one sObject all fail completely, nothing more is sent (`stopped.reason: 'allFailing'`).
//
// Bulk API 2.0 (design 0011 §2–3), for the Record steps `plan` (shared/insert-plan.js) marks 'bulk'
// (leaf steps: no Lookup needs their Ids). A step's records go through Collections until one call
// of that step succeeds (the probe: configuration errors keep exact refs and the fail-fast rule);
// later ready records become CSV rows (server/sf/bulk-csv.js) in the step's buffer, sent as a job
// of BULK_JOB_RECORDS rows. One job at a time, running alongside the Collections calls of other
// steps; a full buffer waits for the job in flight. Results come back unordered: each success Id
// goes to `onInserted` (no ref), each failure is matched back to its record when its row is unique.
// A whole-job failure fails its rows; two jobs in a row of a step failing completely stop the
// insert (`bulkFailing`); a job Salesforce will not open for the sObject (INVALIDENTITY…) sends the
// rest of the step through Collections with a warning. Dừng aborts a job still uploading (Open)
// and waits for one being processed; Dừng ngay (`forceSignal`) aborts that one too and still reads
// its results when Salesforce keeps them (`bulkAborted`).
//
// History (design 0011 §5): `onInserted` gets the Ids of every call before the next write is sent;
// if it throws, the insert stops (`stopped.reason: 'history'`), so no record is in the org without
// its Id on disk. `onJob` records a Bulk job's Id before its CSV is uploaded.

import { toBulkCsv, parseResultCsv, parseBulkError, rowKey } from './bulk-csv.js';
import { waitForJob } from './bulk-job.js';
import { BULK_DEFAULTS } from '../../shared/insert-plan.js';
import { isOrgChanged } from './client.js';

export const BATCH_SIZE = 200; // sObject Collections limit
export const BULK_JOB_RECORDS = BULK_DEFAULTS.bulkJobRecords;
export const BULK_JOB_TIMEOUT_MS = BULK_DEFAULTS.bulkJobTimeoutMs;
/** Two jobs in a row of one step failing completely stop the insert (`bulkFailing`). */
export const BULK_FAIL_FAST_JOBS = 2;
/** Errors opening a job that do not mean "Bulk does not take this sObject": no fallback, the job fails. */
const NO_FALLBACK_CODES = new Set(['REQUEST_LIMIT_EXCEEDED', 'INVALID_SESSION_ID', 'SERVER_UNAVAILABLE', 'UNKNOWN_EXCEPTION', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'QUERY_TIMEOUT']);
export const INSERT_WINDOW = 2000; // ≈ 1 MB; keeps almost every call a full 200
export const FAIL_FAST_BATCHES = 3;
export const MAX_ERRORS_REPORTED = 1000;
const GROUP_EXAMPLES = 3;
export const MAX_ERROR_GROUPS = 100;

/**
 * Group key of an error message: record Ids (15/18 characters with a digit) and quoted values
 * vary per record ("duplicates value on record with id: 003…"), so they are masked; the group
 * keeps the first raw message as its example.
 */
export function errorPattern(message) {
  return String(message)
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g, '<Id>');
}
export const SKIPPED_MESSAGE = 'Bỏ qua vì bản ghi cha lỗi.';
export const NO_PARENT_MESSAGE = 'Không xác định được Id bản ghi cha.';

export function collectRefs(fields) {
  const refs = [];
  for (const v of Object.values(fields)) if (v && typeof v === 'object' && typeof v.$ref === 'string') refs.push(v.$ref);
  return refs;
}

/** Field values as sent to Salesforce (jsforce adds the sObject `attributes`). */
export function toSObject(record, idByRef) {
  const out = {};
  for (const [name, v] of Object.entries(record.fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && '$ref' in v) out[name] = idByRef.get(v.$ref);
    else if (typeof v === 'object' && 'latitude' in v && 'longitude' in v) {
      const base = name.replace(/__c$/i, '');
      out[`${base}__Latitude__s`] = v.latitude;
      out[`${base}__Longitude__s`] = v.longitude;
    } else out[name] = v;
  }
  return out;
}

/**
 * "STATUS: message [Field]" of a SaveResult, and the field when Salesforce names exactly one of the
 * record. Bulk API 2.0 failures (server/sf/bulk-csv.js parseBulkError) go through it too, so both
 * paths give the same message and error group.
 */
export function describeFailure(res, record) {
  const errs = res?.errors ?? [];
  const message = errs.map((er) => `${er.statusCode ? `${er.statusCode}: ` : ''}${er.message}${er.fields?.length ? ` [${er.fields.join(', ')}]` : ''}`).join('; ') || 'Lỗi không rõ.';
  const names = [...new Set(errs.flatMap((er) => er.fields ?? []))];
  let field;
  if (names.length === 1) {
    const own = Object.keys(record.fields ?? {}).find((k) => k.toLowerCase() === String(names[0]).toLowerCase());
    if (own) field = `fields.${own}`;
  }
  return { message, field };
}

/**
 * @param client  server/sf/client.js client (`create`; `bulkJob` when a plan has Bulk steps)
 * @param target  org alias/username
 * @param window  records gathered before inserting (waves run inside a window)
 * @param keepId  (ref) → keep its Id (and failure) after its window: later records may point at it
 * @param signal  AbortSignal: stop before the next call (Dừng, closed connection)
 * @param forceSignal AbortSignal: Dừng ngay, abort the Bulk job being processed (design 0011 §3)
 * @param onBatch ({ inserted, failed, bySobject, byStep, bulk }) after every call (and skipped
 *                records), and on every check of a Bulk job (`bulk`: the job in flight, its
 *                processed records already counted in `inserted` as a provisional number)
 * @param plan    planInsert(...) result (shared/insert-plan.js): steps with mode 'bulk' go through
 *                Bulk API 2.0 after their first successful Collections call
 * @param onInserted async ([{ sobject, nodeId, ref, id }]) after every call that created records,
 *                awaited before the next write; a failure stops the insert (stopped.reason 'history')
 * @param onJob   async (job) when a Bulk job is opened (before its upload) and when it ends
 * @param bulkOptions { jobRecords, timeoutMs, sleep, clock, pollStart, pollMax } (tests)
 * → { push(record): Promise<void>, end(): Promise<summary>, stopped (getter) }
 *   summary: { inserted, failed, errorsTotal, errors, errorGroups, errorGroupsOther, ids, bySobject, byStep, notSent, cancelled, stopped,
 *              bulk: [{ nodeId, sobject, jobs, records, inserted, failed }], bulkJobs, bulkAborted, bulkUnknown, warnings }
 *   byStep: { <nodeId>: { inserted, failed } } (failed includes children skipped because their parent failed)
 */
export function createInserter(client, target, {
  window = INSERT_WINDOW, keepId = () => true, signal, forceSignal, onBatch, failFast = FAIL_FAST_BATCHES, maxErrors = MAX_ERRORS_REPORTED, batchSize = BATCH_SIZE,
  plan = null, onInserted = null, onJob = null, bulkOptions = {},
} = {}) {
  const idByRef = new Map(); // kept Ids (keepId) of earlier windows
  const failedRefs = new Set(); // kept failures of earlier windows
  const errors = [];
  const groups = new Map();
  const otherGroups = { groups: 0, count: 0, keys: new Set() }; // beyond MAX_ERROR_GROUPS
  const bySobject = {}; // sObject → { inserted, failed }
  const byStep = {}; // record step id → { inserted, failed } (design 0012 D)
  const firstCalls = new Map(); // sObject → { calls, anySuccess } (fail fast)
  let errorsTotal = 0;
  let inserted = 0;
  let notSent = 0;
  let cancelled = false;
  let stopped = null;
  let buffer = [];

  // ---- Bulk API 2.0 (design 0011 §2) ----
  const jobRecords = bulkOptions.jobRecords ?? BULK_JOB_RECORDS;
  const bulkSteps = new Map(); // nodeId → state of a step planned for Bulk
  for (const s of plan?.steps ?? []) {
    if (s.mode !== 'bulk') continue;
    bulkSteps.set(s.nodeId, {
      nodeId: s.nodeId, sobject: s.sobject, alias: s.alias, plannedJobs: s.jobs,
      probeDone: false, fallback: false, items: [], jobNo: 0, failRun: 0, failRecords: 0, failMessage: null,
      summary: { nodeId: s.nodeId, sobject: s.sobject, jobs: 0, records: 0, inserted: 0, failed: 0 },
    });
  }
  const bulkJobs = []; // every job opened: { jobId, nodeId, sobject, records, state, idsCollected, … }
  const warnings = [];
  let activeJob = null; // Promise of the job in flight (one at a time)
  let active = null; // its progress for the events
  let bulkAborted = null;
  let bulkUnknown = 0; // records of jobs whose outcome is unknown (timeout, results not returned)
  let collectionsLock = Promise.resolve(); // Collections calls stay sequential (a fallback runs from a job)

  const counts = (sobject) => (bySobject[sobject] ??= { inserted: 0, failed: 0 });
  // Keyed by String(nodeId) (review 2): the same key as the history file, whatever the id's type.
  const stepCounts = (record) => (record.nodeId !== undefined && record.nodeId !== null && record.nodeId !== '' ? (byStep[String(record.nodeId)] ??= { inserted: 0, failed: 0 }) : { inserted: 0, failed: 0 });
  const progress = () => onBatch?.({
    inserted: inserted + (active ? Math.max(0, active.processed - active.failed) : 0),
    failed: errorsTotal,
    bySobject,
    byStep,
    ...(active ? { bulk: { ...active } } : {}),
  });
  const isCancelled = () => {
    if (signal?.aborted) cancelled = true;
    return cancelled || Boolean(stopped);
  };

  function fail(record, message, extra = {}) {
    errorsTotal++;
    counts(record.sobject).failed++;
    stepCounts(record).failed++;
    const e = { ref: record.ref ?? null, sobject: record.sobject, ...(record.nodeId ? { nodeId: record.nodeId } : {}), message, ...extra };
    if (errors.length < maxErrors) errors.push(e);
    const key = `${record.sobject}\u0000${record.nodeId ?? ''}\u0000${extra.field ?? ''}\u0000${errorPattern(message)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (g.refs.length < GROUP_EXAMPLES && record.ref) g.refs.push(record.ref);
    } else if (groups.size < MAX_ERROR_GROUPS) {
      groups.set(key, { sobject: record.sobject, ...(record.nodeId ? { nodeId: record.nodeId } : {}), ...(extra.field ? { field: extra.field } : {}), message, count: 1, refs: record.ref ? [record.ref] : [] });
    } else {
      // Counted, not listed. The key set is bounded too: past 10 000 distinct keys only the count grows.
      otherGroups.count++;
      if (!otherGroups.keys.has(key) && otherGroups.keys.size < 10000) {
        otherGroups.keys.add(key);
        otherGroups.groups++;
      }
    }
  }

  /** Ids just created go to history before the next write; a failed write stops the insert. */
  async function saveIds(rows) {
    if (!onInserted || !rows.length) return;
    try {
      await onInserted(rows);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
    }
  }

  /**
   * One sObject Collections call. `settle(record, id | null)` tells the window what happened.
   */
  async function sendChunk(sobject, chunk, objs, settle) {
    const run = collectionsLock.then(async () => {
      let results;
      try {
        results = await client.create(target, sobject, objs);
      } catch (e) {
        if (isOrgChanged(e)) {
          // The org behind the alias changed (refresh refused, review 2 item 1): nothing of this call
          // was written; the run stops for good.
          stopped ??= { reason: 'orgChanged', sobject, message: e.message };
          for (const r of chunk) settle(r, null);
          notSent += chunk.length;
          progress();
          return;
        }
        results = chunk.map(() => ({ success: false, errors: [{ message: e.message }] }));
      }
      let ok = 0;
      let failedHere = 0;
      let firstFailure = null;
      const created = [];
      chunk.forEach((r, idx) => {
        const res = results?.[idx];
        if (res?.success) {
          settle(r, res.id);
          inserted++;
          ok++;
          counts(sobject).inserted++;
          stepCounts(r).inserted++;
          created.push({ sobject, nodeId: r.nodeId ?? '', ref: r.ref, id: res.id });
          const st = bulkSteps.get(r.nodeId);
          if (st) {
            st.probeDone = true;
            st.summary.inserted++;
          }
        } else {
          settle(r, null);
          const f = describeFailure(res, r);
          firstFailure ??= { ...f, nodeId: r.nodeId };
          failedHere++;
          fail(r, f.message, f.field ? { field: f.field } : {});
          const st = bulkSteps.get(r.nodeId);
          if (st) st.summary.failed++;
        }
      });
      const fc = firstCalls.get(sobject) ?? { calls: 0, anySuccess: false, failed: 0 };
      fc.calls++;
      fc.failed += failedHere; // records Salesforce refused (not the children skipped because of them)
      if (ok) fc.anySuccess = true;
      firstCalls.set(sobject, fc);
      if (!fc.anySuccess && fc.calls >= failFast) {
        stopped ??= { reason: 'allFailing', sobject, nodeId: firstFailure?.nodeId, message: firstFailure?.message, batches: fc.calls, records: fc.failed };
      }
      await saveIds(created);
      progress();
    });
    collectionsLock = run.catch(() => {});
    return run;
  }

  /** A record of a Bulk step whose probe call succeeded: its row joins the step's next job. */
  function bulkReady(r) {
    const st = bulkSteps.get(r.nodeId);
    return Boolean(st && st.probeDone && !st.fallback);
  }

  async function divert(r, idOf) {
    const st = bulkSteps.get(r.nodeId);
    st.items.push({ record: r, obj: toSObject(r, idOf) });
    if (st.items.length >= jobRecords) await submit(st);
  }

  /** Sends the step's buffer as one job once the job in flight is done (at most two buffers). */
  async function submit(st) {
    const items = st.items;
    st.items = [];
    if (!items.length) return;
    while (activeJob) await activeJob;
    if (isCancelled()) {
      notSent += items.length;
      return;
    }
    activeJob = runJob(st, items).catch((e) => {
      stopped ??= { reason: 'error', message: e.message, sobject: st.sobject, nodeId: st.nodeId };
    }).finally(() => {
      activeJob = null;
      active = null;
    });
  }

  /** Bulk could not open a job for this sObject (not supported, feature off…): Collections for the rest. */
  async function fallBack(st, items, e) {
    st.fallback = true;
    const why = e.cause?.message ?? e.message;
    warnings.push(`Bước "${st.alias ?? st.nodeId}": Bulk API 2.0 không nhận ${st.sobject} (${why}), nên đã gửi bằng sObject Collections.`);
    for (let i = 0; i < items.length; i += batchSize) {
      await new Promise((resolve) => setImmediate(resolve));
      if (isCancelled()) {
        notSent += items.length - i;
        return;
      }
      const part = items.slice(i, i + batchSize);
      await sendChunk(st.sobject, part.map((x) => x.record), part.map((x) => x.obj), () => {});
    }
  }

  function jobOutcome(st, ok, failedN, message) {
    if (ok === 0 && failedN > 0) {
      st.failRun++;
      st.failRecords += failedN;
      st.failMessage ??= message;
      if (st.failRun >= BULK_FAIL_FAST_JOBS) {
        stopped ??= { reason: 'bulkFailing', sobject: st.sobject, nodeId: st.nodeId, message: st.failMessage, jobs: st.failRun, records: st.failRecords };
      }
    } else {
      st.failRun = 0;
      st.failRecords = 0;
      st.failMessage = null;
    }
  }

  async function runJob(st, items) {
    const n = items.length;
    const jobNo = ++st.jobNo;
    active = { nodeId: st.nodeId, sobject: st.sobject, jobId: null, job: jobNo, jobs: Math.max(st.plannedJobs, jobNo), processed: 0, failed: 0, records: n, state: 'Open' };
    const { columns, csv, keys } = toBulkCsv(items.map((x) => x.obj));
    let handle;
    let opened;
    try {
      handle = client.bulkJob(target, { object: st.sobject, operation: 'insert' });
      opened = await handle.open();
    } catch (e) {
      if (isOrgChanged(e)) {
        stopped ??= { reason: 'orgChanged', sobject: st.sobject, nodeId: st.nodeId, message: e.message };
        notSent += n;
        progress();
        return undefined;
      }
      const code = e.cause?.errorCode ?? e.errorCode;
      if (code && !NO_FALLBACK_CODES.has(code)) return fallBack(st, items, e);
      // Limits, network…: like a failed Collections call (every record failed, counts toward bulkFailing).
      for (const x of items) fail(x.record, e.message);
      st.summary.failed += n;
      jobOutcome(st, 0, n, e.message);
      progress();
      return undefined;
    }
    // The job Salesforce opened must be exactly the one asked for (review of 0011, N3).
    if (opened?.operation !== 'insert' || String(opened?.object ?? '').toLowerCase() !== st.sobject.toLowerCase()) {
      try {
        await handle.abort();
      } catch {
        // nothing was uploaded
      }
      notSent += n;
      stopped ??= { reason: 'bulkError', sobject: st.sobject, nodeId: st.nodeId, jobId: handle.id, message: `Salesforce mở job Bulk ${handle.id} khác yêu cầu (${opened?.operation ?? '?'} ${opened?.object ?? '?'} thay vì insert ${st.sobject}), nên đã hủy job và dừng.`, records: n };
      progress();
      return undefined;
    }
    const job = { jobId: handle.id, nodeId: st.nodeId, sobject: st.sobject, records: n, state: 'Open', idsCollected: false, inserted: 0, failed: 0 };
    active.jobId = handle.id;
    bulkJobs.push(job);
    st.summary.jobs++;
    st.summary.records += n;
    // The job Id is on disk before anything is uploaded, so an interrupted job can be looked up.
    try {
      await onJob?.(job);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
    }
    const abortOpen = async () => {
      try {
        await handle.abort();
      } catch {
        // nothing was processed: an Open job holds no records
      }
      job.state = 'Aborted';
      job.idsCollected = true;
      notSent += n;
      await onJob?.(job)?.catch?.(() => {});
    };
    if (stopped || isCancelled()) return abortOpen();
    try {
      await handle.upload(csv);
      // Dừng while uploading: the job is still Open, nothing processed yet ⇒ abort it.
      if (isCancelled() || forceSignal?.aborted) return abortOpen();
      await handle.close();
    } catch (e) {
      if (isOrgChanged(e)) {
        // Upload or close refused: the job was never closed, so Salesforce processes nothing of it.
        job.state = 'Open';
        job.idsCollected = true;
        notSent += n;
        stopped ??= { reason: 'orgChanged', sobject: st.sobject, nodeId: st.nodeId, jobId: job.jobId, message: e.message };
        await onJob?.(job)?.catch?.(() => {});
        progress();
        return undefined;
      }
      try {
        await handle.abort();
      } catch {
        // ignore
      }
      job.state = 'Aborted';
      job.idsCollected = true;
      for (const x of items) fail(x.record, e.message, { bulkJobId: job.jobId });
      st.summary.failed += n;
      jobOutcome(st, 0, n, e.message);
      progress();
      return undefined;
    }
    job.state = 'UploadComplete';
    active.state = 'UploadComplete';
    progress();

    let w;
    try {
      w = await waitForJob(handle, {
        sleep: bulkOptions.sleep, clock: bulkOptions.clock, timeoutMs: bulkOptions.timeoutMs ?? BULK_JOB_TIMEOUT_MS,
        pollStart: bulkOptions.pollStart, pollMax: bulkOptions.pollMax, forceSignal,
        onCheck: (info) => {
          active.processed = info.numberRecordsProcessed;
          active.failed = info.numberRecordsFailed;
          active.state = info.state;
          progress();
        },
      });
    } catch (e) {
      // Checking failed (network, session): the job may still run in the org.
      job.state = 'Unknown';
      bulkUnknown += n;
      stopped ??= { reason: isOrgChanged(e) ? 'orgChanged' : 'bulkError', sobject: st.sobject, nodeId: st.nodeId, jobId: job.jobId, message: e.message, records: n };
      await onJob?.(job)?.catch?.(() => {});
      return undefined;
    }
    job.state = w.state;
    job.processed = w.info.numberRecordsProcessed;
    if (w.timedOut) {
      bulkUnknown += n;
      stopped ??= { reason: 'bulkTimeout', sobject: st.sobject, nodeId: st.nodeId, jobId: job.jobId, message: `Job Bulk ${job.jobId} (${st.sobject}) chưa xong sau ${Math.round((bulkOptions.timeoutMs ?? BULK_JOB_TIMEOUT_MS) / 60000)} phút.`, records: n };
      await onJob?.(job)?.catch?.(() => {});
      return undefined;
    }

    let okText;
    let failText;
    let readError = null;
    try {
      okText = await handle.successfulResults();
    } catch (e) {
      readError = e;
    }
    if (okText !== undefined) {
      try {
        failText = await handle.failedResults();
      } catch (e) {
        readError = e;
      }
    }

    if (okText === undefined) {
      // Review of 0011, S3: the Ids could not be read now. The job stays collectable
      // (idsCollected false): a later delete of this run reads its results first.
      const processed = w.info.numberRecordsProcessed;
      if (w.state === 'Aborted') {
        // Dừng ngay: processed records may be in the org (Ids unknown for now), the rest never was.
        bulkUnknown += processed;
        notSent += n - processed;
        bulkAborted = { jobId: job.jobId, sobject: st.sobject, nodeId: st.nodeId, processed, records: n, idsKnown: false };
      } else {
        bulkUnknown += n;
        stopped ??= { reason: isOrgChanged(readError) ? 'orgChanged' : 'bulkError', sobject: st.sobject, nodeId: st.nodeId, jobId: job.jobId, message: `Không đọc được kết quả của job Bulk ${job.jobId} (${st.sobject}): ${readError?.message}`, records: n };
      }
      active = null;
      await onJob?.(job)?.catch?.(() => {});
      progress();
      return undefined;
    }

    const ok = okText ? parseResultCsv(okText).rows : [];
    const bad = failText ? parseResultCsv(failText).rows : [];
    const byKey = new Map();
    keys.forEach((k, i) => {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
    });
    const settled = new Set(); // uploaded rows identified in the results
    const created = [];
    for (const row of ok) {
      if (!row.sf__Id) continue;
      inserted++;
      counts(st.sobject).inserted++;
      (byStep[String(st.nodeId)] ??= { inserted: 0, failed: 0 }).inserted++;
      created.push({ sobject: st.sobject, nodeId: st.nodeId, ref: '', id: row.sf__Id });
      const match = byKey.get(rowKey(columns.map((c) => row[c])));
      if (match?.length === 1) settled.add(match[0]);
    }
    job.inserted = created.length;
    st.summary.inserted += created.length;
    for (const row of bad) {
      const match = byKey.get(rowKey(columns.map((c) => row[c])));
      const one = match?.length === 1 ? match[0] : null;
      const rec = one !== null ? items[one].record : { ref: null, sobject: st.sobject, nodeId: st.nodeId, fields: Object.fromEntries(columns.map((c) => [c, row[c]])) };
      if (one !== null) settled.add(one);
      const f = describeFailure({ errors: [parseBulkError(row.sf__Error)] }, rec);
      fail(rec, f.message, { ...(f.field ? { field: f.field } : {}), ...(one === null ? { bulkJobId: job.jobId } : {}) });
      job.failed++;
    }
    let jobMessage = bad.length ? describeFailure({ errors: [parseBulkError(bad[0].sf__Error)] }, items[0].record).message : null;
    const accounted = created.length + bad.length;
    const failuresRead = failText !== undefined;
    if (w.state === 'Aborted') {
      // Accounting (review of 0011, N7): every row is inserted, failed, not sent or unknown.
      const processed = Math.max(accounted, w.info.numberRecordsProcessed);
      notSent += n - processed;
      bulkUnknown += processed - accounted; // processed, but no result row was read for them
      bulkAborted = { jobId: job.jobId, sobject: st.sobject, nodeId: st.nodeId, processed: w.info.numberRecordsProcessed, records: n, idsKnown: true };
    } else if (w.state === 'Failed' && accounted < n) {
      // The whole job failed: rows Salesforce did not report are not inserted.
      jobMessage = `Job Bulk ${job.jobId} (${st.sobject}) thất bại: ${w.info.errorMessage ?? 'không rõ lỗi'}. Bản ghi của job này chưa được insert. Bỏ chọn "Dùng Bulk API 2.0" trong hộp xác nhận để gửi bằng sObject Collections.`;
      let left = n - accounted;
      for (let i = 0; i < n && left > 0; i++) {
        if (settled.has(i)) continue;
        fail(items[i].record, jobMessage, { bulkJobId: job.jobId });
        job.failed++;
        left--;
      }
    } else if (accounted < n) {
      // JobComplete whose failedResults could not be read: those rows are not in the org, but which
      // ones failed and why is unknown.
      bulkUnknown += n - accounted;
      if (!failuresRead) warnings.push(`Không đọc được danh sách lỗi của job Bulk ${job.jobId} (${st.sobject}): ${readError?.message}. ${n - accounted} bản ghi không có kết quả.`);
    }
    st.summary.failed += job.failed;
    job.idsCollected = true;
    active.processed = accounted;
    await saveIds(created);
    active = null;
    if (w.state !== 'Aborted') jobOutcome(st, created.length, job.failed, jobMessage);
    try {
      await onJob?.(job);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
    }
    progress();
    return undefined;
  }

  async function flush() {
    const records = buffer;
    buffer = [];
    if (!records.length) return;
    if (stopped || cancelled) {
      notSent += records.length;
      return;
    }
    const windowIds = new Map();
    const windowFailed = new Set();
    const windowBulk = new Set(); // refs handed to a Bulk job buffer
    const idOf = { get: (ref) => windowIds.get(ref) ?? idByRef.get(ref) };
    const hasId = (ref) => windowIds.has(ref) || idByRef.has(ref);
    const isFailed = (ref) => windowFailed.has(ref) || failedRefs.has(ref);
    const inWindow = new Set(records.map((r) => r.ref));
    const settle = (r, id) => {
      if (id) windowIds.set(r.ref, id);
      else windowFailed.add(r.ref);
    };
    let pending = records;

    while (pending.length) {
      const ready = [];
      const waiting = [];
      for (const r of pending) {
        const deps = collectRefs(r.fields);
        const failedDep = deps.find(isFailed);
        if (failedDep) {
          windowFailed.add(r.ref);
          fail(r, SKIPPED_MESSAGE, { parentRef: failedDep });
        } else if (deps.every(hasId)) ready.push(r);
        else if (deps.every((d) => hasId(d) || inWindow.has(d))) waiting.push(r);
        else {
          // The parent is not in this window and its Id was not kept: should not happen
          // (keepId covers every Lookup target); reported rather than sent with a blank Lookup.
          windowFailed.add(r.ref);
          fail(r, NO_PARENT_MESSAGE);
        }
      }
      if (!ready.length) {
        for (const r of waiting) {
          windowFailed.add(r.ref);
          fail(r, NO_PARENT_MESSAGE);
        }
        progress();
        break;
      }

      const bySo = new Map();
      for (const r of ready) {
        if (!bySo.has(r.sobject)) bySo.set(r.sobject, []);
        bySo.get(r.sobject).push(r);
      }
      for (const [sobject, group] of bySo) {
        let chunk = [];
        for (let i = 0; i <= group.length; i++) {
          const r = group[i];
          if (r && bulkReady(r) && !isCancelled()) {
            windowBulk.add(r.ref);
            await divert(r, idOf);
            continue;
          }
          if (r) chunk.push(r);
          if (!(chunk.length === batchSize || (i === group.length && chunk.length))) continue;
          // Let a pending Dừng / closed connection reach the signal before every call.
          await new Promise((resolve) => setImmediate(resolve));
          if (isCancelled()) {
            notSent += pending.length - countHandled(pending, windowIds, windowFailed, windowBulk);
            return finishWindow();
          }
          await sendChunk(sobject, chunk, chunk.map((x) => toSObject(x, idOf)), settle);
          chunk = [];
        }
      }
      pending = waiting;
    }
    return finishWindow();

    function finishWindow() {
      for (const [ref, id] of windowIds) if (keepId(ref)) idByRef.set(ref, id);
      for (const ref of windowFailed) if (keepId(ref)) failedRefs.add(ref);
      return undefined;
    }
  }

  return {
    get stopped() {
      return stopped ?? (cancelled ? { reason: 'cancelled' } : null);
    },
    async push(record) {
      if (stopped || cancelled) {
        notSent++;
        return;
      }
      buffer.push(record);
      if (buffer.length >= window) await flush();
    },
    async end() {
      await flush();
      // The last (partial) buffer of every Bulk step, then wait for the job in flight.
      for (const st of bulkSteps.values()) await submit(st);
      while (activeJob) await activeJob;
      return {
        inserted,
        failed: errorsTotal,
        errorsTotal,
        errors,
        errorGroups: [...groups.values()].sort((a, b) => b.count - a.count),
        // Groups past MAX_ERROR_GROUPS: how many more (at least) and how many records they hold.
        errorGroupsOther: otherGroups.count ? { groups: otherGroups.groups, count: otherGroups.count } : null,
        ids: Object.fromEntries(idByRef),
        bySobject,
        byStep,
        notSent,
        cancelled,
        stopped,
        bulk: [...bulkSteps.values()].filter((st) => st.summary.jobs || st.fallback).map((st) => ({ ...st.summary, ...(st.fallback ? { fallback: true } : {}) })),
        bulkJobs,
        bulkAborted,
        bulkUnknown,
        warnings,
      };
    },
  };
}

/** Records of `pending` already settled in this window (sent, skipped or handed to a Bulk job). */
function countHandled(pending, windowIds, windowFailed, windowBulk) {
  let n = 0;
  for (const r of pending) if (windowIds.has(r.ref) || windowFailed.has(r.ref) || windowBulk?.has(r.ref)) n++;
  return n;
}

/** All records at once (kept for scripts and tests): every Id is kept. */
export async function insertRecords(client, target, records, { onProgress, ...opts } = {}) {
  const inserter = createInserter(client, target, {
    ...opts,
    onBatch: onProgress ? ({ inserted, failed }) => onProgress({ inserted, failed, total: records.length }) : undefined,
  });
  for (const r of records) await inserter.push(r);
  return inserter.end();
}
