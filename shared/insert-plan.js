// Insert plan (design 0011 §1): which Record steps go through Bulk API 2.0 and how many API calls
// an insert (or a delete of an insert) takes. Pure; used by the server for the `plan` event and by
// the browser for the confirmation dialog, so both always agree.
//
// A Record step goes Bulk when all three hold:
//   1. bulk !== 'off' (checkbox of the confirmation dialog, `target.bulk`);
//   2. its alias is not in `referenced` (no Lookup, even through a Chọn bản ghi, needs its Ids:
//      Bulk returns successfulResults in no particular order, so Ids cannot be mapped to refs);
//   3. it creates at least `bulkMinRecords` records in this run.
// Its first records still go through sObject Collections (the probe call, so configuration errors
// are caught by the fail-fast rule with exact refs); the rest go in jobs of `bulkJobRecords`.

export const BULK_DEFAULTS = Object.freeze({
  bulkMinRecords: 10000,
  bulkJobRecords: 10000,
  bulkJobTimeoutMs: 30 * 60 * 1000,
  batchSize: 200, // sObject Collections records per call
  callsPerJob: 12, // create 1 + upload 1 + close 1 + about 7 checks + successful 1 + failed 1
});

/** Jobs and calls of `n` records through the Bulk path (probe call + jobs). */
function bulkCost(n, l) {
  const probe = Math.min(l.batchSize, n);
  const jobs = Math.ceil(Math.max(0, n - probe) / l.bulkJobRecords);
  return { probe, jobs, calls: 1 + jobs * l.callsPerJob };
}

/**
 * @param steps       [{ nodeId, alias, sobject, records }] Record steps with their record counts
 *                    (from the dry pass / preview stats), in insert order
 * @param referenced  Set<alias> (or array) whose Ids a Lookup needs (poolUsage(...).referenced)
 * @param bulk        'auto' | 'off'
 * @param limits      overrides of BULK_DEFAULTS (meta.limits)
 * → { steps: [{ nodeId, alias, sobject, records, mode: 'collections' | 'bulk', probe, jobs, apiCalls }],
 *     apiCalls: { collections, bulk, total } }
 */
export function planInsert({ steps = [], referenced = new Set(), bulk = 'auto', limits = {} } = {}) {
  const l = { ...BULK_DEFAULTS, ...pick(limits) };
  const refs = referenced instanceof Set ? referenced : new Set(referenced ?? []);
  const apiCalls = { collections: 0, bulk: 0, total: 0 };
  const out = steps.map((s) => {
    const n = Math.max(0, Number(s.records) || 0);
    const bulkable = bulk !== 'off' && !refs.has(s.alias) && n >= l.bulkMinRecords;
    if (!bulkable) {
      const calls = Math.ceil(n / l.batchSize);
      apiCalls.collections += calls;
      return { nodeId: s.nodeId, alias: s.alias, sobject: s.sobject, records: n, mode: 'collections', probe: 0, jobs: 0, apiCalls: calls };
    }
    const { probe, jobs, calls } = bulkCost(n, l);
    apiCalls.collections += 1;
    apiCalls.bulk += calls - 1;
    return { nodeId: s.nodeId, alias: s.alias, sobject: s.sobject, records: n, mode: 'bulk', probe, jobs, apiCalls: calls };
  });
  apiCalls.total = apiCalls.collections + apiCalls.bulk;
  return { steps: out, apiCalls };
}

/**
 * Delete plan of an insert (design 0011 §7): steps in reverse insert order; a step with at least
 * `bulkMinRecords` Ids left (and bulk !== 'off') sends a probe of 200 through Collections, then
 * Bulk `delete` jobs. `steps`: [{ nodeId, sobject, remaining }] in insert order.
 * → { steps: [{ nodeId, sobject, remaining, mode, probe, jobs, apiCalls }], apiCalls: { collections, bulk, total } }
 */
export function planDelete({ steps = [], bulk = 'auto', limits = {} } = {}) {
  const l = { ...BULK_DEFAULTS, ...pick(limits) };
  const apiCalls = { collections: 0, bulk: 0, total: 0 };
  const out = [...steps].reverse().filter((s) => (Number(s.remaining) || 0) > 0).map((s) => {
    const n = Number(s.remaining);
    if (bulk === 'off' || n < l.bulkMinRecords) {
      const calls = Math.ceil(n / l.batchSize);
      apiCalls.collections += calls;
      return { nodeId: s.nodeId, sobject: s.sobject, remaining: n, mode: 'collections', probe: 0, jobs: 0, apiCalls: calls };
    }
    const { probe, jobs, calls } = bulkCost(n, l);
    apiCalls.collections += 1;
    apiCalls.bulk += calls - 1;
    return { nodeId: s.nodeId, sobject: s.sobject, remaining: n, mode: 'bulk', probe, jobs, apiCalls: calls };
  });
  apiCalls.total = apiCalls.collections + apiCalls.bulk;
  return { steps: out, apiCalls };
}

function pick(limits) {
  const out = {};
  for (const k of Object.keys(BULK_DEFAULTS)) if (Number.isFinite(limits?.[k]) && limits[k] > 0) out[k] = limits[k];
  return out;
}
