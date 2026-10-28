// Run driver (server/run.js, design 0004): event order, preview sink, dry pass before any write,
// insert progress, cancellation and the run registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, createRunRegistry, estimateApiCalls } from '../server/run.js';
import { createRun, runWorkflow } from '../server/workflow/executor.js';
import { wf, record, loop, NOW } from './helpers.js';

const accCon = (n, per = 4) => wf([loop('l', { count: n }, [
  record('a', 'Account', 'acc', [{ name: 'Name', type: 'text', options: { mode: 'company' } }]),
  loop('m', { count: per }, [record('c', 'Contact', 'con', [{ name: 'LastName', type: 'text', options: { mode: 'lastName' } }, { name: 'AccountId', type: 'lookup', options: { ref: 'acc' } }])]),
])]);

function fakeClient({ gate, fail } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async create(_t, sobject, recs) {
      calls.push({ sobject, recs });
      if (gate) await gate(calls.length);
      return recs.map((r) => (fail?.(r, sobject) ? { success: false, errors: [{ statusCode: 'X', message: 'nope' }] } : { success: true, id: `${sobject[0]}${++n}` }));
    },
  };
}

const drive = async (opts) => {
  const events = [];
  const end = await executeRun({ progressIntervalMs: 0, ...opts, emit: (e) => events.push(e) });
  return { events, end };
};

test('preview emits start, progress, done with the first 200 rows per sObject', async () => {
  const run = createRun(accCon(600), { seed: 5, now: NOW });
  const { events, end } = await drive({ run, start: { runId: 'r1', queries: [] } });
  assert.deepEqual(events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]), ['start', 'progress', 'done']);
  assert.deepEqual([events[0].runId, events[0].seed, events[0].now], ['r1', 5, NOW]);
  const progress = events.filter((e) => e.type === 'progress');
  assert.equal(progress.length, 3, 'one per 1 000 records');
  assert.ok(progress.every((p, i) => p.phase === 'generate' && p.generated === (i + 1) * 1000));
  assert.ok(progress[0].byStep.l);
  const r = end.result;
  assert.deepEqual(r.stats.bySobject, { Account: 600, Contact: 2400 });
  assert.deepEqual([r.stats.previewRows, r.stats.truncated], [200, true]);
  assert.equal(r.records.length, 400);
  // The kept rows are exactly the first 200 of each sObject of the full run.
  const all = runWorkflow(accCon(600), { seed: 5, now: NOW }).records;
  assert.deepEqual(r.records, [...all.filter((x) => x.sobject === 'Account').slice(0, 200), ...all.filter((x) => x.sobject === 'Contact').slice(0, 200)].sort((a, b) => all.indexOf(a) - all.indexOf(b)));
  assert.equal(r.insert, undefined);
});

test('org target: a generation error in the dry pass emits error and never calls create', async () => {
  const client = fakeClient();
  const w = wf([record('a', 'Account', 'acc', [{ name: 'NumberOfEmployees', type: 'number', options: { min: 1, max: 2, unique: true } }], { count: 3 })]);
  const { events, end } = await drive({ run: createRun(w, { seed: 1 }), target: 'dev', sfClient: client });
  assert.equal(client.calls.length, 0);
  assert.equal(end.type, 'error');
  assert.match(end.error, /^Lỗi khi sinh dữ liệu, chưa ghi bản ghi nào vào org: /);
  assert.deepEqual([end.issues[0].nodeId, end.issues[0].field], ['a', 'fields.NumberOfEmployees']);
  assert.equal(end.insert, null);
  assert.ok(!events.some((e) => e.type === 'plan'));
});

test('org target emits plan before insert progress; the insert gets the same records as the preview', async () => {
  const client = fakeClient();
  const run = createRun(accCon(500), { seed: 9, now: NOW });
  const { events, end } = await drive({ run, target: 'dev', sfClient: client });
  const types = events.map((e) => `${e.type}${e.phase ? `:${e.phase}` : ''}`);
  const planAt = types.indexOf('plan');
  assert.ok(planAt > 0 && types.slice(0, planAt).every((t) => t === 'start' || t === 'progress:generate'));
  assert.ok(types.slice(planAt + 1, -1).every((t) => t === 'progress:insert'));
  assert.equal(types.at(-1), 'done');
  assert.deepEqual(events[planAt], { type: 'plan', total: 2500, bySobject: { Account: 500, Contact: 2000 }, apiCalls: 13 });
  const ins = events.filter((e) => e.phase === 'insert');
  assert.deepEqual(ins.at(-1).bySobject, { Account: { inserted: 500, failed: 0, total: 500 }, Contact: { inserted: 2000, failed: 0, total: 2000 } });
  const sent = client.calls.flatMap((c) => c.recs);
  assert.equal(sent.length, 2500);
  const all = runWorkflow(accCon(500), { seed: 9, now: NOW }).records;
  assert.deepEqual(sent.filter((x) => x.Name).map((x) => x.Name), all.filter((x) => x.sobject === 'Account').map((x) => x.fields.Name));
  const r = end.result;
  assert.equal(r.insert.inserted, 2500);
  assert.equal(r.insert.cancelled, false);
  // NDJSON returns the Ids of the preview rows only (Lookup targets were kept while inserting).
  for (const x of r.records) assert.ok(r.insert.ids[x.ref], x.ref);
  assert.equal(Object.keys(r.insert.ids).length, r.records.length);
});

test('cancel during insert emits done with cancelled true and the exact counts', async () => {
  const controller = new AbortController();
  const client = fakeClient({ gate: async (n) => { if (n === 3) controller.abort(); } });
  const run = createRun(accCon(400, 1), { seed: 2 });
  const { end } = await drive({ run, target: 'dev', sfClient: client, signal: controller.signal });
  assert.equal(end.type, 'done');
  const ins = end.result.insert;
  assert.equal(ins.cancelled, true);
  assert.equal(client.calls.length, 3);
  assert.equal(ins.inserted, 600);
  assert.equal(ins.notSent, 200);
  assert.equal(ins.total, 800);
});

test('cancel before the insert: nothing written, cancelled preview result', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient();
  const { end } = await drive({ run: createRun(accCon(300), { seed: 2 }), target: 'dev', sfClient: client, signal: controller.signal });
  assert.equal(client.calls.length, 0);
  assert.equal(end.result.cancelled, true);
  assert.deepEqual([end.result.insert.inserted, end.result.insert.cancelled], [0, true]);
});

test('JSON (collect) mode keeps every record and every Id', async () => {
  const client = fakeClient();
  const { end } = await drive({ run: createRun(accCon(100), { seed: 2 }), target: 'dev', sfClient: client, collect: true });
  assert.equal(end.result.records.length, 500);
  assert.equal(end.result.stats.truncated, false);
  assert.equal(Object.keys(end.result.insert.ids).length, 500);
});

test('run registry: cancel by id, unknown or closed ids are refused; API call estimate', () => {
  const reg = createRunRegistry();
  const h = reg.open();
  assert.match(h.id, /^r[0-9a-f]{8}$/);
  assert.equal(reg.cancel('nope'), false);
  assert.equal(reg.cancel(h.id), true);
  assert.equal(h.signal.aborted, true);
  h.close();
  assert.equal(reg.cancel(h.id), false);
  assert.equal(estimateApiCalls({ Account: 40000, Contact: 160000, Task: 1 }), 1001);
});

// ---------- review fixes ----------

test('a Dừng that arrives while pass 1 runs synchronously is seen before plan: nothing is written', async () => {
  const controller = new AbortController();
  const client = fakeClient();
  const emit = (e) => { if (e.type === 'start') setImmediate(() => controller.abort()); };
  const end = await executeRun({ run: createRun(accCon(100), { seed: 1 }), target: 'dev', sfClient: client, signal: controller.signal, emit, progressIntervalMs: 0 });
  assert.equal(client.calls.length, 0);
  assert.equal(end.result.insert.cancelled, true);
  assert.equal(end.result.insert.inserted, 0);
});

test('generation without records still yields to the event loop and honours Dừng (time budget, not only every 1 000 records)', async () => {
  const controller = new AbortController();
  // ~1.5 M step visits before the first record.
  const w = wf([loop('l', { count: 100000 }, [loop('m', { count: 7 }, [{ id: 'b', type: 'branch', config: { kind: 'chance', probability: 0.5 }, slots: { true: [], false: [] } }])]), record('a', 'Account', 'acc')]);
  setTimeout(() => controller.abort(), 20);
  const t0 = Date.now();
  const end = await executeRun({ run: createRun(w, { seed: 1 }), signal: controller.signal, emit: () => {} });
  assert.equal(end.result.cancelled, true);
  assert.equal(end.result.stats.total, 0);
  assert.ok(Date.now() - t0 < 400, `stopped after ${Date.now() - t0} ms`);
});
