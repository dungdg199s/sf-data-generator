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
//
// Stopping: `signal` (Dừng, closed connection) is checked before each call, and the call in flight
// is always awaited, so `inserted` is exact. Fail fast: when the first FAIL_FAST_BATCHES calls of
// one sObject all fail completely, nothing more is sent (`stopped.reason: 'allFailing'`).

export const BATCH_SIZE = 200; // sObject Collections limit
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

/** "STATUS: message [Field]" of a SaveResult, and the field when Salesforce names exactly one of the record. */
function describeFailure(res, record) {
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
 * @param client  server/sf/client.js client (needs `create(target, sobject, records)`)
 * @param target  org alias/username
 * @param window  records gathered before inserting (waves run inside a window)
 * @param keepId  (ref) → keep its Id (and failure) after its window: later records may point at it
 * @param signal  AbortSignal: stop before the next call
 * @param onBatch ({ inserted, failed, bySobject }) after every call (and skipped records)
 * → { push(record): Promise<void>, end(): Promise<summary>, stopped (getter) }
 *   summary: { inserted, failed, errorsTotal, errors, errorGroups, errorGroupsOther, ids, bySobject, notSent, cancelled, stopped }
 */
export function createInserter(client, target, {
  window = INSERT_WINDOW, keepId = () => true, signal, onBatch, failFast = FAIL_FAST_BATCHES, maxErrors = MAX_ERRORS_REPORTED, batchSize = BATCH_SIZE,
} = {}) {
  const idByRef = new Map(); // kept Ids (keepId) of earlier windows
  const failedRefs = new Set(); // kept failures of earlier windows
  const errors = [];
  const groups = new Map();
  const otherGroups = { groups: 0, count: 0, keys: new Set() }; // beyond MAX_ERROR_GROUPS
  const bySobject = {}; // sObject → { inserted, failed }
  const firstCalls = new Map(); // sObject → { calls, anySuccess } (fail fast)
  let errorsTotal = 0;
  let inserted = 0;
  let notSent = 0;
  let cancelled = false;
  let stopped = null;
  let buffer = [];

  const counts = (sobject) => (bySobject[sobject] ??= { inserted: 0, failed: 0 });
  const progress = () => onBatch?.({ inserted, failed: errorsTotal, bySobject });

  function fail(record, message, extra = {}) {
    errorsTotal++;
    counts(record.sobject).failed++;
    const e = { ref: record.ref, sobject: record.sobject, ...(record.nodeId ? { nodeId: record.nodeId } : {}), message, ...extra };
    if (errors.length < maxErrors) errors.push(e);
    const key = `${record.sobject}\u0000${record.nodeId ?? ''}\u0000${extra.field ?? ''}\u0000${errorPattern(message)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (g.refs.length < GROUP_EXAMPLES) g.refs.push(record.ref);
    } else if (groups.size < MAX_ERROR_GROUPS) {
      groups.set(key, { sobject: record.sobject, ...(record.nodeId ? { nodeId: record.nodeId } : {}), ...(extra.field ? { field: extra.field } : {}), message, count: 1, refs: [record.ref] });
    } else {
      // Counted, not listed. The key set is bounded too: past 10 000 distinct keys only the count grows.
      otherGroups.count++;
      if (!otherGroups.keys.has(key) && otherGroups.keys.size < 10000) {
        otherGroups.keys.add(key);
        otherGroups.groups++;
      }
    }
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
    const idOf = { get: (ref) => windowIds.get(ref) ?? idByRef.get(ref) };
    const hasId = (ref) => windowIds.has(ref) || idByRef.has(ref);
    const isFailed = (ref) => windowFailed.has(ref) || failedRefs.has(ref);
    const inWindow = new Set(records.map((r) => r.ref));
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
        for (let i = 0; i < group.length; i += batchSize) {
          const chunk = group.slice(i, i + batchSize);
          // Let a pending Dừng / closed connection reach the signal before every call.
          await new Promise((resolve) => setImmediate(resolve));
          if (signal?.aborted) cancelled = true;
          if (cancelled || stopped) {
            notSent += pending.length - countHandled(pending, windowIds, windowFailed);
            return finishWindow();
          }
          let results;
          try {
            results = await client.create(target, sobject, chunk.map((r) => toSObject(r, idOf)));
          } catch (e) {
            results = chunk.map(() => ({ success: false, errors: [{ message: e.message }] }));
          }
          let ok = 0;
          let failedHere = 0;
          let firstFailure = null;
          chunk.forEach((r, idx) => {
            const res = results?.[idx];
            if (res?.success) {
              windowIds.set(r.ref, res.id);
              inserted++;
              ok++;
              counts(sobject).inserted++;
            } else {
              windowFailed.add(r.ref);
              const f = describeFailure(res, r);
              firstFailure ??= { ...f, nodeId: r.nodeId };
              failedHere++;
              fail(r, f.message, f.field ? { field: f.field } : {});
            }
          });
          const fc = firstCalls.get(sobject) ?? { calls: 0, anySuccess: false, failed: 0 };
          fc.calls++;
          fc.failed += failedHere; // records Salesforce refused (not the children skipped because of them)
          if (ok) fc.anySuccess = true;
          firstCalls.set(sobject, fc);
          if (!fc.anySuccess && fc.calls >= failFast) {
            stopped = { reason: 'allFailing', sobject, nodeId: firstFailure?.nodeId, message: firstFailure?.message, batches: fc.calls, records: fc.failed };
          }
          progress();
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
        notSent,
        cancelled,
        stopped,
      };
    },
  };
}

/** Records of `pending` already settled in this window (sent or skipped). */
function countHandled(pending, windowIds, windowFailed) {
  let n = 0;
  for (const r of pending) if (windowIds.has(r.ref) || windowFailed.has(r.ref)) n++;
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
