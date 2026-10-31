// Sizes the user drags (design 0014 §2, §3): client/js/sizing.js is pure, so it loads in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampResults, resultsKeyStep, shouldCollapse, parseRatio, toRatio, resultsAria, RESULTS_MIN, LAYOUT_MIN, MIN_RANGE,
} from '../client/js/sizing.js';

test('clampResults at 1440 × 900 (top bar 49 px): 160 … 611 px, main keeps 240 px', () => {
  const total = 900 - 49;
  assert.deepEqual(clampResults({ want: 342, total }), { height: 342, min: 160, max: 611, resizable: true });
  assert.equal(clampResults({ want: 50, total }).height, RESULTS_MIN);
  assert.equal(clampResults({ want: 5000, total }).height, 611);
  assert.equal(total - clampResults({ want: 5000, total }).height, LAYOUT_MIN);
});

test('clampResults at 390 × 844 (top bar 89 px): 160 … 515 px', () => {
  const r = clampResults({ want: 321, total: 844 - 89 });
  assert.deepEqual(r, { height: 321, min: 160, max: 515, resizable: true });
});

test('clampResults at 844 × 390 (landscape phone): range < 24 px, not resizable, height unchanged', () => {
  const r = clampResults({ want: 148, total: 390 - 89 });
  assert.equal(r.resizable, false);
  assert.ok(r.max - r.min < MIN_RANGE);
  assert.equal(r.height, 148);
});

test('clampResults keeps min(240 px, 50 %) for the main area', () => {
  // total 400: half (200) is less than 240, so max = 200.
  assert.deepEqual(clampResults({ want: 1000, total: 400 }), { height: 200, min: 160, max: 200, resizable: true });
  // total 1000: 240 is less than half, so max = 760.
  assert.equal(clampResults({ want: 1000, total: 1000 }).max, 760);
  // Just under the range: 160 + 23 = 183 → total 366 (max 183) is not resizable, 368 (max 184) is.
  assert.equal(clampResults({ want: 170, total: 366 }).resizable, false);
  assert.equal(clampResults({ want: 170, total: 368 }).resizable, true);
});

test('resultsKeyStep: ↑/↓ 16 px, Shift 64 px, Home / End, Enter toggles, other keys are not ours', () => {
  assert.deepEqual(resultsKeyStep('ArrowUp'), { delta: 16 });
  assert.deepEqual(resultsKeyStep('ArrowDown'), { delta: -16 });
  assert.deepEqual(resultsKeyStep('ArrowUp', true), { delta: 64 });
  assert.deepEqual(resultsKeyStep('ArrowDown', true), { delta: -64 });
  assert.deepEqual(resultsKeyStep('Home'), { to: 'min' });
  assert.deepEqual(resultsKeyStep('End'), { to: 'max' });
  assert.deepEqual(resultsKeyStep('Enter'), { toggle: true });
  assert.equal(resultsKeyStep('a'), null);
  assert.equal(resultsKeyStep('ArrowLeft'), null);
});

test('shouldCollapse: only a release more than 48 px under the minimum', () => {
  assert.equal(shouldCollapse(160), false);
  assert.equal(shouldCollapse(113), false);
  assert.equal(shouldCollapse(112), false); // exactly 48 px under: not past it
  assert.equal(shouldCollapse(111), true);
  assert.equal(shouldCollapse(-20), true);
  assert.equal(shouldCollapse(160, 200), false);
  assert.equal(shouldCollapse(152, 200), false);
  assert.equal(shouldCollapse(151, 200), true);
  assert.equal(shouldCollapse(100, 200), true);
});

test('saved ratio: parse, round to 3 decimals, invalid values are ignored', () => {
  assert.equal(parseRatio('0.412'), 0.412);
  assert.equal(parseRatio(null), null);
  assert.equal(parseRatio(''), null);
  assert.equal(parseRatio('abc'), null);
  assert.equal(parseRatio('0'), null);
  assert.equal(parseRatio('1.2'), null);
  assert.equal(toRatio(350, 851), 0.411);
  // A ratio saved on a tall window, used on a short one: px from the ratio, then clamped.
  assert.equal(clampResults({ want: 0.7 * 755, total: 755 }).height, 515);
});

test('resultsAria: percentages of the height below the top bar and a spoken text', () => {
  assert.deepEqual(resultsAria({ height: 312, min: 160, max: 611, total: 851 }), { min: 19, max: 72, now: 37, text: 'Cao 312 px (37 % màn hình)' });
});
