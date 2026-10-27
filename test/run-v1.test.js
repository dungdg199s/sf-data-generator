// Step 0 of design 0003: the frozen v1 runner must match the executor on the v1 samples.
// Written before the executor moved to the tree model; it keeps passing afterwards because
// the server migrates v1 input to v2 before running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../server/workflow/executor.js';
import { runV1 } from './fixtures/run-v1.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';
import { STRUCTURED } from './fixtures/v1-cases.js';
import { NOW } from './helpers.js';

for (const s of V1_SAMPLES) {
  test(`run-v1 matches runWorkflow on sample "${s.label}"`, () => {
    for (const seed of [1, 7, 'abc']) {
      const expected = runV1(s.workflow, { seed, now: NOW });
      const { records } = runWorkflow(s.workflow, { seed, now: NOW });
      assert.equal(JSON.stringify(records), JSON.stringify(expected));
    }
  });
}

for (const [name, w] of Object.entries(STRUCTURED)) {
  test(`run-v1 matches runWorkflow on structured graph "${name}"`, () => {
    const expected = runV1(w, { seed: 7, now: NOW });
    assert.ok(expected.length > 0);
    assert.equal(JSON.stringify(runWorkflow(w, { seed: 7, now: NOW }).records), JSON.stringify(expected));
  });
}
