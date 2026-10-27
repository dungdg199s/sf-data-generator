// Which record steps are "upstream" of a step, and how surely (design 0003 "Phía trước").
// This is the minimal, record-only version needed for Lookup `ref`. Design 0005's
// analyzeScope (variables, templates, loop vars) replaces this module later: keep every
// "is this alias usable here?" question going through it, on both client and server.
// Pure: no DOM, no I/O, no imports.
//
// States of a source (record alias) at a step, using 0005's names:
//   visible  always  — runs before, directly in a sequence enclosing the step
//            last    — created in the body of a loop that finished above and always runs ≥ 1 time
//            maybe   — created in a branch, or in a loop that may run 0 times, above the step
//   hidden   after       — runs after the step, or is the step itself
//            otherBranch — in the other column of a branch that encloses the step
//            disabled    — the source, or a container around it, is turned off
//   unknown  — no record step has that alias

const RANK = { always: 0, last: 1, maybe: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Lowest number of times a loop body runs (0 when it may be skipped). */
export function loopMinIterations(config = {}) {
  const c = config ?? {};
  if ((c.mode ?? 'fixed') === 'range') return Math.max(0, Number(c.min ?? 1)) || 0;
  return Math.max(0, Number(c.count ?? 0)) || 0;
}

/**
 * @param wf        workflow v2
 * @param slotKeys  (type) → slot keys in reading order (optional)
 * @returns {{ sources: Map<alias, {alias, stepId, sobject, disabled}>, at: Map<stepId, {visible: Map<alias, certainty>, other: Set<alias>, disabled: boolean}> }}
 */
export function analyzeRecordScope(wf, slotKeys) {
  const sources = new Map();
  const at = new Map();
  const keysOf = (step) => {
    const declared = slotKeys ? slotKeys(step.type) ?? [] : [];
    return declared.length ? declared : Object.keys(step.slots ?? {});
  };

  // Aliases defined anywhere inside a list of steps (used for "the other branch").
  const definedIn = (steps, out = new Set()) => {
    for (const s of Array.isArray(steps) ? steps : []) {
      if (!s || typeof s !== 'object') continue;
      if (s.type === 'record' && s.config?.alias) out.add(s.config.alias);
      for (const k of keysOf(s)) definedIn(s.slots?.[k], out);
    }
    return out;
  };

  function walk(steps, S, other, off) {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== 'object') continue;
      const disabled = off || step.disabled === true;
      if (step.id !== undefined && !at.has(step.id)) at.set(step.id, { visible: new Map(S), other, disabled });
      if (step.type === 'record') {
        const alias = step.config?.alias;
        if (alias && !sources.has(alias)) sources.set(alias, { alias, stepId: step.id, sobject: step.config?.sobject, disabled });
        if (alias && !disabled) S.set(alias, 'always');
        continue;
      }
      const keys = keysOf(step);
      if (!keys.length) continue;
      if (step.type === 'loop') {
        const inner = new Map(S);
        walk(step.slots?.[keys[0]], inner, other, disabled);
        const once = loopMinIterations(step.config) >= 1;
        for (const [alias, c] of inner) if (!S.has(alias)) S.set(alias, once ? worse('last', c) : 'maybe');
        continue;
      }
      // Any other container: its slots are alternatives (exactly one runs), like a branch.
      const results = keys.map((key, i) => {
        const others = new Set(other);
        keys.forEach((k, j) => { if (j !== i) definedIn(step.slots?.[k], others); });
        const inner = new Map(S);
        walk(step.slots?.[key], inner, others, disabled);
        return inner;
      });
      const added = new Set(results.flatMap((r) => [...r.keys()].filter((a) => !S.has(a))));
      for (const alias of added) {
        const all = results.every((r) => r.has(alias));
        S.set(alias, all ? results.map((r) => r.get(alias)).reduce(worse) : 'maybe');
      }
    }
  }
  walk(wf?.steps, new Map(), new Set(), false);
  return { sources, at };
}

/**
 * State of `alias` as seen from step `stepId`:
 * { state: 'always' | 'last' | 'maybe' | 'after' | 'otherBranch' | 'disabled' | 'unknown', source }
 */
export function refState(scope, stepId, alias) {
  const source = scope.sources.get(alias);
  if (!source) return { state: 'unknown', source: null };
  if (source.disabled) return { state: 'disabled', source };
  const here = scope.at.get(stepId);
  if (here?.visible.has(alias)) return { state: here.visible.get(alias), source };
  if (here?.other.has(alias)) return { state: 'otherBranch', source };
  return { state: 'after', source };
}

export const USABLE = new Set(['always', 'last', 'maybe']);

/**
 * Record aliases for the "Bản ghi cha" picker at `stepId`: usable ones first, nearest first,
 * then the others with the reason they cannot be used.
 */
export function recordChoices(scope, stepId) {
  const here = scope.at.get(stepId);
  const usable = here ? [...here.visible.keys()].reverse() : [];
  const out = usable.map((alias) => ({ ...scope.sources.get(alias), state: here.visible.get(alias), usable: true }));
  for (const [alias, source] of scope.sources) {
    if (source.stepId === stepId || here?.visible.has(alias)) continue;
    out.push({ ...source, state: refState(scope, stepId, alias).state, usable: false });
  }
  return out;
}

export const HIDDEN_REASON = {
  after: 'nằm phía dưới bước này',
  otherBranch: 'ở nhánh khác của Rẽ nhánh',
  disabled: 'đang tắt',
};
