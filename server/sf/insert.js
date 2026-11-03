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
// Bulk API 2.0 (design 0011): a step the plan marks `bulk` (a "leaf": no Lookup needs its Ids)
// still goes through Collections until one call of it succeeds (the probe: configuration errors
// are caught by the fail-fast rule below, with refs). After that its ready records are turned into
// rows (toSObject: real parent Ids) and buffered; a full buffer (bulkJobRecords) becomes one job.
// One job at a time runs alongside the Collections calls (it holds only leaves, so the parent
// before child order is kept); a second full buffer waits for it. Job results come back in no
// order: successes are counted and their Ids recorded (`onInserted`, no ref), failures are mapped
// back to the uploaded line when its content matches exactly one line. Two consecutive jobs of a
// step that fail completely stop the run (`stopped.reason: 'bulkFailing'`); a job Salesforce
// refuses to create (sObject not supported…) sends the step through Collections from then on.
//
// Memory: only the Ids (and failures) of refs that `keepId(ref)` accepts outlive their window
// (aliases a Lookup points at, preview rows); `errors` keeps the first MAX_ERRORS_REPORTED
// records while `errorGroups` counts every failure (grouped by message pattern — Ids and quoted
// values masked — at most MAX_ERROR_GROUPS groups, the rest summed in `errorGroupsOther`).
//
// Stopping: `signal` (Dừng, closed connection) is checked before each call, and the call in flight
// is always awaited, so `inserted` is exact. A Bulk job still uploading is aborted; a job Salesforce
// is processing is waited for (counts and Ids stay exact) unless `forceSignal` (Dừng ngay) aborts
// it. Fail fast: when the first FAIL_FAST_BATCHES calls of one sObject all fail completely, nothing
// more is sent (`stopped.reason: 'allFailing'`). History (design 0011): `onInserted(rows)` is
// awaited after every call and every job's results, before the next write; when it throws the
// insert stops (`stopped.reason: 'history'`), so no record is in the org without its Id on disk.

import { toBulkCsv, rowKey, parseBulkError, dataOf } from './bulk-csv.js';

export const BATCH_SIZE = 200; // sObject Collections limit
export const INSERT_WINDOW = 2000; // ≈ 1 MB; keeps almost every call a full 200
export const FAIL_FAST_BATCHES = 3;
export const MAX_ERRORS_REPORTED = 1000;
const GROUP_EXAMPLES = 3;
export const MAX_ERROR_GROUPS = 100;

/** Bulk API 2.0 internals (design 0011; not served in meta). */
export const BULK_DEFAULTS = Object.freeze({
  jobRecords: 10000, // LIMITS.bulkJobRecords
  timeoutMs: 30 * 60 * 1000, // LIMITS.bulkJobTimeoutMs
  pollMs: 2000, // first wait between two checks of a job…
  pollFactor: 1.5, // …times 1.5 each time…
  pollMaxMs: 15000, // …up to 15 s
  failJobs: 2, // consecutive all-failing jobs of a step that stop the run
  maxBuffered: 2, // buffers of jobRecords rows held at most (≈ 3 MB)
});

/** Error codes of a job Salesforce refuses to create that mean "this sObject cannot go Bulk". */
const NO_FALLBACK = new Set(['REQUEST_LIMIT_EXCEEDED', 'INVALID_SESSION_ID', 'QUERY_TIMEOUT']);

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

/** "STATUS: message [Field]" of a SaveResult, and the field when Salesforce names exactly one of the record. */
export function describeFailure(res, record) {
  const errs = res?.errors ?? [];
  const message = errs.map((er) => `${er.statusCode ? `${er.statusCode}: ` : ''}${er.message}${er.fields?.length ? ` [${er.fields.join(', ')}]` : ''}`).join('; ') || 'Lỗi không rõ.';
  const names = [...new Set(errs.flatMap((er) => er.fields ?? []))];
  let field;
  if (names.length === 1) {
    const own = Object.keys(record?.fields ?? {}).find((k) => k.toLowerCase() === String(names[0]).toLowerCase());
    if (own) field = `fields.${own}`;
  }
  return { message, field };
}

/** Bounded error groups (shared by insert and delete): add(), list(), other(). */
export function createErrorGroups({ examples = GROUP_EXAMPLES, max = MAX_ERROR_GROUPS } = {}) {
  const groups = new Map();
  const otherGroups = { groups: 0, count: 0, keys: new Set() };
  return {
    add({ sobject, nodeId, field, message, ref, ...extra }) {
      const key = `${sobject}\u0000${nodeId ?? ''}\u0000${field ?? ''}\u0000${errorPattern(message)}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (ref && g.refs.length < examples) g.refs.push(ref);
      } else if (groups.size < max) {
        groups.set(key, { sobject, ...(nodeId ? { nodeId } : {}), ...(field ? { field } : {}), message, count: 1, refs: ref ? [ref] : [], ...extra });
      } else {
        // Counted, not listed. The key set is bounded too: past 10 000 distinct keys only the count grows.
        otherGroups.count++;
        if (!otherGroups.keys.has(key) && otherGroups.keys.size < 10000) {
          otherGroups.keys.add(key);
          otherGroups.groups++;
        }
      }
    },
    list: () => [...groups.values()].sort((a, b) => b.count - a.count),
    other: () => (otherGroups.count ? { groups: otherGroups.groups, count: otherGroups.count } : null),
  };
}

/** Promise that resolves after `ms`, or as soon as `signal` aborts. */
export function interruptibleSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const FINAL_STATES = new Set(['JobComplete', 'Failed', 'Aborted']);

/**
 * Follows a closed Bulk job until it ends (shared by insert and delete): check() with a growing
 * wait (pollMs × pollFactor up to pollMaxMs, not jsforce's poll() whose 30 s timeout is too short),
 * at most timeoutMs. `forceSignal` (Dừng ngay) aborts the job once and waits for `Aborted`.
 * → { state, info, timedOut, forced }
 */
export async function pollBulkJob(job, { forceSignal, sleep = interruptibleSleep, clock = () => Date.now(), onCheck, opts = BULK_DEFAULTS } = {}) {
  const t0 = clock();
  let wait = opts.pollMs;
  let forced = false;
  let info = null;
  let checkErrors = 0;
  for (;;) {
    if (forceSignal?.aborted && !forced) {
      forced = true;
      try {
        await job.abort();
      } catch {
        // already finished, or the abort failed: the next check says which
      }
    }
    try {
      info = await job.check();
      checkErrors = 0;
    } catch (e) {
      // A lost check is retried (the job runs on regardless); three in a row end the watch.
      if (++checkErrors >= 3) return { state: info?.state ?? 'Unknown', info, timedOut: false, forced, error: e };
    }
    if (info) onCheck?.(info);
    if (info && FINAL_STATES.has(info.state)) return { state: info.state, info, timedOut: false, forced };
    if (clock() - t0 >= opts.timeoutMs) return { state: info?.state ?? 'Unknown', info, timedOut: true, forced };
    await sleep(forced ? Math.min(wait, opts.pollMs) : wait, forced ? undefined : forceSignal);
    wait = Math.min(wait * opts.pollFactor, opts.pollMaxMs);
  }
}

/** The error code behind a client error (client.js wraps Salesforce errors with `cause`). */
const codeOf = (e) => e?.cause?.errorCode ?? e?.errorCode;

/**
 * @param client  server/sf/client.js client (`create`; `bulkJob` for a plan with Bulk steps)
 * @param target  org alias/username
 * @param window  records gathered before inserting (waves run inside a window)
 * @param keepId  (ref) → keep its Id (and failure) after its window: later records may point at it
 * @param signal  AbortSignal: stop before the next call (a Bulk job being processed is waited for)
 * @param forceSignal  AbortSignal (Dừng ngay): abort the Bulk job being processed
 * @param plan    { [nodeId]: { mode: 'bulk' | 'collections', jobs } } (shared/insert-plan.js steps)
 * @param onInserted  async ([{ sobject, step, ref, id }]) after every call / job result, awaited
 * @param onBulkJob   async (job log entry) when a job is created (before its upload) and when it ends
 * @param onBatch ({ inserted, failed, bySobject, bulk, waitingBulk }) after every call and every job check
 * @param bulk    BULK_DEFAULTS overrides, plus `sleep` / `clock` (tests)
 * → { push(record): Promise<void>, end(): Promise<summary>, stopped (getter) }
 *   summary: { inserted, failed, errorsTotal, errors, errorGroups, errorGroupsOther, ids, bySobject, byStep,
 *              notSent, cancelled, stopped, bulk, bulkJobs, bulkAborted, warnings }
 */
export function createInserter(client, target, {
  window = INSERT_WINDOW, keepId = () => true, signal, forceSignal, onBatch, failFast = FAIL_FAST_BATCHES, maxErrors = MAX_ERRORS_REPORTED, batchSize = BATCH_SIZE,
  plan = null, onInserted = null, onBulkJob = null, bulk: bulkOptions = {},
} = {}) {
  const { sleep = interruptibleSleep, clock = () => Date.now(), ...bulkOverrides } = bulkOptions;
  const B = { ...BULK_DEFAULTS, ...bulkOverrides };
  const idByRef = new Map(); // kept Ids (keepId) of earlier windows
  const failedRefs = new Set(); // kept failures of earlier windows
  const errors = [];
  const groups = createErrorGroups();
  const bySobject = {}; // sObject → { inserted, failed }
  const byStep = {}; // nodeId → { inserted, failed }
  const firstCalls = new Map(); // sObject → { calls, anySuccess } (fail fast)
  const warnings = [];
  const bulkJobs = []; // job log (history): { jobId, nodeId, sobject, records, state, idsCollected, … }
  const bulkSteps = new Map(); // nodeId → Bulk state of a step the plan sends through Bulk
  let errorsTotal = 0;
  let inserted = 0;
  let notSent = 0;
  let cancelled = false;
  let stopped = null;
  let bulkAborted = null;
  let active = null; // { promise, info } of the Bulk job in flight
  let buffer = [];

  for (const [nodeId, p] of Object.entries(plan ?? {})) {
    if (p?.mode === 'bulk') {
      bulkSteps.set(nodeId, { nodeId, sobject: p.sobject, plannedJobs: p.jobs ?? 0, probeOk: false, fallback: false, rows: [], records: [], jobs: 0, consecutiveFails: 0, stats: { jobs: 0, records: 0, inserted: 0, failed: 0 } });
    }
  }

  const counts = (sobject) => (bySobject[sobject] ??= { inserted: 0, failed: 0 });
  const stepCounts = (nodeId) => (byStep[nodeId ?? ''] ??= { inserted: 0, failed: 0 });
  const buffered = () => { let n = 0; for (const s of bulkSteps.values()) n += s.rows.length; return n; };

  /** Progress: exact counts plus, while a job is processed, its processed − failed (provisional). */
  function progress() {
    if (!onBatch) return;
    const a = active?.info;
    let ins = inserted;
    let bySo = bySobject;
    // Design 0012 D: per Record step too (bounded by the number of steps), for the live card chips.
    let bySt = Object.fromEntries(Object.entries(byStep).filter(([id]) => id).map(([id, c]) => [id, { ...c }]));
    if (a && a.state === 'processing') {
      const extra = Math.max(0, a.processed - a.failed);
      ins += extra;
      bySo = { ...bySobject, [a.sobject]: { inserted: (bySobject[a.sobject]?.inserted ?? 0) + extra, failed: bySobject[a.sobject]?.failed ?? 0 } };
      if (a.nodeId) bySt = { ...bySt, [a.nodeId]: { inserted: (bySt[a.nodeId]?.inserted ?? 0) + extra, failed: bySt[a.nodeId]?.failed ?? 0 } };
    }
    onBatch({
      inserted: ins,
      failed: errorsTotal,
      bySobject: bySo,
      byStep: bySt,
      bulk: a ? { nodeId: a.nodeId, sobject: a.sobject, jobId: a.jobId, job: a.job, jobs: a.jobs, processed: a.processed, failed: a.failed, records: a.records } : null,
      waitingBulk: a && a.state === 'processing' && (signal?.aborted || cancelled) ? { jobId: a.jobId, sobject: a.sobject, processed: a.processed, records: a.records, forced: Boolean(forceSignal?.aborted) } : null,
    });
  }

  function fail(record, message, extra = {}) {
    errorsTotal++;
    counts(record.sobject).failed++;
    stepCounts(record.nodeId).failed++;
    const e = { ref: record.ref, sobject: record.sobject, ...(record.nodeId ? { nodeId: record.nodeId } : {}), message, ...extra };
    if (errors.length < maxErrors) errors.push(e);
    groups.add({ sobject: record.sobject, nodeId: record.nodeId, field: extra.field, message, ref: record.ref });
  }

  /** Records the Ids on disk (history) before the next write; a failure stops the insert. */
  async function recordIds(rows) {
    if (!onInserted || !rows.length) return true;
    try {
      await onInserted(rows);
      return true;
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
      return false;
    }
  }

  /**
   * One sObject Collections call. `rows` are the bodies of `chunk` (toSObject); `onId` / `onFail`
   * receive each record's outcome (window bookkeeping).
   */
  async function sendCollections(sobject, chunk, rows, { onId, onFail }) {
    let results;
    try {
      results = await client.create(target, sobject, rows);
    } catch (e) {
      results = chunk.map(() => ({ success: false, errors: [{ message: e.message }] }));
    }
    let ok = 0;
    let failedHere = 0;
    let firstFailure = null;
    const okRows = [];
    const okSteps = new Set();
    chunk.forEach((r, idx) => {
      const res = results?.[idx];
      if (res?.success) {
        onId?.(r.ref, res.id);
        inserted++;
        ok++;
        counts(sobject).inserted++;
        stepCounts(r.nodeId).inserted++;
        okRows.push({ sobject, step: r.nodeId ?? '', ref: r.ref, id: res.id });
        if (r.nodeId) okSteps.add(r.nodeId);
      } else {
        onFail?.(r.ref);
        const f = describeFailure(res, r);
        firstFailure ??= { ...f, nodeId: r.nodeId };
        failedHere++;
        fail(r, f.message, f.field ? { field: f.field } : {});
      }
    });
    // The probe of a Bulk step is over once one of its records went through.
    for (const id of okSteps) {
      const s = bulkSteps.get(id);
      if (s) s.probeOk = true;
    }
    const fc = firstCalls.get(sobject) ?? { calls: 0, anySuccess: false, failed: 0 };
    fc.calls++;
    fc.failed += failedHere; // records Salesforce refused (not the children skipped because of them)
    if (ok) fc.anySuccess = true;
    firstCalls.set(sobject, fc);
    if (!fc.anySuccess && fc.calls >= failFast) {
      stopped ??= { reason: 'allFailing', sobject, nodeId: firstFailure?.nodeId, message: firstFailure?.message, batches: fc.calls, records: fc.failed };
    }
    await recordIds(okRows);
    progress();
  }

  /** The record goes into its step's Bulk buffer instead of a Collections call. */
  const goesBulk = (r) => {
    const s = r.nodeId ? bulkSteps.get(r.nodeId) : null;
    return Boolean(s && s.probeOk && !s.fallback);
  };

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
    const windowBuffered = new Set();
    const idOf = { get: (ref) => windowIds.get(ref) ?? idByRef.get(ref) };
    const hasId = (ref) => windowIds.has(ref) || idByRef.has(ref);
    const isFailed = (ref) => windowFailed.has(ref) || failedRefs.has(ref);
    const inWindow = new Set(records.map((r) => r.ref));
    const handlers = { onId: (ref, id) => windowIds.set(ref, id), onFail: (ref) => windowFailed.add(ref) };
    const handled = (r) => windowIds.has(r.ref) || windowFailed.has(r.ref) || windowBuffered.has(r.ref);
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
        let i = 0;
        while (i < group.length) {
          if (goesBulk(group[i])) {
            const r = group[i++];
            windowBuffered.add(r.ref);
            await toBulkBuffer(r, idOf);
            continue;
          }
          const chunk = [];
          while (i < group.length && chunk.length < batchSize && !goesBulk(group[i])) chunk.push(group[i++]);
          // Let a pending Dừng / closed connection reach the signal before every call.
          await new Promise((resolve) => setImmediate(resolve));
          if (signal?.aborted) cancelled = true;
          if (cancelled || stopped) {
            notSent += pending.filter((r) => !handled(r)).length;
            return finishWindow();
          }
          await sendCollections(sobject, chunk, chunk.map((r) => toSObject(r, idOf)), handlers);
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

  // ---------- Bulk API 2.0 ----------

  async function toBulkBuffer(record, idOf) {
    const s = bulkSteps.get(record.nodeId);
    s.rows.push(toSObject(record, idOf));
    s.records.push(record);
    if (s.rows.length >= B.jobRecords) await submit(s);
    else if (buffered() > B.maxBuffered * B.jobRecords) {
      // Several Bulk steps filling at once: send the largest buffer rather than hold more.
      const largest = [...bulkSteps.values()].sort((a, b) => b.rows.length - a.rows.length)[0];
      await submit(largest);
    }
  }

  /** Sends a step's buffer as one job (after the job in flight ended: one job at a time). */
  async function submit(step) {
    const rows = step.rows;
    const records = step.records;
    step.rows = [];
    step.records = [];
    if (!rows.length) return;
    if (active) await active.promise;
    if (signal?.aborted) cancelled = true;
    if (stopped || cancelled) {
      notSent += rows.length;
      return;
    }
    if (step.fallback) return sendFallback(step, records, rows);
    const job = client.bulkJob(target, { object: step.sobject, operation: 'insert' });
    try {
      await job.open();
    } catch (e) {
      const code = codeOf(e);
      if (code && !NO_FALLBACK.has(code) && step.jobs === 0) {
        // Nothing was written: this sObject cannot go Bulk, so the step uses Collections from now on.
        step.fallback = true;
        warnings.push({ nodeId: step.nodeId, sobject: step.sobject, code: 'bulkFallback', error: e.message });
        return sendFallback(step, records, rows);
      }
      // Limits, network: like a failed Collections call, every record of the would-be job failed.
      for (const r of records) fail(r, e.message);
      step.stats.failed += records.length;
      afterJob(step, 0, records.length, e.message);
      progress();
      return undefined;
    }
    step.jobs++;
    const entry = { jobId: job.id, nodeId: step.nodeId, sobject: step.sobject, records: rows.length, state: 'Open', idsCollected: false };
    bulkJobs.push(entry);
    // The job Id is on disk before anything is uploaded: an interrupted job can still be looked up.
    try {
      await onBulkJob?.(entry);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
      try { await job.abort(); } catch { /* nothing uploaded yet */ }
      entry.state = 'Aborted';
      entry.neverProcessed = true;
      notSent += rows.length;
      return undefined;
    }
    const info = { nodeId: step.nodeId, sobject: step.sobject, jobId: job.id, job: step.jobs, jobs: Math.max(step.plannedJobs, step.jobs), processed: 0, failed: 0, records: rows.length, state: 'uploading' };
    const promise = runJob(step, job, records, rows, entry, info)
      .catch((e) => {
        // Unexpected: counted as a failed job rather than losing the run.
        for (const r of records) fail(r, e.message, { bulkJobId: job.id });
        entry.state = 'Failed';
      })
      .finally(() => {
        if (active?.promise === promise) active = null;
      });
    active = { promise, info };
    progress();
    return undefined;
  }

  /** A step that cannot go Bulk: its buffered rows (Ids already resolved) through Collections. */
  async function sendFallback(step, records, rows) {
    for (let i = 0; i < records.length; i += batchSize) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) cancelled = true;
      if (cancelled || stopped) {
        notSent += records.length - i;
        return;
      }
      const chunk = records.slice(i, i + batchSize);
      await sendCollections(step.sobject, chunk, rows.slice(i, i + batchSize), {
        onId: (ref, id) => { if (keepId(ref)) idByRef.set(ref, id); },
        onFail: (ref) => { if (keepId(ref)) failedRefs.add(ref); },
      });
    }
  }

  /** Upload, close, follow and read the results of one job (runs alongside the Collections calls). */
  async function runJob(step, job, records, rows, entry, info) {
    const { columns, csv } = toBulkCsv(rows);
    let closing = false;
    try {
      await job.upload(csv);
      if (signal?.aborted || forceSignal?.aborted) {
        // Dừng while uploading: the job was never closed, nothing was processed.
        try { await job.abort(); } catch { /* best effort */ }
        entry.state = 'Aborted';
        entry.idsCollected = true;
        entry.neverProcessed = true;
        notSent += records.length;
        cancelled = true;
        await saveEntry(entry);
        return;
      }
      closing = true;
      await job.close();
    } catch (e) {
      try { await job.abort(); } catch { /* best effort */ }
      entry.state = 'Failed';
      // A failed upload never reached Salesforce's queue; a failed close might have: then the
      // job stays "unread" and a delete looks at it first (review S3).
      entry.idsCollected = !closing;
      if (!closing) entry.neverProcessed = true;
      for (const r of records) fail(r, e.message, { bulkJobId: job.id });
      step.stats.failed += records.length;
      afterJob(step, 0, records.length, e.message);
      await saveEntry(entry);
      progress();
      return;
    }
    info.state = 'processing';
    entry.state = 'UploadComplete';
    progress();
    const end = await pollBulkJob(job, {
      forceSignal,
      sleep,
      clock,
      opts: B,
      onCheck: (st) => {
        info.processed = Number(st.numberRecordsProcessed) || 0;
        info.failed = Number(st.numberRecordsFailed) || 0;
        progress();
      },
    });
    entry.state = end.state;
    if (end.timedOut || end.error) {
      // Still running in the org (or no longer reachable): its Ids are fetched before a delete.
      const msg = end.timedOut
        ? `Job Bulk ${job.id} (${step.sobject}) chưa xong sau ${Math.round(B.timeoutMs / 60000)} phút nên app đã ngừng theo dõi và dừng lần chạy. Job có thể vẫn đang chạy trong org: xem Setup → Bulk Data Load Jobs. Lịch sử ghi lại mã job này.`
        : `Không theo dõi được job Bulk ${job.id} (${step.sobject}): ${end.error.message}. Job có thể vẫn đang chạy trong org: xem Setup → Bulk Data Load Jobs. Lịch sử ghi lại mã job này.`;
      stopped ??= { reason: 'bulkTimeout', sobject: step.sobject, nodeId: step.nodeId, jobId: job.id, message: msg, records: records.length };
      entry.idsCollected = false;
      notSent += records.length;
      await saveEntry(entry);
      progress();
      return;
    }
    let ok = null;
    let ko = null;
    try { ok = await job.successfulResults(); } catch { ok = null; }
    if (end.state !== 'Failed') {
      try { ko = await job.failedResults(); } catch { ko = null; }
    }
    // Successes: Ids on disk (no ref: Bulk results come back in no order), counted.
    const okRows = (ok ?? []).filter((l) => l?.sf__Id).map((l) => ({ sobject: step.sobject, step: step.nodeId, ref: '', id: l.sf__Id }));
    inserted += okRows.length;
    counts(step.sobject).inserted += okRows.length;
    stepCounts(step.nodeId).inserted += okRows.length;
    step.stats.inserted += okRows.length;
    entry.inserted = okRows.length;
    // Review S2: "collected" only once the Ids are on disk; otherwise a delete reads them again.
    entry.idsCollected = ok !== null && (await recordIds(okRows));
    let failedCount = 0;
    let firstMessage = null;
    if (end.state === 'Failed') {
      const message = `Job Bulk ${job.id} (${step.sobject}) thất bại: ${end.info?.errorMessage ?? 'không rõ lỗi'}. Bản ghi của job này chưa được insert. Bỏ chọn "Dùng Bulk API 2.0" trong hộp xác nhận để gửi bằng sObject Collections.`;
      const n = Math.max(0, records.length - okRows.length);
      for (let i = 0; i < n; i++) fail({ ref: '', sobject: step.sobject, nodeId: step.nodeId, fields: {} }, message, { bulkJobId: job.id });
      failedCount = n;
      firstMessage = message;
    } else {
      // Failures mapped back to the uploaded line when its content matches exactly one line.
      const byKey = new Map();
      rows.forEach((row, i) => {
        const k = rowKey(row, columns);
        byKey.set(k, byKey.has(k) ? -1 : i);
      });
      for (const line of ko ?? []) {
        const data = dataOf(line);
        const idx = byKey.get(rowKey(data, columns));
        const rec = idx !== undefined && idx >= 0 ? records[idx] : { ref: '', sobject: step.sobject, nodeId: step.nodeId, fields: data };
        const f = describeFailure({ errors: [parseBulkError(line.sf__Error)] }, rec);
        fail(rec, f.message, { ...(f.field ? { field: f.field } : {}), ...(rec.ref ? {} : { bulkJobId: job.id }) });
        firstMessage ??= f.message;
        failedCount++;
      }
      // Lines Salesforce did not process (aborted job, or no results): not sent.
      const rest = Math.max(0, records.length - okRows.length - failedCount);
      if (end.state === 'Aborted' || ok === null) notSent += rest;
      else if (rest) {
        for (let i = 0; i < rest; i++) fail({ ref: '', sobject: step.sobject, nodeId: step.nodeId, fields: {} }, 'Salesforce không trả kết quả cho bản ghi này.', { bulkJobId: job.id });
        failedCount += rest;
      }
    }
    step.stats.failed += failedCount;
    entry.failed = failedCount;
    if (end.state === 'Aborted') {
      cancelled = true;
      bulkAborted = { jobId: job.id, sobject: step.sobject, nodeId: step.nodeId, processed: Math.max(info.processed, okRows.length + failedCount), records: records.length, idsKnown: ok !== null };
      if (ok === null) entry.idsUnknown = true;
    } else afterJob(step, okRows.length, failedCount, firstMessage);
    await saveEntry(entry);
    progress();
  }

  async function saveEntry(entry) {
    try {
      await onBulkJob?.(entry);
    } catch (e) {
      stopped ??= { reason: 'history', message: e.message };
    }
  }

  /** Two consecutive jobs of a step that failed completely stop the run. */
  function afterJob(step, ok, failedCount, message) {
    step.stats.jobs++;
    step.stats.records += ok + failedCount;
    if (!ok && failedCount) {
      step.consecutiveFails++;
      step.failedRecords = (step.failedRecords ?? 0) + failedCount;
      step.firstMessage ??= message;
      if (step.consecutiveFails >= B.failJobs) {
        stopped ??= { reason: 'bulkFailing', sobject: step.sobject, nodeId: step.nodeId, message: step.firstMessage, jobs: step.consecutiveFails, records: step.failedRecords };
      }
    } else {
      step.consecutiveFails = 0;
      step.failedRecords = 0;
      step.firstMessage = null;
    }
  }

  return {
    get stopped() {
      return stopped ?? (cancelled ? { reason: 'cancelled' } : null);
    },
    /** The Bulk job in flight: { nodeId, sobject, jobId, job, jobs, processed, failed, records, state } | null. */
    get activeBulk() {
      return active?.info ?? null;
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
      // What is left in the Bulk buffers: the last (maybe small) jobs, one at a time.
      for (const s of bulkSteps.values()) if (s.rows.length) await submit(s);
      while (active) await active.promise;
      return {
        inserted,
        failed: errorsTotal,
        errorsTotal,
        errors,
        errorGroups: groups.list(),
        // Groups past MAX_ERROR_GROUPS: how many more (at least) and how many records they hold.
        errorGroupsOther: groups.other(),
        ids: Object.fromEntries(idByRef),
        bySobject,
        byStep,
        notSent,
        cancelled,
        stopped,
        bulk: [...bulkSteps.values()].filter((s) => s.stats.jobs || s.jobs).map((s) => ({ nodeId: s.nodeId, sobject: s.sobject, jobs: s.jobs, records: s.stats.records, inserted: s.stats.inserted, failed: s.stats.failed })),
        bulkJobs,
        bulkAborted,
        warnings,
      };
    },
  };
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
