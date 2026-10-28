// Resolves dotted references used by templates and branch conditions:
//   this.Field      → field already generated earlier in the same record step
//   this.$n         → number of the record being generated (n in alias#n)
//   <alias>.Field   → latest record produced by the record step with that alias
//   <alias>.$n      → number of that record
//   <pool>.$count   → number of records in the pool (Query rows, design 0006)
//   <pick>.Field    → field of the record a Chọn bản ghi step picked (the same object as in the pool)
//   <loopAlias>.index / .index0 / .count → loop variables (default loop alias is "loop")
// Which references are valid where is decided by shared/scope.js (analyzeScope) at validation time.

import { TEMPLATE_TOKEN_SOURCE, stripPath } from '../../shared/scope.js';
import { keyOf } from '../../shared/soql.js';

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
    // A row read from the org: Salesforce field names ignore case (SELECT name … {{acc.Name}}).
    if (rec?.existing) return getPath(rec.fields, rest, { ignoreCase: true });
    base = rec?.fields;
  } else if (rest[0] === '$count' && scope.all && head in scope.all) return scope.all[head].length;
  else return undefined;
  return getPath(base, rest);
}

/**
 * `obj` followed along `keys` (an array, or a dotted path such as `Account.Type`).
 * `ignoreCase`: keys match whatever their case (rows read from the org).
 */
export function getPath(obj, keys, { ignoreCase = false } = {}) {
  let v = obj;
  for (const key of Array.isArray(keys) ? keys : String(keys ?? '').split('.').filter(Boolean)) {
    if (v === null || v === undefined) return undefined;
    v = v[ignoreCase ? keyOf(v, key) : key];
  }
  return v;
}

/** Text of a template with every `{{path}}` replaced (missing → '', `{ $ref }` → the ref). */
export function renderTemplate(template, scope, record, self = {}) {
  return String(template ?? '').replace(new RegExp(TEMPLATE_TOKEN, 'g'), (_, path) => {
    const v = resolvePath(path, scope, record, self);
    if (v === undefined || v === null) return '';
    if (typeof v === 'object' && v.$ref) return v.$ref;
    return String(v);
  });
}
