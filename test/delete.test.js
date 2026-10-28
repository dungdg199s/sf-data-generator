// server/sf/delete.js (design 0011) with a fake client: order, gone, fail fast, retry, Bulk delete.
import { TEST_DATA_DIR } from './data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createHistory } from '../server/history.js';
import { deleteRun } from '../server/sf/delete.js';

const sleepless = { sleep: async () => {} };
const steps = [{ nodeId: 'a', alias: 'acc', sobject: 'Account', mode: 'collections', records: 3 }, { nodeId: 'c', alias: 'con', sobject: 'Contact', mode: 'collections', records: 5 }];

async function recorded(ids = { a: 3, c: 5 }, extra = {}) {
  const history = createHistory({ dir: path.join(mkdtempSync(path.join(TEST_DATA_DIR, 'd-')), 'history') });
  const e = await history.create({ org: { alias: 'dev', username: 'me@x.com' }, workflow: null, seed: 1, now: 1, bulk: 'auto', steps, total: 8 });
  // Insert order: Accounts and Contacts interleaved, parents first.
  const rows = [];
  for (let i = 1; i <= Math.max(ids.a, ids.c); i++) {
    if (i <= ids.a) rows.push({ sobject: 'Account', step: 'a', ref: `acc#${i}`, id: `001A${String(i).padStart(5, '0')}` });
    if (i <= ids.c) rows.push({ sobject: 'Contact', step: 'c', ref: '', id: `003C${String(i).padStart(5, '0')}` });
  }
  await e.appendIds(rows);
  await e.finish({ status: 'done', inserted: rows.length, ...extra });
  return { history, entry: await history.open(e.id) };
}

function destroyClient(outcome = () => null) {
  const calls = [];
  return {
    calls,
    async destroy(_t, sobject, ids) {
      calls.push({ sobject, ids });
      return ids.map((id) => {
        const e = outcome(id, sobject, calls.length);
        return e ? { id, success: false, errors: [{ statusCode: e, message: `${e.toLowerCase()} message` }] } : { id, success: true, errors: [] };
      });
    },
    bulkJob() { throw new Error('no Bulk expected'); },
  };
}

test('children before parents, reverse insert order inside a step; already deleted Ids are gone, not errors', async () => {
  const { history, entry } = await recorded();
  const client = destroyClient((id) => (id === '003C00002' ? 'ENTITY_IS_DELETED' : null));
  const out = await deleteRun({ client, target: 'dev', entry, history, options: sleepless });
  assert.deepEqual(client.calls.map((c) => [c.sobject, c.ids]), [
    ['Contact', ['003C00005', '003C00004', '003C00003', '003C00002', '003C00001']],
    ['Account', ['001A00003', '001A00002', '001A00001']],
  ]);
  assert.deepEqual([out.deleted, out.gone, out.failed, out.remaining], [7, 1, 0, 0]);
  assert.deepEqual(out.bySobject.Contact, { total: 5, deleted: 4, gone: 1, failed: 0 });
});

test('no Delete permission: the first 3 calls of an sObject failing completely stop the delete', async () => {
  const { history, entry } = await recorded({ a: 3, c: 700 });
  const client = destroyClient((_id, so) => (so === 'Contact' ? 'INSUFFICIENT_ACCESS_OR_READONLY' : null));
  const out = await deleteRun({ client, target: 'dev', entry, history, options: sleepless });
  assert.equal(client.calls.length, 3, 'no Account call after the stop');
  assert.deepEqual([out.stopped.reason, out.stopped.sobject, out.stopped.batches], ['allFailing', 'Contact', 3]);
  assert.match(out.stopped.message, /^INSUFFICIENT_ACCESS_OR_READONLY/);
  assert.equal(out.deleted, 0);
  assert.equal(out.remaining, 703);
  assert.equal(out.errorGroups[0].count, 600);
});

test('DELETE_FAILED is tried once more after the other steps', async () => {
  const { history, entry } = await recorded({ a: 2, c: 2 });
  let tries = 0;
  const client = destroyClient((id) => (id === '001A00001' && tries++ === 0 ? 'DELETE_FAILED' : null));
  const out = await deleteRun({ client, target: 'dev', entry, history, options: sleepless });
  assert.deepEqual(client.calls.map((c) => c.ids), [['003C00002', '003C00001'], ['001A00002', '001A00001'], ['001A00001']]);
  assert.deepEqual([out.deleted, out.failed, out.remaining], [4, 0, 0]);
});

test('Dừng stops after the call in flight; the rest stays and can be deleted later', async () => {
  const { history, entry } = await recorded({ a: 3, c: 600 });
  const controller = new AbortController();
  const client = destroyClient((_id, _so, n) => { if (n === 2) controller.abort(); return null; });
  const out = await deleteRun({ client, target: 'dev', entry, history, signal: controller.signal, options: sleepless });
  assert.equal(client.calls.length, 2);
  assert.deepEqual([out.cancelled, out.deleted, out.remaining], [true, 400, 203]);
  const again = await deleteRun({ client: destroyClient(), target: 'dev', entry: await history.open(entry.id), history, options: sleepless });
  assert.deepEqual([again.deleted, again.remaining], [203, 0]);
});

test('Bulk delete after a probe; ids of an unread Bulk insert job are fetched first', async () => {
  const { history, entry } = await recorded({ a: 1, c: 2500 }, { bulkJobs: [{ jobId: '7504xOLD', nodeId: 'c', sobject: 'Contact', records: 2, state: 'InProgress', idsCollected: false }] });
  const jobs = [];
  const client = destroyClient();
  client.bulkJob = (_t, { object, operation, id }) => {
    const j = { object, operation, id, log: [], csv: '' };
    jobs.push(j);
    return {
      get id() { return j.id; },
      async open() { j.log.push('open'); j.id = `7504xD${jobs.length}`; },
      async upload(csv) { j.csv = csv; },
      async close() {},
      async check() { return { state: 'JobComplete', numberRecordsProcessed: 0, numberRecordsFailed: 0 }; },
      async abort() {},
      async successfulResults() {
        if (operation === 'insert') return [{ sf__Id: '003CEXTRA1', sf__Created: 'true' }, { sf__Id: '003CEXTRA2', sf__Created: 'true' }];
        return j.csv.trim().split('\n').slice(1).reverse().map((Id) => ({ sf__Id: Id, sf__Created: 'false', Id }));
      },
      async failedResults() { return []; },
    };
  };
  const out = await deleteRun({ client, target: 'dev', entry, history, limits: { bulkMinRecords: 1000, bulkJobRecords: 1000 }, options: sleepless });
  assert.equal(out.fetched, 2);
  assert.deepEqual(jobs.map((j) => [j.operation, j.id]), [['insert', '7504xOLD'], ['delete', '7504xD2'], ['delete', '7504xD3'], ['delete', '7504xD4']]);
  assert.equal(client.calls[0].ids.length, 200, 'probe through destroy');
  assert.deepEqual([out.deleted, out.failed, out.remaining], [2503, 0, 0]);
  assert.ok(jobs.every((j) => ['insert', 'delete'].includes(j.operation)));
  assert.equal((await history.read(entry.id)).bulkJobs[0].idsCollected, true);
});
