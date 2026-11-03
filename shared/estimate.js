// Record-count estimate before a run (design 0012 H). Pure: no DOM, no I/O; shared by the
// browser (chips on Record cards, the total on the Start card) and tests.
//
// One walk of the tree in reading order. Every step is reached a number of times, an `Amount`
// { exp, min, max, exact }: `exp` the expected value (null: unknown), `min` / `max` bounds (max
// null: unbounded / unknown), `exact` when the number is certain. A Record makes `count` records
// each time it runs. What the slots of a container run is read from the catalogue (`flow`:
// loop body, branch alternatives; `flow.canSkip`); how many times is read from the config
// (count / min / max / mode / values / from / filter / limit of Lặp, kind / probability of Rẽ
// nhánh) — the documented exception of design 0012 (Câu hỏi mở: declare it in the catalogue).
//
//   Lặp fixed          count                          (a variable: unknown, except {{pool.$count}})
//   Lặp range          (min + max) / 2, [min, max]    (max < min runs min times, like the executor)
//   Lặp values         number of values               exact
//   Lặp each           records of the pool `from` when the loop starts: a generated pool the
//                      records estimated above, a Query the rows of the last read (queryCounts)
//                      else its LIMIT, a Chọn bản ghi the times it picked; a filter makes the
//                      expected value unknown (≤ pool), a limit caps it
//   Rẽ nhánh chance    Đúng × p, Sai × (1 − p); compare: 50 % each
//   canSkip            what follows a step that may end the loop body (Chọn bản ghi "Bỏ qua…")
//                      in that body may not run: inexact, min 0
//   turned off         skipped with everything inside (no estimate)

import { valueList, numberVarPath, exposesOf } from './scope.js';
import { parseSoql, builderLimit } from './soql.js';
import { stepNames } from './workflow-tree.js';

const ONE = Object.freeze({ exp: 1, min: 1, max: 1, exact: true });
const ZERO = Object.freeze({ exp: 0, min: 0, max: 0, exact: true });
const UNKNOWN = Object.freeze({ exp: null, min: 0, max: null, exact: false });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nmul = (a, b) => (a === 0 || b === 0 ? 0 : a === null || b === null ? null : a * b);
const nadd = (a, b) => (a === null || b === null ? null : a + b);

/** a × b (times a step is reached × what it does each time). */
export function mul(a, b) {
  return { exp: nmul(a.exp, b.exp), min: a.min * b.min, max: nmul(a.max, b.max), exact: (a.exact && b.exact) || a.max === 0 || b.max === 0 };
}

/** a + b. */
export function add(a, b) {
  return { exp: nadd(a.exp, b.exp), min: a.min + b.min, max: nadd(a.max, b.max), exact: a.exact && b.exact };
}

const fixed = (n) => ({ exp: n, min: n, max: n, exact: true });
/** "May not happen": same expected value and maximum, minimum 0. */
const maybe = (a) => ({ ...a, min: 0, exact: a.max === 0 });

const catalogType = (catalog, type) => (catalog?.nodeTypes instanceof Map ? catalog.nodeTypes.get(type) : catalog?.nodeTypes?.find?.((t) => t.type === type));

/**
 * → { byStep: { [recordStepId]: Amount (records) }, total: Amount, unknown: boolean }
 * `queryCounts`: { [queryStepId]: rows read by the last preview }; `limits`: meta.limits
 * (maxQueryRows for a hand-written SOQL without LIMIT).
 */
export function estimateSteps(wf, catalog, { queryCounts = {}, limits = {} } = {}) {
  const byStep = {};
  let total = ZERO;
  const pools = new Map(); // name → Amount: records in the pool so far (generated, read, picked)
  const growsIn = new Map(); // name → Set of the Lặp ids open when records were added to it
  const openLoops = []; // ids of the Lặp steps around the step being walked
  const addTo = (name, amount) => {
    pools.set(name, add(pools.get(name) ?? ZERO, amount));
    const set = growsIn.get(name) ?? new Set();
    for (const id of openLoops) set.add(id);
    growsIn.set(name, set);
  };

  const optionValue = (type, c, key) => c?.[key] ?? type?.options?.find((o) => o.key === key)?.default;

  /** Times a number option (`vars: 'number'`) holds: a number, {{pool.$count}}, or unknown. */
  const numberOf = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fixed(fallback);
    const path = numberVarPath(v);
    if (path !== null) {
      const m = /^([A-Za-z_][\w]*)\.\$count$/.exec(path);
      const pool = m ? pools.get(m[1]) : null;
      return pool ? { ...pool, exact: false } : UNKNOWN;
    }
    const n = Number(v);
    return Number.isFinite(n) ? fixed(Math.max(0, Math.trunc(n))) : fixed(fallback);
  };

  /** Iterations of one run of a Lặp (`visits`: how many times the Lặp is reached). */
  const loopTimes = (type, c, visits) => {
    const mode = optionValue(type, c, 'mode') ?? 'fixed';
    if (mode === 'values') return fixed(valueList(c?.values).length);
    if (mode === 'range') {
      const lo = numberOf(c?.min, 1);
      const hi = numberOf(c?.max, 1);
      if (lo.exp === null || hi.exp === null) return { exp: null, min: lo.min, max: lo.max === null || hi.max === null ? null : Math.max(lo.max, hi.max), exact: false };
      const a = lo.exp;
      const b = Math.max(a, hi.exp);
      return a === b && lo.exact && hi.exact ? fixed(a) : { exp: (a + b) / 2, min: Math.min(lo.min, a), max: b, exact: false };
    }
    if (mode === 'each') {
      let pool = pools.get(c?.from) ?? UNKNOWN;
      // A pool that grows inside a Lặp around this one (pools are global to the run): each visit
      // sees the records made so far, on average (total + one visit's) / 2. Not exact.
      if (pool.exp !== null && [...(growsIn.get(c?.from) ?? [])].some((id) => openLoops.includes(id)) && visits?.exp) {
        const avg = (pool.exp + pool.exp / visits.exp) / 2;
        pool = { exp: avg, min: Math.min(pool.min, avg), max: pool.max, exact: false };
      }
      let n = { ...pool };
      if ((optionValue(type, c, 'filter') ?? 'none') !== 'none') n = { exp: null, min: 0, max: pool.max, exact: false };
      const limit = Number(c?.limit ?? 0);
      if (Number.isInteger(limit) && limit > 0) {
        const cap = (x) => (x === null ? limit : Math.min(x, limit));
        n = { exp: n.exp === null ? null : cap(n.exp), min: Math.min(n.min, limit), max: cap(n.max), exact: n.exact || (n.min >= limit) };
        if (n.min >= limit) n = fixed(limit);
      }
      return n;
    }
    return numberOf(c?.count, 0);
  };

  /** Rows of a Query step: the last read, else its LIMIT (inexact). */
  const queryRows = (step) => {
    if (isNum(queryCounts[step.id])) return fixed(queryCounts[step.id]);
    const c = step.config ?? {};
    const limit = (c.mode ?? 'builder') === 'soql' ? parseSoql(c.soql).limit ?? limits.maxQueryRows ?? 2000 : builderLimit(c);
    const n = Number.isFinite(limit) ? Math.max(0, limit) : 0;
    return { exp: n, min: 0, max: n, exact: false };
  };

  const canSkip = (type, c) => {
    const cs = type?.flow?.canSkip;
    return Boolean(cs && cs.in.includes(optionValue(type, c, cs.key)));
  };

  /**
   * Walk `list`, each step reached `times`. → true when a step of it may end the run of the
   * innermost loop body (`flow.canSkip`): what follows in that body is then "maybe".
   */
  const walk = (list, times) => {
    let t = times;
    let skipped = false;
    for (const step of Array.isArray(list) ? list : []) {
      if (!step || typeof step !== 'object' || step.disabled === true) continue;
      const type = catalogType(catalog, step.type);
      const c = step.config ?? {};
      const flow = type?.flow?.kind ?? 'sequence';
      const exposes = exposesOf(type, c, step.id);
      const record = exposes.find(({ ex }) => ex.kind === 'record' && ex.pool);
      if (record?.ex.origin === 'generated') {
        const count = Math.max(1, Math.trunc(Number(optionValue(type, c, 'count') ?? 1)) || 1);
        const made = mul(t, fixed(count));
        byStep[step.id] = made;
        total = add(total, made);
        const names = stepNames(step, catalog);
        for (const { value } of names.length ? names : [{ value: String(step.id) }]) addTo(value, made);
      } else if (record?.ex.origin === 'org' && c.alias) {
        pools.set(c.alias, queryRows(step));
      } else if (record?.ex.current === 'picked' && c.alias) {
        addTo(c.alias, maybe(t));
      }
      if (flow === 'loop') {
        // A skip ends one run of the body; what follows the loop is not affected.
        const n = loopTimes(type, c, t);
        openLoops.push(step.id);
        walk(step.slots?.[type.flow.body], mul(t, n));
        openLoops.pop();
      } else if (flow === 'branch') {
        const [yes, no] = type.flow.alternatives ?? [];
        const kind = optionValue(type, c, 'kind') ?? 'chance';
        let p = 0.5;
        if (kind === 'chance') {
          const raw = Number(optionValue(type, c, 'probability') ?? 0.5);
          p = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
        }
        const share = (q) => (kind === 'chance' && q === 1 ? t : kind === 'chance' && q === 0 ? ZERO
          : { exp: t.exp === null ? null : t.exp * q, min: 0, max: t.max, exact: false });
        const a = walk(step.slots?.[yes], share(p));
        const b = walk(step.slots?.[no], share(1 - p));
        if (a || b) skipped = true;
      } else {
        for (const children of Object.values(step.slots ?? {})) if (walk(children, t)) skipped = true;
      }
      if (canSkip(type, c)) skipped = true;
      if (skipped) t = maybe(t);
    }
    return skipped;
  };

  walk(wf?.steps, ONE);
  return { byStep, total, unknown: total.exp === null };
}
