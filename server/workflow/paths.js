// Resolves dotted references used by templates and branch conditions:
//   this.Field      → field already generated earlier in the same record node
//   <alias>.Field   → latest record produced by the record node with that alias
//   <loopAlias>.index / .index0 / .count → loop variables (default loop alias is "loop")

export function resolvePath(path, scope, record) {
  const [head, ...rest] = String(path).split('.');
  let base;
  if (head === 'this') base = record;
  else if (scope.vars && head in scope.vars) base = scope.vars[head];
  else if (scope.current && head in scope.current) base = scope.current[head]?.fields;
  else return undefined;
  let v = base;
  for (const key of rest) {
    if (v === null || v === undefined) return undefined;
    v = v[key];
  }
  return v;
}
