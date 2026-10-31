// Minimap of the Sơ đồ view (design 0014 §5): client/js/minimap.js is pure, fed with real layouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, START_ID } from '../client/js/layout.js';
import { minimapModel, minimapPaths, mapToWorld, trackToWorld, pathCount, MIN_SCALE, THUMB_MIN } from '../client/js/minimap.js';
import { NODE_TYPES } from '../server/workflow/nodes.js';

const slotsOf = (type) => NODE_TYPES.find((t) => t.type === type)?.slots ?? [];
const rec = (id, extra = {}) => ({ id, type: 'record', config: { sobject: 'Account', alias: id, fields: [] }, ...extra });
const loop = (id, body) => ({ id, type: 'loop', config: { count: 2, alias: 'loop' }, slots: { body } });
const branch = (id, yes = [], no = []) => ({ id, type: 'branch', config: {}, slots: { true: yes, false: no } });

/** n steps: groups of a Lặp holding a Record and a Rẽ nhánh (with a Record on its true lane). */
function bigWorkflow(n) {
  const steps = [];
  let count = 0;
  for (let i = 0; count < n; i++) {
    steps.push(loop(`l${i}`, [rec(`a${i}`), branch(`b${i}`, [rec(`t${i}`)])]));
    count += 4;
  }
  return steps;
}
const BOX = { w: 230 };
const viewAt = (x, y = 0, w = 1200, h = 700) => ({ x, y, w, h });

test('a small diagram is seen whole: scale fits the box, centred window, no track', () => {
  const lay = layout([rec('a'), rec('b')], { slotsOf });
  const m = minimapModel(lay, viewAt(0), BOX);
  assert.ok(m.scale > MIN_SCALE);
  assert.ok(m.window.w >= lay.width - 0.5 && m.window.h >= lay.height - 0.5);
  assert.equal(m.track, null);
  assert.ok(Math.abs(m.window.x + m.window.w / 2 - lay.width / 2) < 1e-9, 'centred on the diagram');
  assert.ok(m.height >= 32 && m.height <= 120);
});

test('1 000 steps: scale 0.05, a window centred on the viewport and clamped at both ends', () => {
  const lay = layout(bigWorkflow(1000), { slotsOf });
  assert.ok(lay.width > 50000);
  const mid = minimapModel(lay, viewAt(30000), BOX);
  assert.equal(mid.scale, MIN_SCALE);
  assert.equal(mid.window.w, BOX.w / MIN_SCALE); // 4 600 px of diagram
  assert.ok(Math.abs(mid.window.x + mid.window.w / 2 - (30000 + 600)) < 1e-6, 'window centre = viewport centre');
  const first = minimapModel(lay, viewAt(0), BOX);
  assert.equal(first.window.x, 0);
  const last = minimapModel(lay, viewAt(lay.width - 1200), BOX);
  assert.equal(last.window.x, lay.width - last.window.w);
  assert.ok(mid.track && mid.track.width >= THUMB_MIN);
  assert.ok(Math.abs(mid.track.left - (30000 / lay.width) * BOX.w) < 1e-6);
});

test('the viewport rectangle is cut to the window, so all four sides show', () => {
  const lay = layout(bigWorkflow(1000), { slotsOf });
  // A viewport taller than the window (zoomed out: 4 000 world px high).
  const m = minimapModel(lay, { x: 20000, y: -1500, w: 2000, h: 4000 }, BOX);
  const { window: w, viewRect: v } = m;
  assert.ok(v);
  assert.ok(v.x >= w.x && v.y >= w.y && v.x + v.w <= w.x + w.w + 1e-9 && v.y + v.h <= w.y + w.h + 1e-9);
  // A viewport outside the window (while the window is held for a drag): nothing to draw.
  const held = minimapModel(lay, viewAt(40000), BOX, { windowX: 0 });
  assert.equal(held.window.x, 0);
  assert.equal(held.viewRect, null);
});

test('the overview thumb is at least 6 px and stays in the track', () => {
  const lay = layout(bigWorkflow(8000), { slotsOf });
  const m = minimapModel(lay, viewAt(lay.width - 100, 0, 100, 100), BOX);
  assert.equal(m.track.width, THUMB_MIN);
  assert.ok(m.track.left + m.track.width <= BOX.w + 1e-9);
});

test('path groups do not grow with the number of steps (≤ 16 at 40, 1 000 and 8 000 steps)', () => {
  for (const n of [40, 1000, 8000]) {
    const lay = layout(bigWorkflow(n), { slotsOf });
    const p = minimapPaths(lay, { selected: 'a3', errors: new Set(['b2']) });
    assert.ok(pathCount(p) + 2 <= 16, `${n} steps: ${pathCount(p)} paths + 2 view rects`); // + the view rect and its halo
    assert.deepEqual(Object.keys(p.frames), ['loop']);
    assert.deepEqual(Object.keys(p.cards).sort(), ['branch', 'loop', 'record', 'start']); // a frame's header is its card
  }
});

test('turned-off, error and selected steps go to their own groups', () => {
  const steps = [rec('a'), rec('off', { disabled: true }), rec('bad'), loop('l', [rec('in')])];
  const lay = layout(steps, { slotsOf });
  const p = minimapPaths(lay, { selected: 'a', errors: new Set(['bad', 'l']), grow: 30 });
  const count = (d) => (d.match(/M/g) ?? []).length;
  assert.equal(count(p.sel), 1);
  assert.equal(count(p.off), 1);
  assert.equal(count(p.err), 2); // the card and the frame header of l
  assert.equal(count(p.cards.record), 2); // bad and in (a is selected, off is off)
  assert.equal(count(p.cards.start), 1);
  assert.equal(count(p.frames.loop), 1);
  assert.equal(count(p.cards.loop), 1); // the Lặp's header bar is its card
});

test('selecting the Start card puts it in the selected group; a range keeps only nearby blocks', () => {
  const lay = layout(bigWorkflow(1000), { slotsOf });
  const p = minimapPaths(lay, { selected: START_ID });
  assert.equal(p.cards.start, undefined);
  assert.equal((p.sel.match(/M/g) ?? []).length, 1);
  const near = minimapPaths(lay, { range: { x0: 10000, x1: 15000 } });
  const all = minimapPaths(lay, {});
  assert.ok(near.cards.record.length < all.cards.record.length / 5);
});

test('map and track points map back to the world', () => {
  const lay = layout(bigWorkflow(1000), { slotsOf });
  const m = minimapModel(lay, viewAt(30000), BOX);
  const p = mapToWorld(m, BOX.w / 2, m.height / 2, BOX.w);
  assert.ok(Math.abs(p.x - (m.window.x + m.window.w / 2)) < 1e-6);
  assert.ok(Math.abs(p.y - (m.window.y + m.window.h / 2)) < 1e-6);
  assert.equal(trackToWorld(BOX.w * 0.75, BOX.w, lay.width), lay.width * 0.75);
  assert.equal(trackToWorld(-10, BOX.w, lay.width), 0);
});
