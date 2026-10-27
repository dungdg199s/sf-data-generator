// Interprets a validated workflow and produces records. Pure: no I/O, no org access —
// inserting into an org is a separate step (server/sf/insert.js) on the returned records.
//
// Execution model (workflow JSON version 2, a tree of steps; v1 input is migrated first):
// - A sequence of steps runs top to bottom. A step with `disabled: true` is skipped together
//   with everything inside it, without drawing from the rng.
// - record: generates `count` records, each becoming scope.current[alias]; `n` (alias#n) is
//   passed to generators for {{this.$n}}.
// - loop: draws N (rng.int for `range`, even when the body is empty, as v1 did), runs
//   slots.body N times with a loop variable, then the next step.
// - branch: always evaluates its condition, runs slots.true or slots.false, then the next step.
// Record pools (scope.current / scope.all) are global to the run; loop variables are lexical.
// The rng call order is the same as the v1 graph executor, so a migrated v1 workflow
// produces byte-identical records for the same seed (test/migrate.test.js) — except where the
// migration copied steps: field state (unique sets, Auto Number counters) is keyed by step id,
// so a copy "c_2" counts on its own (reported by shared/migrate-v1.js describeReport).

import { createRandom } from '../random.js';
import { generateValue } from '../generators/index.js';
import { evaluateCondition } from './conditions.js';
import { prepareWorkflow, WorkflowError } from './schema.js';
import { LIMITS } from './nodes.js';

export function runWorkflow(input, opts = {}) {
  const { workflow, errors, warnings } = prepareWorkflow(input);
  if (errors.length) throw new WorkflowError(errors);

  const seed = opts.seed ?? workflow.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRandom(seed);
  const now = opts.now ?? Date.now();
  const maxRecords = Math.min(opts.maxRecords ?? workflow.settings?.maxRecords ?? LIMITS.maxRecordsDefault, LIMITS.maxRecordsHard);
  const started = Date.now();

  const records = [];
  const aliasCounters = new Map();
  const fieldStates = new Map(); // `${stepId}:${field}` -> state object
  const byStep = {};
  let visits = 0;

  const rootScope = { current: {}, all: {}, vars: {} };

  function fail(step, message) {
    throw new WorkflowError([{ message, nodeId: step.id }]);
  }

  function makeRecord(step, scope) {
    if (records.length >= maxRecords) {
      fail(step, `Vượt giới hạn ${maxRecords} bản ghi cho một lần chạy. Giảm số lần lặp/số bản ghi hoặc tăng maxRecords.`);
    }
    const c = step.config;
    const alias = c.alias || step.id;
    const n = (aliasCounters.get(alias) ?? 0) + 1;
    aliasCounters.set(alias, n);
    const fields = {};
    for (const field of c.fields ?? []) {
      const key = `${step.id}:${field.name}`;
      if (!fieldStates.has(key)) fieldStates.set(key, {});
      try {
        fields[field.name] = generateValue(field, {
          rng,
          now,
          scope,
          record: fields,
          fieldName: field.name,
          fieldState: fieldStates.get(key),
          n,
        });
      } catch (e) {
        if (e instanceof WorkflowError) throw e;
        throw new WorkflowError([{ message: e.message, nodeId: step.id, field: `fields.${field.name}` }]);
      }
    }
    const rec = { ref: `${alias}#${n}`, sobject: c.sobject, alias, nodeId: step.id, fields };
    records.push(rec);
    scope.current[alias] = rec;
    (scope.all[alias] ??= []).push(rec);
  }

  function runSteps(steps, scope) {
    for (const step of steps ?? []) {
      if (step.disabled === true) continue;
      if (++visits > LIMITS.maxSteps) fail(step, `Workflow chạy quá ${LIMITS.maxSteps} bước. Kiểm tra lại số lần lặp lồng nhau.`);
      const c = step.config ?? {};
      const stat = (byStep[step.id] ??= { runs: 0, records: 0 });
      stat.runs++;
      const before = records.length;
      switch (step.type) {
        case 'record': {
          const count = Number(c.count ?? 1);
          for (let i = 0; i < count; i++) makeRecord(step, scope);
          break;
        }
        case 'loop': {
          const times = (c.mode ?? 'fixed') === 'range' ? rng.int(Number(c.min ?? 1), Number(c.max ?? 1)) : Number(c.count ?? 0);
          const body = step.slots?.body ?? [];
          const varName = c.alias || 'loop';
          stat.iterations = (stat.iterations ?? 0) + times;
          if (body.length) {
            for (let i = 0; i < times; i++) {
              runSteps(body, { ...scope, vars: { ...scope.vars, [varName]: { index: i + 1, index0: i, count: times } } });
            }
          }
          break;
        }
        case 'branch': {
          const yes = evaluateCondition(c, scope, rng);
          stat.true ??= 0;
          stat.false ??= 0;
          stat[yes ? 'true' : 'false']++;
          runSteps(step.slots?.[yes ? 'true' : 'false'], scope);
          break;
        }
        default:
          fail(step, `Loại bước "${step.type}" không chạy được.`);
      }
      stat.records += records.length - before;
    }
  }

  runSteps(workflow.steps, rootScope);

  const bySobject = {};
  for (const r of records) bySobject[r.sobject] = (bySobject[r.sobject] ?? 0) + 1;

  return {
    seed,
    records,
    warnings,
    stats: { total: records.length, bySobject, byStep, durationMs: Date.now() - started },
  };
}
