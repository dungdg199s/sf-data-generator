// Copy / paste of steps (design 0012 B): the clipboard text format (client/js/clipboard.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClipboard, parseClipboard, PASTE_MAX_STEPS } from '../client/js/clipboard.js';
import { scopeCatalog } from '../server/workflow/schema.js';
import { SAMPLES } from '../client/js/samples.js';

const META = scopeCatalog();
const steps = structuredClone(SAMPLES[0].workflow.steps);

test('round trip: copied steps come back as they were, readable JSON marked as ours', () => {
  const text = toClipboard(steps, 'Account + Contact');
  assert.match(text, /\n {2}"sfdg": "steps"/, 'pretty-printed');
  assert.deepEqual(JSON.parse(text).version, 2);
  assert.deepEqual(parseClipboard(text, META), { steps, from: 'Account + Contact' });
});

test('a whole v2 workflow file is accepted; a v1 file is refused with how to open it', () => {
  const file = JSON.stringify(SAMPLES[1].workflow);
  assert.deepEqual(parseClipboard(file, META), { steps: SAMPLES[1].workflow.steps, from: SAMPLES[1].workflow.name });
  const v1 = parseClipboard(JSON.stringify({ version: 1, nodes: [], edges: [] }), META);
  assert.equal(v1.kind, 'v1');
  assert.match(v1.error, /version 1\. Mở bằng Thư viện → Mở file JSON…/);
});

test('not ours: plain text, broken JSON, JSON without steps, an empty step list', () => {
  for (const text of ['hello', '{"version": 2, "steps": [', '{"a": 1}', '[1, 2]', JSON.stringify({ sfdg: 'steps', version: 2, steps: [] }), '', null]) {
    const res = parseClipboard(text, META);
    assert.equal(res.kind, 'notSteps', String(text));
    assert.match(res.error, /không chứa bước nào của SF Data Generator\. Chọn bước rồi bấm Ctrl\+C/);
  }
});

test('refused: an unknown step type (also nested), a malformed step, more than 2 000 steps', () => {
  const nested = [{ id: 'l', type: 'loop', config: {}, slots: { body: [{ id: 'x', type: 'foo', config: {} }] } }];
  assert.deepEqual(parseClipboard(toClipboard(nested, 'w'), META), { kind: 'unknownType', error: 'Không dán được: bước loại "foo" không có trong phiên bản này.' });
  const bad = parseClipboard(toClipboard([{ id: 'l', type: 'loop', config: {}, slots: { body: 5 } }], 'w'), META);
  assert.equal(bad.kind, 'malformed');
  assert.match(bad.error, /^Không dán được: "slots.body" của bước "l" không phải danh sách\.$/);
  const many = Array.from({ length: PASTE_MAX_STEPS + 1 }, (_, i) => ({ id: `r${i}`, type: 'record', config: {} }));
  const big = parseClipboard(toClipboard(many, 'w'), META);
  assert.equal(big.kind, 'tooLarge');
  assert.equal(big.error, 'Nội dung dán quá lớn (2.001 bước). Dán tối đa 2.000 bước mỗi lần.');
  assert.equal(parseClipboard(JSON.stringify({ version: 2, steps: [], pad: 'a'.repeat(5 * 1024 * 1024) }), META).kind, 'tooLarge');
});
