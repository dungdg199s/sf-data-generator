// Pure sizing rules of design 0014 (no DOM, so node:test loads it): the "còn mục" side of a
// sideways-scrolling row (§4), the results panel height (§2) and the two notches of the bottom
// sheet (§3). The callers (dom.js, results.js, inspector.js) measure and apply.

// ---------- rows that scroll sideways (§4) ----------

/**
 * Which edge of a row still hides items: 'start', 'end', 'both' or null (nothing hidden).
 * `left` may be negative in a right-to-left row; only its size matters.
 */
export function overflowSide({ left, scrollWidth, clientWidth }, threshold = 1) {
  const max = scrollWidth - clientWidth;
  if (!(max > threshold)) return null;
  const x = Math.abs(left);
  const start = x > threshold;
  const end = x < max - threshold;
  if (start && end) return 'both';
  return start ? 'start' : end ? 'end' : null;
}

const LINE_PX = 16; // WheelEvent.deltaMode 1 (lines, Firefox)

/**
 * A mostly vertical wheel turn over a row that overflows sideways scrolls the row instead.
 * → the new scrollLeft, or null when the row should leave the event alone (not overflowing, a
 * sideways gesture, or already at that end: the page gets the wheel back).
 */
export function wheelScroll({ deltaX = 0, deltaY = 0, deltaMode = 0, left, scrollWidth, clientWidth }) {
  const max = scrollWidth - clientWidth;
  if (!(max > 1) || Math.abs(deltaY) <= Math.abs(deltaX)) return null;
  const dy = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * clientWidth : deltaY;
  const next = Math.min(max, Math.max(0, left + dy));
  return Math.abs(next - left) < 0.5 ? null : next;
}

/** scrollLeft that brings [itemLeft, itemLeft + itemWidth] into view, outside a `pad` px fade at each edge. */
export function revealInline({ itemLeft, itemWidth, left, clientWidth, pad = 0 }) {
  if (itemLeft - pad < left) return Math.max(0, itemLeft - pad);
  if (itemLeft + itemWidth + pad > left + clientWidth) return itemLeft + itemWidth + pad - clientWidth;
  return left;
}

// ---------- results panel height (§2) ----------

export const RESULTS = {
  min: 160, // --results-min-h: head 48 + tab row 37 + table head + 2 rows
  layoutMin: 240, // --layout-min-h: the palette + middle column keep min(240 px, 50 %)
  defaultRatio: 0.38, // 38vh, as before design 0014
  step: 16, // ↑ / ↓
  bigStep: 64, // Shift+↑ / Shift+↓
  collapseBelow: 48, // released this far under min: collapse
  hideBelow: 24, // less room than this between min and max: no handle
};

/**
 * Height range of the open panel for `total` px under the top bar → { min, max, usable }.
 * `usable` is false when there is less than 24 px to change (landscape phone): no handle then.
 */
export function resultsRange(total) {
  const max = total - Math.min(RESULTS.layoutMin, total * 0.5);
  return { min: RESULTS.min, max, usable: max - RESULTS.min >= RESULTS.hideBelow };
}

/** `want` px kept within the range of `total` (rounded to whole px). */
export function clampResults(want, total) {
  const { min, max } = resultsRange(total);
  return Math.round(Math.min(Math.max(want, min), Math.max(min, max)));
}

/** Height for a stored ratio (0–1) of `total`; a missing or broken ratio gives the 38 % default. */
export function resultsFromRatio(ratio, total) {
  const r = Number(ratio);
  return clampResults((Number.isFinite(r) && r > 0 && r <= 1 ? r : RESULTS.defaultRatio) * total, total);
}

/** The ratio stored in localStorage['sfdg.resultsH']: 3 decimals, as a string. */
export const resultsRatio = (height, total) => (total > 0 ? (Math.round((height / total) * 1000) / 1000).toFixed(3) : String(RESULTS.defaultRatio));

/**
 * Key on the separator → { height } (new height, clamped), { toggle: true } (Enter: collapse /
 * open) or null (not a key of the handle).
 */
export function resultsKey(key, shift, height, total) {
  const { min, max } = resultsRange(total);
  const d = shift ? RESULTS.bigStep : RESULTS.step;
  switch (key) {
    case 'ArrowUp': return { height: clampResults(height + d, total) };
    case 'ArrowDown': return { height: clampResults(height - d, total) };
    case 'Home': return { height: clampResults(min, total) };
    case 'End': return { height: clampResults(max, total) };
    case 'Enter': return { toggle: true };
    default: return null;
  }
}

/** Released after dragging below min by more than 48 px: the panel collapses (the stored height stays). */
export const shouldCollapse = (dragHeight, min = RESULTS.min) => dragHeight < min - RESULTS.collapseBelow;

/** ARIA values of the separator: percent of `total`, and the text read out. */
export function resultsAria(height, total) {
  const { min, max } = resultsRange(total);
  const pct = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);
  return { now: pct(height), min: pct(min), max: pct(Math.max(min, max)), text: `Cao ${Math.round(height)} px (${pct(height)} % màn hình)` };
}

// ---------- bottom sheet notches (§3) ----------

export const SHEET = {
  dragStart: 8, // px of movement before a press on the sheet head is a drag
  flick: 0.5, // px/ms over the last 100 ms: go to the next notch
};

/**
 * Where a released sheet drag lands: 'closed', 'mid' or 'full'. `height` is the sheet height at
 * release, `velocity` px/ms of height change (positive: dragged up), `mid` / `full` the notches.
 * A flick goes to the next notch in its direction (down from mid: closed); otherwise the nearest
 * of mid and full, or closed below half of mid.
 */
export function snapSheet({ height, velocity = 0, mid, full }) {
  if (velocity > SHEET.flick) return height < mid ? 'mid' : 'full';
  if (velocity < -SHEET.flick) return height > mid ? 'mid' : 'closed';
  if (height < mid / 2) return 'closed';
  return Math.abs(height - mid) <= Math.abs(height - full) ? 'mid' : 'full';
}
