// Interprets a validated workflow and produces records. Pure: no I/O, no org access —
// inserting into an org is a separate step (server/sf/insert.js) on the returned records.
//
// Execution model:
// - Follow edges from Start. Each output port has at most one edge, so a path is a chain.
// - Record node: generates `count` records, each becoming scope.current[alias].
// - Loop node: runs the "body" chain N times with a loop variable, then continues on "done".
// - Branch node: continues on "true" or "false".
// Record pools (scope.current / scope.all) are global to the run; loop variables are lexical.

import { createRandom } from '../random.js';
import { generateValue } from '../generators/index.js';
import { evaluateCondition } from './conditions.js';
import { validateWorkflow, WorkflowError } from './schema.js';
import { LIMITS } from './nodes.js';

export function runWorkflow(workflow, opts = {}) {
  const { errors, warnings } = validateWorkflow(workflow);
  if (errors.length) throw new WorkflowError(errors);

  const seed = opts.seed ?? workflow.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRandom(seed);
  const now = opts.now ?? Date.now();
  const maxRecords = Math.min(opts.maxRecords ?? workflow.settings?.maxRecords ?? LIMITS.maxRecordsDefault, LIMITS.maxRecordsHard);
  const started = Date.now();

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
  const fieldStates = new Map(); // `${nodeId}:${field}` -> state object
  let steps = 0;

  const rootScope = { current: {}, all: {}, vars: {} };

  function fail(node, message) {
    throw new WorkflowError([{ message, nodeId: node.id }]);
  }

  function makeRecord(node, scope) {
    if (records.length >= maxRecords) {
      fail(node, `Vượt giới hạn ${maxRecords} bản ghi cho một lần chạy. Giảm số lần lặp/số bản ghi hoặc tăng maxRecords.`);
    }
    const c = node.config;
    const alias = c.alias || node.id;
    const n = (aliasCounters.get(alias) ?? 0) + 1;
    aliasCounters.set(alias, n);
    const fields = {};
    for (const field of c.fields ?? []) {
      const key = `${node.id}:${field.name}`;
      if (!fieldStates.has(key)) fieldStates.set(key, {});
      try {
        fields[field.name] = generateValue(field, {
          rng,
          now,
          scope,
          record: fields,
          fieldName: field.name,
          fieldState: fieldStates.get(key),
        });
      } catch (e) {
        if (e instanceof WorkflowError) throw e;
        throw new WorkflowError([{ message: e.message, nodeId: node.id, field: `fields.${field.name}` }]);
      }
    }
    const rec = { ref: `${alias}#${n}`, sobject: c.sobject, alias, nodeId: node.id, fields };
    records.push(rec);
    scope.current[alias] = rec;
    (scope.all[alias] ??= []).push(rec);
  }

  function runChain(startId, scope) {
    let id = startId;
    while (id) {
      if (++steps > LIMITS.maxSteps) fail(nodes.get(id), `Workflow chạy quá ${LIMITS.maxSteps} bước. Kiểm tra lại số lần lặp lồng nhau.`);
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
          fail(node, `Loại node "${node.type}" không chạy được.`);
      }
    }
  }

  const start = workflow.nodes.find((n) => n.type === 'start');
  runChain(start.id, rootScope);

  const bySobject = {};
  for (const r of records) bySobject[r.sobject] = (bySobject[r.sobject] ?? 0) + 1;

  return {
    seed,
    records,
    warnings,
    stats: { total: records.length, bySobject, durationMs: Date.now() - started },
  };
}
