// Design 0012 H: how many records a workflow will generate, before running it. A pure function
// over the tree (O(number of steps)), used by the browser (chips on the Record cards and the
// Start card) and tested in Node.
//
// Every step gets { records, min, max, exact }: `records` is the expected number of records it
// generates over the whole run (a container: everything inside it), [min, max] the range, and
// `exact` whether the expectation is certain (fixed counts all the way up). The meaning of the
// Lặp / Rẽ nhánh / Query options (count, min/max, mode, probability, limit) is read here, like
// client/js/summary.js does for the card text; slots come from the catalogue.

const isStep = (s) => s && typeof s === 'object' && !Array.isArray(s) && s.id !== undefined && s.id !== null && s.id !== '';

/** `LIMIT n` at the end of a hand-written SOQL, or null. */
function soqlLimit(soql) {
  const m = /\blimit\s+(\d+)\s*(?:offset\s+\d+\s*)?$/i.exec(String(soql ?? '').trim());
  return m ? Number(m[1]) : null;
}

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
            // (each entry then sees a different snapshot).
            // (each entry then sees a different snapshot; the size so far is an upper bound).
            it = p
              ? { e: p.size, min: p.min, max: p.max, exact: p.exact && ![...p.grownIn].some((id) => ctx.loops.includes(id)) }
              : { e: 0, min: 0, max: 0, exact: false };
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
          const limit = (opt(step, 'mode') ?? 'builder') === 'soql' ? soqlLimit(step.config?.soql) ?? maxQueryRows : num(opt(step, 'limit'), maxQueryRows);
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
