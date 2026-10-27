// Resolves dotted references used by templates and branch conditions:
//   this.Field      → field already generated earlier in the same record step
//   this.$n         → number of the record being generated (n in alias#n)
//   <alias>.Field   → latest record produced by the record step with that alias
//   <alias>.$n      → number of that record
//   <loopAlias>.index / .index0 / .count → loop variables (default loop alias is "loop")
// Which references are valid where is decided by shared/scope.js (analyzeScope) at validation time.

import { TEMPLATE_TOKEN_SOURCE, stripPath } from '../../shared/scope.js';

/** Source of the template token regex `{{path}}` (single declaration in shared/scope.js). */
export const TEMPLATE_TOKEN = TEMPLATE_TOKEN_SOURCE;

const refNumber = (ref) => Number(String(ref).slice(String(ref).lastIndexOf('#') + 1));

/**
 * @param path   `acc.Name`; a branch `left` may also be written `{{acc.Name}}`
 * @param self   { n } of the record being generated (for this.$n)
 */
export function resolvePath(path, scope, record, self = {}) {
  const [head, ...rest] = stripPath(path).split('.');
  let base;
  if (head === 'this') {
    if (rest[0] === '$n') return self.n;
    base = record;
  } else if (scope.vars && head in scope.vars) base = scope.vars[head];
  else if (scope.current && head in scope.current) {
    const rec = scope.current[head];
    if (rest[0] === '$n') return rec?.ref ? refNumber(rec.ref) : undefined;
    base = rec?.fields;
  } else return undefined;
  let v = base;
  for (const key of rest) {
    if (v === null || v === undefined) return undefined;
    v = v[key];
  }
  return v;
}
