import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES } from '../client/js/samples.js';
import { V1_SAMPLES } from './fixtures/v1-samples.js';
import { migrateV1 } from '../shared/migrate-v1.js';
import { validateWorkflow } from '../server/workflow/schema.js';

test('palette samples are valid v2 workflows', () => {
  for (const s of SAMPLES) {
    assert.equal(s.workflow.version, 2);
    assert.deepEqual(validateWorkflow(s.workflow).errors, [], s.label);
  }
});

test('palette samples are exactly the migrated v1 samples (same data for the same seed)', () => {
  assert.equal(SAMPLES.length, V1_SAMPLES.length);
  SAMPLES.forEach((s, i) => assert.deepEqual(s.workflow, migrateV1(V1_SAMPLES[i].workflow).workflow, s.label));
});
