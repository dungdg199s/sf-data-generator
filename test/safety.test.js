// Safety locks of design 0011, checked on the sources: only server/sf/client.js calls jsforce's
// write APIs (create, destroy, bulk2), and only the inserter and the delete module call the
// client's write functions. A new caller has to change this test on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir) {
  const out = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (name.endsWith('.js')) out.push(rel.split(path.sep).join('/'));
  }
  return out;
}
const FILES = [...sources('server'), ...sources('shared'), ...sources('client/js')];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const using = (re) => FILES.filter((f) => re.test(strip(readFileSync(path.join(ROOT, f), 'utf8'))));

test('only server/sf/client.js touches jsforce write APIs (.bulk2, .destroy(, .sobject(…).create()', () => {
  assert.deepEqual(using(/\.bulk2\b/), ['server/sf/client.js']);
  assert.deepEqual(using(/\.sobject\([^)]*\)\s*\.\s*(create|destroy|del|delete|insert|update|upsert)\(/), ['server/sf/client.js']);
  assert.deepEqual(using(/\bconn\.(destroy|del|delete|create|insert|update|upsert)\(/), []);
  assert.deepEqual(using(/hardDelete/i).filter((f) => f !== 'server/sf/client.js'), [], 'hardDelete is only named where it is refused');
});

/**
 * Review S6: a write call through any receiver named like a client (`client`, `sfClient`,
 * `this.client`, `opts.sfClient`…), and any `.bulkJob(` call whatever the receiver.
 */
const WRITE_CALL = /(?:\b\w*[cC]lient\s*\??\.\s*(?:create|destroy|bulkJob)\s*\()|(?:\.\s*bulkJob\s*\()/;

test('the write-call pattern catches every receiver spelling', () => {
  for (const src of ['client.create(t, s, r)', 'sfClient.destroy(t, s, ids)', 'this.sfClient.bulkJob(t, o)', 'opts.client?.create(x)', 'foo.bulkJob(t, o)', 'myClient . destroy (a)']) {
    assert.ok(WRITE_CALL.test(src), src);
  }
  for (const src of ['client.query(t, q)', 'function bulkJob(target) {', 'sfClient.limits(t)']) assert.ok(!WRITE_CALL.test(src), src);
});

test('only the inserter and the delete module call create / destroy / bulkJob on a client', () => {
  const callers = using(WRITE_CALL);
  assert.deepEqual(callers.sort(), ['server/sf/delete.js', 'server/sf/insert.js']);
});

test('client.js allows Bulk insert and delete only', async () => {
  const { BULK_OPERATIONS } = await import('../server/sf/client.js');
  assert.deepEqual([...BULK_OPERATIONS], ['insert', 'delete']);
  assert.ok(Object.isFrozen(BULK_OPERATIONS));
});
