// Insert / delete plan (design 0011): which Record steps go through Bulk API 2.0 and how many API
// calls a run costs. Pure, shared by the server (the `plan` event, the inserter) and the browser
// (the Insert and delete confirmations), so the two never disagree.
//
// A Record step goes Bulk when all three hold:
//   1. bulk !== 'off' (checkbox of the confirmation, `target.bulk`);
//   2. its alias is not in `referenced` (no Lookup, also through a Chọn bản ghi, needs its Ids:
//      Bulk returns successfulResults in no particular order, so Ids cannot be mapped back to refs);
//   3. it makes at least `limits.bulkMinRecords` records in the run.
// A Bulk step still sends its first records through sObject Collections (the probe) until one call
// succeeds, then the rest in jobs of `limits.bulkJobRecords`.

export const BATCH_SIZE = 200; // sObject Collections, records (or Ids) per call
export const BULK_PROBE = 200; // records sent by Collections before the first job
/** Calls one Bulk job costs: create 1 + upload 1 + close 1 + about 7 polls + successful 1 + failed 1. */
export const BULK_CALLS_PER_JOB = 12;
export const DEFAULT_BULK_LIMITS = { bulkMinRecords: 10000, bulkJobRecords: 10000 };

const limitsOf = (limits) => ({
  min: limits?.bulkMinRecords ?? DEFAULT_BULK_LIMITS.bulkMinRecords,
  job: limits?.bulkJobRecords ?? DEFAULT_BULK_LIMITS.bulkJobRecords,
});

/** One sequence of `n` records (or Ids): its mode, probe size, jobs and API calls. */
function planOne(n, eligible, { min, job }) {
  if (eligible && n >= min) {
    const probe = Math.min(BULK_PROBE, n);
    const jobs = Math.ceil((n - probe) / job);
    return { mode: 'bulk', probe, jobs, calls: { collections: 1, bulk: jobs * BULK_CALLS_PER_JOB } };
  }
  return { mode: 'collections', probe: 0, jobs: 0, calls: { collections: Math.ceil(n / BATCH_SIZE), bulk: 0 } };
}

/**
 * @param steps       [{ nodeId, alias, sobject, records }] — Record steps with their record count in the run
 * @param referenced  Set (or array) of aliases a Lookup needs the Ids of (shared/scope.js poolUsage)
 * @param bulk        'auto' | 'off'
 * @param limits      { bulkMinRecords, bulkJobRecords } (LIMITS / meta.limits)
 * → { steps: [{ nodeId, alias, sobject, records, mode, probe, jobs }], apiCalls: { collections, bulk, total } }
 *   The probe call of a Bulk step counts as a Collections call.
 */
export function planInsert({ steps, referenced, bulk = 'auto', limits } = {}) {
  const ref = referenced instanceof Set ? referenced : new Set(referenced ?? []);
  const l = limitsOf(limits);
  const apiCalls = { collections: 0, bulk: 0, total: 0 };
  const out = (steps ?? []).map((s) => {
    const n = Math.max(0, Number(s.records) || 0);
    const p = planOne(n, bulk !== 'off' && !ref.has(s.alias), l);
    apiCalls.collections += p.calls.collections;
    apiCalls.bulk += p.calls.bulk;
    return { nodeId: s.nodeId, alias: s.alias, sobject: s.sobject, records: n, mode: p.mode, probe: p.probe, jobs: p.jobs };
  });
  apiCalls.total = apiCalls.collections + apiCalls.bulk;
  return { steps: out, apiCalls };
}

/**
 * Delete plan: every sObject with at least bulkMinRecords Ids left may go Bulk (deleting needs no
 * Id mapping). `groups`: [{ sobject, count }] in delete order.
 * → { groups: [{ sobject, count, mode, probe, jobs }], apiCalls: { collections, bulk, total } }
 */
export function planDelete({ groups, bulk = 'auto', limits } = {}) {
  const l = limitsOf(limits);
  const apiCalls = { collections: 0, bulk: 0, total: 0 };
  const out = (groups ?? []).map((g) => {
    const n = Math.max(0, Number(g.count) || 0);
    const p = planOne(n, bulk !== 'off', l);
    apiCalls.collections += p.calls.collections;
    apiCalls.bulk += p.calls.bulk;
    return { ...g, count: n, mode: p.mode, probe: p.probe, jobs: p.jobs };
  });
  apiCalls.total = apiCalls.collections + apiCalls.bulk;
  return { groups: out, apiCalls };
}
