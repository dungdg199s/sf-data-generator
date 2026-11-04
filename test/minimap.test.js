// Minimap of the Sơ đồ view (design 0014 §5): client/js/minimap.js is pure; the diagrams come from
// the real auto-layout (client/js/layout.js) with the real catalogue's slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimapModel, minimapPaths, minimapPoint, trackPoint, clampCenter, MINIMAP } from '../client/js/minimap.js';
import { layout, START_ID } from '../client/js/layout.js';
import { NODE_TYPES } from '../server/workflow/nodes.js';

const slotsOf = (type) => NODE_TYPES.find((t) => t.type === type)?.slots ?? [];
const r = (id, extra = {}) => ({ id, type: 'record', config: { sobject: 'Account', alias: id, fields: [] }, ...extra });
const loop = (id, body = []) => ({ id, type: 'loop', config: { alias: 'loop' }, slots: { body } });
const branch = (id, yes = [], no = []) => ({ id, type: 'branch', config: {}, slots: { true: yes, false: no } });

/** n groups of a Lặp holding a Record and a Rẽ nhánh with one Record per lane (5 steps each), like the 0014 measurements. */
function big(groups) {
  const steps = [];
  for (let i = 0; i < groups; i++) steps.push(loop(`l${i}`, [r(`a${i}`), branch(`b${i}`, [r(`t${i}`)], [r(`f${i}`)])]));
  return layout(steps, { slotsOf });
}

const BOX = { w: 232 }; // 240 px box − 2 × 4 px padding
const viewAt = (x, y = 0, w = 1000, h = 600) => ({ x, y, w, h });

test('a small diagram is seen whole: centred, no track, the viewport rectangle inside the window', () => {
  const lay = layout([r('a'), r('b')], { slotsOf });
  const m = minimapModel(lay, viewAt(-100, -50, 3000, 1000), BOX);
  assert.ok(m.scale > MINIMAP.minScale);
  assert.equal(m.track, null);
  assert.ok(m.window.x <= 0 && m.window.x + m.window.w >= lay.width, 'the window covers the diagram');
  assert.ok(m.height >= MINIMAP.minH && m.height <= MINIMAP.maxH);
  const v = m.viewRect;
  assert.ok(v.x >= m.window.x && v.y >= m.window.y && v.x + v.w <= m.window.x + m.window.w && v.y + v.h <= m.window.y + m.window.h);
});

test('1 000 steps: scale 0.05, the window follows the viewport centre and stops at both ends', () => {
  const lay = big(200);
  assert.ok(lay.width > 100000, `wide diagram expected (${lay.width})`);
  const view = viewAt(50000, 0, 1200, 700);
  const m = minimapModel(lay, view, BOX);
  assert.equal(m.scale, MINIMAP.minScale);
  assert.equal(Math.round(m.window.w), Math.round(BOX.w / 0.05)); // 4 640 px of diagram
  assert.ok(Math.abs(m.window.x + m.window.w / 2 - (view.x + view.w / 2)) < 1e-6, 'window centred on the viewport');
  assert.equal(minimapModel(lay, viewAt(-300), BOX).window.x, 0);
  const end = minimapModel(lay, viewAt(lay.width), BOX).window;
  assert.ok(Math.abs(end.x + end.w - lay.width) < 1e-6, 'window kept inside the diagram at the end');
  // While dragging, the window stays where it was.
  assert.equal(minimapModel(lay, viewAt(60000), BOX, { windowX: m.window.x }).window.x, m.window.x);
});

test('the viewport rectangle is cut to the window so its 4 sides show; the thumb is at least 6 px', () => {
  const lay = big(200);
  // A viewport taller than the window (the diagram is flat): cut top and bottom.
  const m = minimapModel(lay, viewAt(50000, -2000, 1200, 6000), BOX);
  const v = m.viewRect;
  const w = m.window;
  assert.ok(v.y > w.y && v.y + v.h < w.y + w.h, 'top and bottom inside the window');
  assert.ok(v.x > w.x && v.x + v.w < w.x + w.w, 'left and right inside the window');
  assert.ok(m.track.width >= MINIMAP.thumbMin);
  assert.ok(m.track.left >= 0 && m.track.left + m.track.width <= BOX.w);
  // At the far end the thumb touches the end of the track.
  const end = minimapModel(lay, viewAt(lay.width - 1200, 0, 1200, 700), BOX);
  assert.ok(Math.abs(end.track.left + end.track.width - BOX.w) < 1e-6);
  // A viewport outside the window still shows as a sliver at its edge.
  const off = minimapModel(lay, viewAt(50000), BOX, { windowX: 0 });
  assert.ok(off.viewRect.w > 0 && off.viewRect.x + off.viewRect.w <= off.window.x + off.window.w);
});

test('path groups stay ≤ 16 at 40, 1 000 and 8 000 steps (one path per group, not per step)', () => {
  for (const groups of [8, 200, 1600]) {
    const lay = big(groups);
    const errors = new Set([`a${groups - 1}`, 'l0']);
    const selected = new Set(['b0', 'a1']);
    const paths = minimapPaths(lay, { errors, selected, scale: 0.05 });
    assert.ok(paths.length <= 16, `${groups * 5} steps: ${paths.length} paths`);
    assert.equal(new Set(paths.map((p) => `${p.cls}:${p.type}`)).size, paths.length, 'one path per group');
  }
});

test('turned off, erroring and selected steps go to their own groups; the range keeps the window and its neighbours', () => {
  const steps = [r('a'), r('off', { disabled: true }), loop('l', [r('in')]), r('bad')];
  const lay = layout(steps, { slotsOf });
  const paths = minimapPaths(lay, { errors: new Set(['bad', 'l']), selected: new Set(['a', START_ID]), scale: 0.1 });
  const group = (cls, type) => paths.find((p) => p.cls === cls && (type === undefined || p.type === type));
  const count = (p) => (p?.d.match(/M/g) ?? []).length;
  assert.equal(count(group('mm-sel')), 2, 'a and Start are selected');
  assert.equal(count(group('mm-off')), 1, 'the turned-off Record');
  assert.equal(count(group('mm-err')), 2, 'rings around bad and the Lặp header');
  assert.equal(count(group('mm-frame', 'loop')), 1);
  assert.equal(count(group('mm-card', 'record')), 2, 'in and bad (a is selected, off is turned off)');
  assert.equal(count(group('mm-card', 'loop')), 1, 'the Lặp header');
  assert.equal(group('mm-card', 'start'), undefined, 'Start is drawn as selected');
  // Paint order: frames under cards, rings on top.
  assert.equal(paths[0].cls, 'mm-frame');
  assert.equal(paths.at(-1).cls, 'mm-err');
  // The error ring is 1.5 minimap px wider than the card on each side: 15 world px at scale 0.1.
  const bad = lay.nodes.find((n) => n.id === 'bad');
  assert.ok(group('mm-err').d.includes(`M${bad.x - 15} ${bad.y - 15}h${bad.w + 30}v${bad.h + 30}`));
  // A range: only the blocks that overlap it.
  const ranged = minimapPaths(big(200), { from: 0, to: 3000, scale: 0.05 });
  const all = minimapPaths(big(200), { scale: 0.05 });
  const blocks = (ps) => ps.reduce((s, p) => s + count(p), 0);
  assert.ok(blocks(ranged) < blocks(all) / 20, `${blocks(ranged)} of ${blocks(all)} blocks`);
});

test('pointer helpers: minimap px → world, track → centre, a dragged centre stays in the window', () => {
  const win = { x: 1000, y: 0, w: 4640, h: 2400 };
  assert.deepEqual(minimapPoint(win, 232, 120, 116, 60), { x: 1000 + 2320, y: 1200 });
  assert.equal(trackPoint(100000, 232, 174), 75000);
  assert.equal(trackPoint(100000, 232, -5), 0);
  assert.equal(trackPoint(100000, 232, 999), 100000);
  const view = { w: 1000, h: 600 };
  assert.deepEqual(clampCenter(win, view, { x: 0, y: 0 }), { x: 1500, y: 300 });
  assert.deepEqual(clampCenter(win, view, { x: 99999, y: 99999 }), { x: 5140, y: 2100 });
});

test('clearOfOverlays: out from under the minimap without landing under the zoom bar (review 0014 N6)', async () => {
  const { clearOfOverlays } = await import('../client/js/minimap.js');
  const view = { W: 600, H: 230, M: 8 };
  const zoomBar = { left: 380, top: 8, right: 592, bottom: 40 };
  const minimap = { left: 80, top: 120, right: 592, bottom: 222 };
  // No room left of the minimap; just above it (y 36) the card would sit under the zoom bar, which is
  // what the old one-pass rule did; below the zoom bar it is under the minimap. Clear of both: left
  // of the zoom bar, above the minimap.
  const card = { x: 300, y: 140, w: 160, h: 76 };
  const p = clearOfOverlays(card, [zoomBar, minimap], view);
  const under = (b) => p.x < b.right && p.x + card.w > b.left - 8 && p.y < b.bottom + 8 && p.y + card.h > b.top - 8;
  assert.ok(!under(zoomBar) && !under(minimap), JSON.stringify(p));
  assert.deepEqual(p, { x: 380 - 8 - 160, y: 120 - 8 - 76 });
  // Already clear: unchanged. Nowhere clear: unchanged.
  assert.deepEqual(clearOfOverlays({ x: 10, y: 20, w: 160, h: 76 }, [zoomBar, minimap], view), { x: 10, y: 20 });
  assert.deepEqual(clearOfOverlays(card, [{ left: 0, top: 0, right: 600, bottom: 230 }], view), { x: 300, y: 140 });
  // Only the minimap: the smallest move wins (here up above it rather than far to the left).
  assert.deepEqual(clearOfOverlays({ x: 450, y: 150, w: 100, h: 50 }, [{ left: 400, top: 130, right: 592, bottom: 222 }], view), { x: 450, y: 72 });
});
