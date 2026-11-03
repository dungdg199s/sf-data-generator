// Design 0012 B: steps on the system clipboard (client/js/clipboard.js, pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClipboard, parseClipboard, CLIPBOARD_LIMITS } from '../client/js/clipboard.js';
import { NODE_TYPES } from '../server/workflow/nodes.js';

const meta = { nodeTypes: NODE_TYPES };
const steps = [{ id: 'acc', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [] } }, { id: 'l', type: 'loop', config: { count: 2 }, slots: { body: [] } }];

test('round trip: the clipboard format holds the steps and the workflow name', () => {
  const text = toClipboard(steps, 'Account + Contact');
  assert.deepEqual(JSON.parse(text), { sfdg: 'steps', version: 2, from: 'Account + Contact', steps });
  assert.deepEqual(parseClipboard(text, meta), { steps, from: 'Account + Contact' });
});

test('a whole v2 workflow file is accepted; version 1 is refused with how to open it', () => {
  assert.deepEqual(parseClipboard(JSON.stringify({ version: 2, name: 'x', steps }), meta).steps, steps);
  const v1 = parseClipboard(JSON.stringify({ version: 1, nodes: [], edges: [] }), meta);
  assert.equal(v1.error, 'v1');
  assert.match(v1.message, /Thư viện → Mở file JSON/);
});

test('not JSON, no steps, unknown step type, malformed, too many steps', () => {
  for (const text of ['hello', '{oops', '[]', '{"a":1}', JSON.stringify({ sfdg: 'steps', version: 2, steps: [] })]) assert.equal(parseClipboard(text, meta).error, 'notSteps', text);
  const foo = parseClipboard(toClipboard([{ id: 'x', type: 'foo' }], ''), meta);
  assert.deepEqual(foo, { error: 'unknownType', message: 'Không dán được: bước loại "foo" không có trong phiên bản này.' });
  const bad = parseClipboard(JSON.stringify({ sfdg: 'steps', version: 2, steps: [1] }), meta);
  assert.equal(bad.error, 'malformed');
  assert.match(bad.message, /^Không dán được: steps\[0\] không phải một bước/);
  const many = Array.from({ length: CLIPBOARD_LIMITS.maxSteps + 1 }, (_, i) => ({ id: `s${i}`, type: 'record', config: {} }));
  const big = parseClipboard(toClipboard(many, ''), meta);
  assert.equal(big.error, 'tooBig');
  assert.match(big.message, /\(hơn 2 000 bước\)\. Dán tối đa 2 000 bước mỗi lần\./);
});

test('review 0012 N5: a deeply nested paste is counted without recursion and refused past 2 000 steps', () => {
  const n = 20000; // built as text: JSON.stringify of such a tree overflows the stack itself
  const text = `{"sfdg":"steps","version":2,"steps":${'[{"id":"l","type":"loop","slots":{"body":'.repeat(n)}[]${'}}]'.repeat(n)}}`;
  const res = parseClipboard(text, meta);
  assert.equal(res.error, 'tooBig');
});
