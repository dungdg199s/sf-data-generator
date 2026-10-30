// "Bọc trong Lặp qua từng bản ghi" (design 0012 C), the parts that do not need the browser: which
// pool the new Lặp `each` loops over, which Lookups are worth re-pointing at the record being
// looped over, and re-pointing them safely later (the toast's [Đổi]). Pure; client/js/ops.js
// does the editing, the undo step and the toast.

import { analyzeScope, refChoices, referenceOptions } from './scope.js';
import { findStep, subtreeIds, walkSteps } from './workflow-tree.js';

/**
 * Names a source's records come from, following Chọn bản ghi (`picked`) back to the pool they
 * were picked from: [source name, its pool, that pool's pool…] (nearest first).
 */
export function poolChain(scope, name) {
  const byName = (n) => Object.values(scope.sources).find((s) => s.name === n && s.kind === 'record');
  const out = [];
  for (let s = byName(name); s && !out.includes(s.name); s = s.current === 'picked' && s.from ? byName(s.from) : null) out.push(s.name);
  return out;
}

/**
 * Plan of a Lặp `each` around step `id` (or a block of steps: a list of ids): among the pools
 * usable at the step's place (where the Lặp goes), the one the wrapped steps refer to most (Lookup `ref`, `pick.from`, `{{accs.…}}`; a
 * reference to a Chọn bản ghi counts for the farthest usable pool it picks from), ties and no
 * reference: the nearest of them; and the Lookups worth re-pointing: random over that pool, or at
 * a Chọn bản ghi of it.
 * `scope`: analyzeScope(wf, catalog) when the caller has it cached.
 * → { from, rewire: [{ stepId, alias, fieldIndex, fieldName, ref }] } or null (no usable pool).
 */
export function eachWrapPlan(wf, catalog, id, { slotKeys, scope = analyzeScope(wf, catalog) } = {}) {
  // A block of steps (design 0012 B, multi-select): `id` is a list of ids, side by side in one
  // sequence; the Lặp goes where the first one is.
  const ids = Array.isArray(id) ? id : [id];
  const wrapped = ids.map((x) => findStep(wf, x, slotKeys)).filter(Boolean);
  if (!wrapped.length || wrapped.length !== ids.length) return null;
  const pools = refChoices(scope, ids[0], { pool: true }).filter((c) => c.usable);
  if (!pools.length) return null;
  const usable = new Set(pools.map((c) => c.name));
  const target = (name) => poolChain(scope, name).filter((n) => usable.has(n)).at(-1);
  const inside = new Set(wrapped.flatMap((at) => [...subtreeIds(at.step, slotKeys)]));
  const hits = new Map();
  for (const r of scope.refs) {
    if (r.hidden || !inside.has(r.nodeId)) continue;
    const name = target(scope.sources[r.source]?.name);
    if (name) hits.set(name, (hits.get(name) ?? 0) + 1);
  }
  const best = Math.max(0, ...hits.values());
  const from = (best ? pools.find((c) => hits.get(c.name) === best) : pools[0]).name;
  const rewire = [];
  walkSteps(wrapped.map((at) => at.step), (s) => {
    for (const o of referenceOptions(s, catalog)) {
      if (o.fieldIndex === undefined || o.def.kind !== 'ref' || !o.value) continue;
      const mode = s.config.fields[o.fieldIndex].options?.mode;
      const chain = poolChain(scope, o.value);
      if ((o.value === from && mode === 'random') || (o.value !== from && chain.includes(from))) {
        rewire.push({ stepId: s.id, alias: s.config?.alias || s.id, fieldIndex: o.fieldIndex, fieldName: o.fieldName, ref: o.value });
      }
    }
  }, slotKeys);
  return { from, rewire };
}

/**
 * [Đổi] of the toast: point the planned Lookups at the record the Lặp `loopId` loops over
 * (`mode: 'current'`, `ref: itemAlias`). Only while that Lặp still exists, still loops over each
 * record under the name `itemAlias`, and the Lookup's step is still inside it, unchanged (same
 * field name, same `ref`); otherwise nothing changes (an undo or an edit came in between).
 * Mutates `wf`. → number of Lookups changed, or null when the Lặp is gone or changed.
 */
export function applyEachRewire(wf, rewire, { loopId, itemAlias, slotKeys }) {
  const loop = findStep(wf, loopId, slotKeys)?.step;
  if (!loop || loop.type !== 'loop' || loop.config?.mode !== 'each' || loop.config?.itemAlias !== itemAlias) return null;
  const inside = subtreeIds(loop, slotKeys);
  let n = 0;
  for (const r of rewire) {
    if (!inside.has(r.stepId) || r.stepId === loopId) continue;
    const f = findStep(wf, r.stepId, slotKeys)?.step.config?.fields?.[r.fieldIndex];
    if (f?.name !== r.fieldName || f.options?.ref !== r.ref) continue;
    f.options = { ...f.options, ref: itemAlias, mode: 'current' };
    n++;
  }
  return n;
}
