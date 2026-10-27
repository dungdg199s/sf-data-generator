// FROZEN copy of the version-1 executor (graph model: nodes + edges), taken before the
// workflow became a tree (design 0003). Used only by tests to prove that migrating a v1
// workflow to v2 produces byte-identical records for the same seed. No validation.
// Do not "fix" or modernise this file: its whole value is that it does not change.

import { createRandom } from '../../server/random.js';
import { generateValue } from '../../server/generators/index.js';
import { evaluateCondition } from '../../server/workflow/conditions.js';

const MAX_STEPS = 2000000;

export function runV1(workflow, { seed, now, maxRecords = 200000 } = {}) {
  const rng = createRandom(seed);
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  const next = new Map();
  for (const e of workflow.edges) {
    const ports = next.get(e.from) ?? {};
    ports[e.fromPort ?? 'next'] = e.to;
    next.set(e.from, ports);
  }
  const follow = (id, port) => next.get(id)?.[port];

  const records = [];
  const aliasCounters = new Map();
  const fieldStates = new Map();
  let steps = 0;
  const rootScope = { current: {}, all: {}, vars: {} };

  function makeRecord(node, scope) {
    if (records.length >= maxRecords) throw new Error(`run-v1: more than ${maxRecords} records`);
    const c = node.config;
    const alias = c.alias || node.id;
    const n = (aliasCounters.get(alias) ?? 0) + 1;
    aliasCounters.set(alias, n);
    const fields = {};
    for (const field of c.fields ?? []) {
      const key = `${node.id}:${field.name}`;
      if (!fieldStates.has(key)) fieldStates.set(key, {});
      fields[field.name] = generateValue(field, {
        rng,
        now,
        scope,
        record: fields,
        fieldName: field.name,
        fieldState: fieldStates.get(key),
      });
    }
    const rec = { ref: `${alias}#${n}`, sobject: c.sobject, alias, nodeId: node.id, fields };
    records.push(rec);
    scope.current[alias] = rec;
    (scope.all[alias] ??= []).push(rec);
  }

  function runChain(startId, scope) {
    let id = startId;
    while (id) {
      if (++steps > MAX_STEPS) throw new Error('run-v1: too many steps');
      const node = nodes.get(id);
      const c = node.config ?? {};
      switch (node.type) {
        case 'start':
          id = follow(id, 'next');
          break;
        case 'record': {
          const count = Number(c.count ?? 1);
          for (let i = 0; i < count; i++) makeRecord(node, scope);
          id = follow(id, 'next');
          break;
        }
        case 'loop': {
          const times = (c.mode ?? 'fixed') === 'range' ? rng.int(Number(c.min ?? 1), Number(c.max ?? 1)) : Number(c.count ?? 0);
          const body = follow(id, 'body');
          const varName = c.alias || 'loop';
          if (body) {
            for (let i = 0; i < times; i++) {
              runChain(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: times } } });
            }
          }
          id = follow(id, 'done');
          break;
        }
        case 'branch':
          id = follow(id, evaluateCondition(c, scope, rng) ? 'true' : 'false');
          break;
        default:
          throw new Error(`run-v1: unknown node type ${node.type}`);
      }
    }
  }

  const start = workflow.nodes.find((n) => n.type === 'start');
  runChain(start.id, rootScope);
  return records;
}
