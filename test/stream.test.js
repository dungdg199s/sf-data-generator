// Design 0004: the executor streams records from a synchronous generator. These tests pin the
// data to the collect-everything executor it replaced (golden hashes recorded before the change)
// and check the streaming contract: order, determinism, early stop, count-only pools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWorkflow } from '../server/workflow/executor.js';
import { GOLDEN_CASES, GOLDEN_SEEDS, GOLDEN_NOW } from './fixtures/golden-cases.js';
import { goldenInputs, hash, goldenKey } from './fixtures/golden-record.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/golden-hashes.json', import.meta.url), 'utf8'));

test('golden: samples and nested cases give the same records as before streaming', async () => {
  assert.equal(Object.keys(GOLDEN).length, GOLDEN_CASES.length * GOLDEN_SEEDS.length);
  for (const c of GOLDEN_CASES) {
    for (const seed of GOLDEN_SEEDS) {
      const key = goldenKey(c, seed);
      const r = runWorkflow(c.workflow, { seed, now: GOLDEN_NOW, queryResults: await goldenInputs(c) });
      assert.equal(r.records.length, GOLDEN[key].count, key);
      assert.equal(hash(r.records), GOLDEN[key].records, key);
      assert.equal(hash(r.stats.byStep), GOLDEN[key].byStep, key);
    }
  }
});
