// Safety locks of org writes (design 0011 §6, §8), checked on the source code itself:
// - only server/sf/client.js touches jsforce's create / destroy / bulk2;
// - only server/sf/insert.js and server/sf/delete.js call the client's create / destroy / bulkJob;
// - Bulk jobs are only ever 'insert' or 'delete' (never hardDelete, update, upsert);
// - no hand-written HTTP call to Salesforce anywhere in the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BULK_OPERATIONS } from '../server/sf/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dirs) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.posix.join(d, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (/\.(m?js|cjs)$/.test(e.name)) out.push({ file: rel, text: await readFile(path.join(ROOT, rel), 'utf8') });
    }
  }
  for (const d of dirs) await walk(d);
  return out;
}

/** Code without comments (block and line), so documentation may name what code must not do. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const where = (files, re) => files.filter((f) => re.test(code(f.text))).map((f) => f.file).sort();

test('jsforce write APIs (.bulk2, .destroy(, .sobject(…).create() appear only in server/sf/client.js', async () => {
  const files = await sources(['server', 'shared', 'client']);
  assert.ok(files.length > 30);
  assert.deepEqual(where(files, /\.bulk2\b/), ['server/sf/client.js']);
  // Every other `.destroy(` is a Node stream / HTTP response, or the client wrapper in delete.js.
  const destroys = files.flatMap((f) => [...code(f.text).matchAll(/([\w?.]+)\.destroy\(/g)].map((m) => `${f.file}:${m[1]}`)).sort();
  // (jsforce's own destroy is `conn.sobject(…).destroy(`, matched by the sObject chain check below.)
  assert.deepEqual(destroys.filter((d) => !/:(stream\?|res|req)$/.test(d)), ['server/sf/delete.js:client', 'server/sf/delete.js:client']);
  assert.deepEqual(where(files, /\bconn\s*\.\s*(destroy|create|insert|update|upsert|del|delete)\(/), []);
  assert.deepEqual(where(files, /\.sobject\([^)]*\)\s*\.\s*(create|insert|update|upsert|destroy|del|delete)\(/), ['server/sf/client.js']);
  assert.deepEqual(where(files, /\.(update|upsert)\(\s*target/), []);
});

test('the client write methods are called only from server/sf/insert.js and server/sf/delete.js', async () => {
  const files = await sources(['server', 'shared', 'client']);
  assert.deepEqual(where(files, /\b\w*client\s*\.\s*create\(/i), ['server/sf/insert.js']);
  assert.deepEqual(where(files, /\b\w*client\s*\.\s*destroy\(/i), ['server/sf/delete.js']);
  assert.deepEqual(where(files, /\b\w*client\s*\.\s*bulkJob\(/i), ['server/sf/delete.js', 'server/sf/insert.js']);
  // The routes reach them only through those modules.
  const index = code(files.find((f) => f.file === 'server/index.js').text);
  assert.ok(!/sfClient\.(create|destroy|bulkJob)\b/.test(index));
});

test('Bulk operations are insert and delete only; no code names hardDelete as an operation', async () => {
  assert.deepEqual(BULK_OPERATIONS, ['insert', 'delete']);
  assert.ok(Object.isFrozen(BULK_OPERATIONS));
  const files = await sources(['server', 'shared', 'client']);
  const ops = files.flatMap((f) => [...code(f.text).matchAll(/operation\s*:\s*['"`](\w+)['"`]/g)].map((m) => `${f.file}:${m[1]}`)).sort();
  assert.deepEqual(ops, ['server/sf/delete.js:delete', 'server/sf/insert.js:insert']);
  assert.deepEqual(where(files, /['"`]hardDelete['"`]/), []);
});

test('no hand-written HTTP to Salesforce: the server never calls fetch / http.request / https', async () => {
  const files = await sources(['server']);
  assert.deepEqual(where(files, /\bfetch\(|\bhttps?\.request\(|from\s+['"]node:https['"]|\bXMLHttpRequest\b/), []);
  // jsforce is imported in one place only.
  assert.deepEqual(where(files, /from\s+['"]jsforce['"]/), ['server/sf/client.js']);
});
