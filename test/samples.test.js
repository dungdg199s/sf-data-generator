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

// Changed for 0006: a third sample (Query → Lặp → Chọn bản ghi → Contact) has no v1 original;
// changed for 0010: nor has the fourth (Query → Lặp mỗi bản ghi → Contact).
test('the first palette samples are exactly the migrated v1 samples (same data for the same seed)', () => {
  assert.equal(SAMPLES.length, V1_SAMPLES.length + 2);
  V1_SAMPLES.forEach((v1, i) => assert.deepEqual(SAMPLES[i].workflow, migrateV1(v1.workflow).workflow, SAMPLES[i].label));
});

test('the "Contact cho Account có sẵn" sample has no warnings and previews without an org (sample rows)', async () => {
  const { prefetchQueries } = await import('../server/sf/query.js');
  const { runWorkflow } = await import('../server/workflow/executor.js');
  const s = SAMPLES.find((x) => x.label === 'Contact cho Account có sẵn');
  assert.deepEqual(validateWorkflow(s.workflow), { errors: [], warnings: [] });
  const pre = await prefetchQueries({ client: null, org: null, workflow: s.workflow });
  const r = runWorkflow(s.workflow, { seed: 1, queryResults: pre.results });
  assert.equal(r.stats.bySobject.Contact, 10);
  assert.ok(r.records.every((x) => /^mẫu:accs#[1-5]$/.test(x.fields.AccountId) && /^Liên hệ của Account mẫu [1-5]$/.test(x.fields.Title)));
});

test('the "Contact cho mỗi Account có sẵn" sample (0010) is clean and previews 15 Contacts without an org', async () => {
  const { prefetchQueries } = await import('../server/sf/query.js');
  const { runWorkflow } = await import('../server/workflow/executor.js');
  const s = SAMPLES.find((x) => x.label === 'Contact cho mỗi Account có sẵn');
  assert.deepEqual(validateWorkflow(s.workflow), { errors: [], warnings: [] });
  const pre = await prefetchQueries({ client: null, org: null, workflow: s.workflow });
  const r = runWorkflow(s.workflow, { seed: 1, queryResults: pre.results });
  assert.equal(r.stats.bySobject.Contact, 15);
  assert.equal(r.stats.byStep.eachAcc.iterations, 5);
  // Each sample Account gets exactly 3 Contacts, in pool order.
  assert.deepEqual(r.records.map((x) => x.fields.AccountId), [1, 2, 3, 4, 5].flatMap((i) => Array(3).fill(`mẫu:accs#${i}`)));
  assert.equal(r.records[3].fields.Title, 'Liên hệ của Account mẫu 2 (Account 2/5)');
  // 0010 review N5: switched to "Số lần cố định" it runs 3 times (not "0 lần"); the hidden count
  // does not change the each-loop data (golden hash of this sample unchanged).
  const fixed = structuredClone(s.workflow);
  fixed.steps[1].config.mode = 'fixed';
  fixed.steps[1].slots.body = [];
  assert.equal(runWorkflow(fixed, { seed: 1, queryResults: pre.results }).stats.byStep.eachAcc.iterations, 3);
});
