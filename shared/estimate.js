// Design 0012 H: how many records a workflow will generate, before running it. A pure function
// over the tree (O(number of steps)), used by the browser (chips on the Record cards and the
// Start card) and tested in Node.
//
// Every step gets { records, min, max, exact }: `records` is the expected number of records it
// generates over the whole run (a container: everything inside it), [min, max] the range, and
// `exact` whether the expectation is certain (fixed counts all the way up). The meaning of the
// Lặp / Rẽ nhánh / Query options (count, min/max, mode, probability, limit) is read here, like
// client/js/summary.js does for the card text; slots come from the catalogue.
//
// Design 0013: a count read from a number variable is never exact (`{{accs.$count}}` of a pool
// known here expects its size, any other variable 1, within 0…maxCountPerNode); a Lặp "Mỗi giá
// trị trong danh sách" runs once per value (exact); a Lặp `each` with a filter is not exact: an
// `eq` filter is taken to split the pool between the visits (parent–child: every Contact once
// over all the Accounts), another operator to keep half; "Tối đa số bản ghi" caps every visit.

import { maxFetchFor } from './soql.js';
import { numberVarPath, valueList } from './scope.js';

const isStep = (s) => s && typeof s === 'object' && !Array.isArray(s) && s.id !== undefined && s.id !== null && s.id !== '';

/**
 * @param wf workflow v2
 * @param catalog /api/meta (nodeTypes with options and slots; limits)
 * @param opts.queryCounts { <Query step id>: rows read by the last preview } (sample rows included)
 * @returns {{ byStep: Record<id, { records, min, max, exact, iterations? }>, total: { records, min, max, exact } }}
 *   Turned-off steps (and their children) have no entry. A Lặp also has `iterations` (body runs,
 *   expected over the run).
 */
export function estimateSteps(wf, catalog, { queryCounts = {} } = {}) {
  const types = new Map((catalog?.nodeTypes ?? []).map((t) => [t.type, t]));
  const maxQueryRows = catalog?.limits?.maxQueryRows ?? 2000;
  const opt = (step, key) => {
    const v = step.config?.[key];
    if (v !== undefined && v !== null && v !== '') return v;
    return types.get(step.type)?.options?.find((o) => o.key === key)?.default;
  };
  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const cap = catalog?.limits?.maxCountPerNode ?? 100000;
  /** Iterations given by a number variable (never exact). */
  const varCount = (path) => {
    const [name, member, ...more] = path.split('.');
    const p = member === '$count' && !more.length ? pools.get(name) : null;
    return p ? { e: p.size, min: p.min, max: p.max, exact: false } : { e: 1, min: 0, max: cap, exact: false };
  };
  const slotsOf = (step) => types.get(step.type)?.slots?.map((s) => s.key) ?? [];

  const byStep = {};
  // Pool name → records it holds so far: { size, min, max, exact, grownIn: ids of the repeating
  // loops it grew inside }. Record and Chọn bản ghi append; a Query replaces.
  const pools = new Map();
  const grow = (name, add, ctx) => {
    const p = pools.get(name) ?? { size: 0, min: 0, max: 0, exact: true, grownIn: new Set() };
    p.size += add.records;
    p.min += add.min;
    p.max += add.max;
    p.exact &&= add.exact;
    for (const id of ctx.loops) p.grownIn.add(id);
    pools.set(name, p);
  };
  const zero = () => ({ records: 0, min: 0, max: 0, exact: true });
  const addTo = (sum, e) => {
    sum.records += e.records;
    sum.min += e.min;
    sum.max += e.max;
    sum.exact &&= e.exact;
    return sum;
  };

  /**
   * `ctx`: how many times the list is reached over the run — { t (expected), min, max, exact,
   * loops: enclosing loops that may run their body more than once }. → records of the list.
   */
  function walk(list, ctx) {
    const sum = zero();
    for (const step of Array.isArray(list) ? list : []) {
      if (!isStep(step) || step.disabled === true || !types.has(step.type)) continue;
      let e = zero();
      switch (step.type) {
        case 'record': {
          const count = Math.max(1, num(opt(step, 'count'), 1));
          e = { records: count * ctx.t, min: count * ctx.min, max: count * ctx.max, exact: ctx.exact };
          grow(step.config?.alias || step.id, e, ctx);
          break;
        }
        case 'loop': {
          const mode = opt(step, 'mode') ?? 'fixed';
          let it;
          if (mode === 'each') {
            const p = pools.get(step.config?.from);
            // The pool as the loop starts: exact unless it grew in a loop that also repeats this one
            // (each entry then sees a different snapshot; the size so far is an upper bound).
            it = p
              ? { e: p.size, min: p.min, max: p.max, exact: p.exact && ![...p.grownIn].some((id) => ctx.loops.includes(id)) }
              : { e: 0, min: 0, max: 0, exact: false };
            if (opt(step, 'filter') === 'compare') {
              const eq = (opt(step, 'filterOp') ?? 'eq') === 'eq';
              it = { e: eq ? it.e / Math.max(1, ctx.t) : it.e / 2, min: 0, max: it.max, exact: false };
            }
            const limit = Math.max(0, Math.trunc(num(opt(step, 'limit'), 0)));
            if (limit > 0) it = { e: Math.min(it.e, limit), min: Math.min(it.min, limit), max: Math.min(it.max, limit), exact: it.exact };
          } else if (mode === 'values') {
            const n = valueList(opt(step, 'values')).length;
            it = { e: n, min: n, max: n, exact: true };
          } else if (mode === 'range' && (numberVarPath(opt(step, 'min')) !== null || numberVarPath(opt(step, 'max')) !== null)) {
            const bound = (key) => {
              const path = numberVarPath(opt(step, key));
              if (path !== null) return varCount(path);
              const n = Math.max(0, num(opt(step, key), 1));
              return { e: n, min: n, max: n };
            };
            const a = bound('min');
            const b = bound('max');
            // While running, max < min uses min.
            it = { e: (a.e + Math.max(a.e, b.e)) / 2, min: a.min, max: Math.max(a.max, b.max), exact: false };
          } else if (mode !== 'range' && numberVarPath(opt(step, 'count')) !== null) {
            it = varCount(numberVarPath(opt(step, 'count')));
          } else if (mode === 'range') {
            const a = Math.max(0, num(opt(step, 'min'), 1));
            const b = Math.max(a, num(opt(step, 'max'), 1));
            it = { e: (a + b) / 2, min: a, max: b, exact: a === b };
          } else {
            const n = Math.max(0, num(opt(step, 'count'), 0));
            it = { e: n, min: n, max: n, exact: true };
          }
          const inner = {
            t: ctx.t * it.e, min: ctx.min * it.min, max: ctx.max * it.max, exact: ctx.exact && it.exact,
            loops: it.max > 1 ? [...ctx.loops, step.id] : ctx.loops,
          };
          e = walk(step.slots?.[slotsOf(step)[0] ?? 'body'], inner);
          e.iterations = inner.t;
          break;
        }
        case 'branch': {
          const chance = (opt(step, 'kind') ?? 'chance') === 'chance';
          const p = chance ? Math.min(1, Math.max(0, num(opt(step, 'probability'), 0.5))) : 0.5;
          const [yes, no] = slotsOf(step).length ? slotsOf(step) : ['true', 'false'];
          for (const [slot, q] of [[yes, p], [no, 1 - p]]) {
            const sure = chance && (q === 0 || q === 1);
            addTo(e, walk(step.slots?.[slot], {
              t: ctx.t * q, min: sure && q === 1 ? ctx.min : 0, max: q === 0 && chance ? 0 : ctx.max, exact: ctx.exact && sure, loops: ctx.loops,
            }));
          }
          break;
        }
        case 'query': {
          const known = Object.hasOwn(queryCounts, step.id);
          // The rows the server would fetch at most (the same rule as server/sf/query.js).
          const limit = maxFetchFor(step.config, maxQueryRows);
          const size = known ? num(queryCounts[step.id]) : limit;
          if (step.config?.alias) pools.set(step.config.alias, { size, min: known ? size : 0, max: size, exact: known, grownIn: new Set() });
          e.rows = size;
          break;
        }
        case 'pick': {
          if (step.config?.alias) grow(step.config.alias, { records: ctx.t, min: ctx.min, max: ctx.max, exact: ctx.exact }, ctx);
          break;
        }
        default: {
          // A container type this module does not know: its slots once each.
          for (const k of slotsOf(step)) addTo(e, walk(step.slots?.[k], ctx));
        }
      }
      byStep[step.id] = e;
      addTo(sum, e);
    }
    return sum;
  }

  const total = walk(wf?.steps, { t: 1, min: 1, max: 1, exact: true, loops: [] });
  return { byStep, total };
}
