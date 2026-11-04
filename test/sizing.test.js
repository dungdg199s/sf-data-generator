// Pure sizing rules of design 0014: sideways rows (§4), results panel height (§2), sheet notches (§3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overflowSide, wheelScroll, revealInline, RESULTS, resultsRange, clampResults, resultsFromRatio, resultsRatio,
  resultsKey, shouldCollapse, resultsAria, snapSheet,
} from '../client/js/sizing.js';

test('overflowSide: which edge still hides items (1 px threshold)', () => {
  assert.equal(overflowSide({ left: 0, scrollWidth: 390, clientWidth: 390 }), null);
  assert.equal(overflowSide({ left: 0, scrollWidth: 391, clientWidth: 390 }), null); // within the threshold
  assert.equal(overflowSide({ left: 0, scrollWidth: 628, clientWidth: 390 }), 'end');
  assert.equal(overflowSide({ left: 100, scrollWidth: 628, clientWidth: 390 }), 'both');
  assert.equal(overflowSide({ left: 238, scrollWidth: 628, clientWidth: 390 }), 'start');
  assert.equal(overflowSide({ left: 237.5, scrollWidth: 628, clientWidth: 390 }), 'start'); // sub-pixel end
  assert.equal(overflowSide({ left: -100, scrollWidth: 628, clientWidth: 390 }), 'both'); // right-to-left
});

test('wheelScroll: vertical turns scroll an overflowing row; the page gets the wheel back at the ends', () => {
  const row = { left: 0, scrollWidth: 628, clientWidth: 390 };
  assert.equal(wheelScroll({ ...row, deltaY: 100 }), 100);
  assert.equal(wheelScroll({ ...row, deltaY: 3, deltaMode: 1 }), 48); // lines
  assert.equal(wheelScroll({ ...row, deltaY: 1000 }), 238); // clamped to the end
  assert.equal(wheelScroll({ ...row, deltaY: -100 }), null); // already at the start
  assert.equal(wheelScroll({ ...row, left: 238, deltaY: 100 }), null); // already at the end
  assert.equal(wheelScroll({ ...row, deltaX: 80, deltaY: 20 }), null); // sideways gesture: native
  assert.equal(wheelScroll({ left: 0, scrollWidth: 390, clientWidth: 390, deltaY: 100 }), null); // no overflow
});

test('revealInline: the item ends up outside the faded edges', () => {
  const base = { clientWidth: 300, pad: 24 };
  assert.equal(revealInline({ ...base, itemLeft: 100, itemWidth: 80, left: 0 }), 0); // already clear
  assert.equal(revealInline({ ...base, itemLeft: 280, itemWidth: 80, left: 0 }), 84); // 280 + 80 + 24 − 300
  assert.equal(revealInline({ ...base, itemLeft: 50, itemWidth: 80, left: 60 }), 26); // 50 − 24
  assert.equal(revealInline({ ...base, itemLeft: 10, itemWidth: 80, left: 60 }), 0);
});

test('results panel: min 160, main keeps min(240 px, 50 %), the handle hides with < 24 px of room', () => {
  // 1440 × 900 (top bar 49): 851 px under it.
  assert.deepEqual(resultsRange(851), { min: 160, max: 611, usable: true });
  // 390 × 844 (top bar 89): 755 px.
  assert.deepEqual(resultsRange(755), { min: 160, max: 515, usable: true });
  // 844 × 390 (landscape phone): 301 px, max 150.5 < min: no handle, the panel keeps its height.
  assert.equal(resultsRange(301).usable, false);
  // 50 % wins under 480 px: 400 → main keeps 200.
  assert.equal(resultsRange(400).max, 200);
  assert.equal(resultsRange(600).max, 360);
  // Under 480 px the 50 % applies: room = total / 2 − 160, so 24 px of room needs 368 px.
  assert.equal(resultsRange(367).usable, false);
  assert.equal(resultsRange(368).usable, true);
  assert.equal(clampResults(100, 851), 160);
  assert.equal(clampResults(9999, 851), 611);
  assert.equal(clampResults(312.4, 851), 312);
  assert.equal(clampResults(9999, 301), 160); // no room: min
});

test('results panel: the stored ratio follows the window, broken values give 38 %', () => {
  assert.equal(resultsRatio(312, 851), '0.367');
  assert.equal(resultsFromRatio('0.367', 851), 312);
  assert.equal(resultsFromRatio('0.367', 500), 184); // window got smaller: same share
  assert.equal(resultsFromRatio('0.95', 500), 260); // then clamped (main keeps 240 px)
  assert.equal(resultsFromRatio('0.95', 400), 200); // and 50 % on a short window
  assert.equal(resultsFromRatio(null, 851), Math.round(0.38 * 851));
  assert.equal(resultsFromRatio(null, 851, 900), 342); // nothing stored: 38vh, as before design 0014
  assert.equal(resultsFromRatio('', 301, 390), 160); // landscape phone: clamped (no handle there anyway)
  assert.equal(resultsFromRatio('abc', 851), Math.round(RESULTS.defaultRatio * 851));
  assert.equal(resultsFromRatio('-1', 851), Math.round(0.38 * 851));
});

test('results panel: keys move 16 / 64 px, Home / End go to the ends, Enter toggles', () => {
  assert.deepEqual(resultsKey('ArrowUp', false, 300, 851), { height: 316 });
  assert.deepEqual(resultsKey('ArrowUp', true, 300, 851), { height: 364 });
  assert.deepEqual(resultsKey('ArrowDown', false, 300, 851), { height: 284 });
  assert.deepEqual(resultsKey('ArrowDown', true, 200, 851), { height: 160 });
  assert.deepEqual(resultsKey('ArrowUp', true, 600, 851), { height: 611 });
  assert.deepEqual(resultsKey('Home', false, 300, 851), { height: 160 });
  assert.deepEqual(resultsKey('End', false, 300, 851), { height: 611 });
  assert.deepEqual(resultsKey('Enter', false, 300, 851), { toggle: true });
  assert.equal(resultsKey('a', false, 300, 851), null);
});

test('results panel: dragging more than 48 px under min collapses; ARIA is percent of the space', () => {
  assert.equal(shouldCollapse(112), false);
  assert.equal(shouldCollapse(111), true);
  assert.equal(shouldCollapse(0), true);
  assert.deepEqual(resultsAria(312, 851), { now: 37, min: 19, max: 72, text: 'Cao 312 px (37 % của vùng dưới thanh trên)' });
});

test('sheet: flicks go to the next notch, slow releases to the nearest, below half of mid closes', () => {
  const n = { mid: 506, full: 755 };
  assert.equal(snapSheet({ ...n, height: 560, velocity: 0.8 }), 'full');
  assert.equal(snapSheet({ ...n, height: 400, velocity: 0.8 }), 'mid');
  assert.equal(snapSheet({ ...n, height: 700, velocity: -0.8, from: 'full' }), 'mid');
  assert.equal(snapSheet({ ...n, height: 480, velocity: -0.8 }), 'closed'); // down from mid
  // Review 0014 S3: a flick down from full stops at mid, even released under mid, unless under mid / 2.
  assert.equal(snapSheet({ ...n, height: 455, velocity: -2, from: 'full' }), 'mid');
  assert.equal(snapSheet({ ...n, height: 260, velocity: -2, from: 'full' }), 'mid');
  assert.equal(snapSheet({ ...n, height: 250, velocity: -2, from: 'full' }), 'closed');
  assert.equal(snapSheet({ ...n, height: 455, velocity: -2, from: 'mid' }), 'closed');
  assert.equal(snapSheet({ ...n, height: 506, velocity: -0.6 }), 'closed');
  assert.equal(snapSheet({ ...n, height: 640, velocity: 0.2 }), 'full');
  assert.equal(snapSheet({ ...n, height: 600, velocity: 0 }), 'mid');
  assert.equal(snapSheet({ ...n, height: 300, velocity: 0 }), 'mid');
  assert.equal(snapSheet({ ...n, height: 252, velocity: 0 }), 'closed');
  assert.equal(snapSheet({ ...n, height: 253, velocity: -0.4 }), 'mid');
  // 844 × 390: 190 / 301.
  assert.equal(snapSheet({ mid: 190, full: 301, height: 250, velocity: 0 }), 'full');
  assert.equal(snapSheet({ mid: 190, full: 301, height: 90, velocity: 0 }), 'closed');
});
