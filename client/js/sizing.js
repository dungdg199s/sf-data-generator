// Sizes the user drags (design 0014 §2, §3): the results panel height and the bottom sheet's two
// snaps. Pure (no DOM), so node:test loads it; results.js and inspector.js measure and apply.

/** Defaults, in px (the CSS tokens of the same name: --results-min-h, --layout-min-h). */
export const RESULTS_MIN = 160;
export const LAYOUT_MIN = 240;
/** Below this range (max − min) the handle is hidden: nothing useful to drag (a landscape phone). */
export const MIN_RANGE = 24;
/** Dragged this far under the minimum and released: the panel collapses (its saved height is kept). */
export const COLLAPSE_PAST = 48;
/** Default height: 38 % of the window, as before design 0014. */
export const DEFAULT_RATIO = 0.38;

/**
 * Limits of the results panel and the height to use.
 * total: height below the top bar (main + results); want: the height asked for (px).
 * → { height, min, max, resizable }. The main area (palette + middle column) keeps at least
 * min(layoutMin, total / 2); when max − min < MIN_RANGE the panel is not resizable and `height`
 * is `want` unchanged (the CSS default applies).
 */
export function clampResults({ want, total, min = RESULTS_MIN, layoutMin = LAYOUT_MIN }) {
  const max = Math.floor(total - Math.min(layoutMin, total / 2));
  const resizable = max - min >= MIN_RANGE;
  if (!resizable) return { height: want, min, max, resizable };
  const height = Math.round(Math.min(max, Math.max(min, want)));
  return { height, min, max, resizable };
}

/**
 * What a key does on the panel's handle (role=separator): `{ delta }` in px (↑ taller), `{ to: 'min' |
 * 'max' }` (Home / End), `{ toggle: true }` (Enter collapses / reopens), or null (not ours).
 */
export function resultsKeyStep(key, shift = false) {
  const step = shift ? 64 : 16;
  switch (key) {
    case 'ArrowUp': return { delta: step };
    case 'ArrowDown': return { delta: -step };
    case 'Home': return { to: 'min' };
    case 'End': return { to: 'max' };
    case 'Enter': return { toggle: true };
    default: return null;
  }
}

/** A drag released at height `drag` (unclamped) collapses the panel when it went 48 px under the minimum. */
export function shouldCollapse(drag, min = RESULTS_MIN) {
  return drag < min - COLLAPSE_PAST;
}

/** The saved ratio (0–1, `sfdg.resultsH`) → a number, or null when missing or invalid. */
export function parseRatio(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

/** Height (px) as a ratio of `total`, 3 decimals, for `sfdg.resultsH`. */
export const toRatio = (height, total) => (total > 0 ? Math.round((height / total) * 1000) / 1000 : DEFAULT_RATIO);

/** ARIA values of the handle: percentages of `total`, rounded, and the spoken text. */
export function resultsAria({ height, min, max, total }) {
  const pct = (v) => Math.round((v / total) * 100);
  return { min: pct(min), max: pct(max), now: pct(height), text: `Cao ${Math.round(height)} px (${pct(height)} % màn hình)` };
}

/** A drag on the sheet's head becomes a drag past this many px (under it: a tap). */
export const SHEET_DRAG_START = 8;
/** px/ms over the last 100 ms of a drag above which the release is a flick (next snap that way). */
export const FLICK_SPEED = 0.5;

/**
 * Where the bottom sheet goes when a drag of its head is released (design 0014 §3).
 * height: its height at release (px); velocity: px/ms, > 0 growing (finger going up); mid / full:
 * the two snaps (px). A flick goes to the next snap that way from `height` (below the middle snap
 * that is closing); a slow release goes to the nearest of { closed (only under half the middle snap),
 * mid, full }. → 'closed' | 'mid' | 'full'.
 */
export function snapSheet({ height, velocity = 0, mid, full }) {
  if (velocity > FLICK_SPEED) return height < mid ? 'mid' : 'full';
  if (velocity < -FLICK_SPEED) return height > mid ? 'mid' : 'closed';
  if (height < mid / 2) return 'closed';
  return Math.abs(height - mid) <= Math.abs(full - height) ? 'mid' : 'full';
}

/** The sheet's two snaps in px, as the CSS computes them (--sheet-h, --sheet-h-full). */
export function sheetSnaps({ viewport, topbar }) {
  return { mid: Math.min(0.6 * viewport, viewport - 200), full: Math.min(0.9 * viewport, viewport - topbar) };
}

/** Velocity (px/ms, > 0 upward) over the last `ms` of pointer samples [{ t, y }]. */
export function dragVelocity(samples, ms = 100) {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.t - s.t <= ms) ?? samples[0];
  const dt = Math.max(1, last.t - first.t);
  return (first.y - last.y) / dt;
}
