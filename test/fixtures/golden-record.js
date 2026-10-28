// Prints the SHA-256 of the records (and byStep) of every golden case, as JSON. Run with the
// executor whose output is the reference: node test/fixtures/golden-record.js > test/fixtures/golden-hashes.json

import { createHash } from 'node:crypto';
import { runWorkflow } from '../../server/workflow/executor.js';
import { prefetchQueries } from '../../server/sf/query.js';
import { GOLDEN_CASES, GOLDEN_SEEDS, GOLDEN_NOW } from './golden-cases.js';

export async function goldenInputs(c) {
  if (c.queryResults) return c.queryResults;
  if (!c.prefetch) return undefined;
  return (await prefetchQueries({ client: null, org: null, workflow: c.workflow })).results;
}

export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const goldenKey = (c, seed) => `${c.name} @${seed}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {};
  for (const c of GOLDEN_CASES) {
    for (const seed of GOLDEN_SEEDS) {
      const r = runWorkflow(c.workflow, { seed, now: GOLDEN_NOW, queryResults: await goldenInputs(c) });
      out[goldenKey(c, seed)] = { records: hash(r.records), count: r.records.length, byStep: hash(r.stats.byStep) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
