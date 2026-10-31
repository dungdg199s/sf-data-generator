// Minimap of the Sơ đồ view (design 0014 §5). Pure: no DOM, no store, so node:test loads it;
// canvas.js measures, draws and handles the pointer.
//
// The diagram runs left to right and is very flat (40 steps ≈ 40:1, 1 000 steps up to 1 700:1), so
// "the whole diagram in a box" would be a sub-pixel line. The scale never goes under MIN_SCALE:
// a small diagram is seen whole (centred); a long one is seen through a *window* that follows the
// viewport, plus an overview track under it (where the viewport is in the whole width).
// Drawing is one path per group (frames and cards per step type, turned off, errors, selected), so
// the SVG has a fixed number of elements whatever the number of steps.

export const MIN_SCALE = 0.05; // a 210 × 76 card is still 10.5 × 3.8 px
export const MINIMAP_MIN_H = 32;
export const MINIMAP_MAX_H = 120;
export const THUMB_MIN = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * lay: { width, height } of layout(); view: the world rectangle the viewport shows { x, y, w, h };
 * box: { w } inner width of the map (px), optional { maxH, minH }; windowX / windowY: keep the window
 * at this world position (while dragging on the map, it must not slide under the pointer).
 * → {
 *   scale, height (px of the map),
 *   window: { x, y, w, h } (world, = the SVG viewBox),
 *   viewRect: { x, y, w, h } | null (the viewport cut to the window, so all four sides show),
 *   track: { left, width } | null (px in the box: the viewport on the whole width; null when the whole width fits),
 * }
 */
export function minimapModel(lay, view, box, { windowX, windowY } = {}) {
  const maxH = box.maxH ?? MINIMAP_MAX_H;
  const minH = box.minH ?? MINIMAP_MIN_H;
  const W = Math.max(1, lay.width);
  const H = Math.max(1, lay.height);
  const scale = Math.max(Math.min(box.w / W, maxH / H), MIN_SCALE);
  const height = clamp(H * scale, minH, maxH);
  const ww = box.w / scale;
  const wh = height / scale;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  // Fits: centred on the diagram. Longer: centred on the viewport, kept inside the diagram.
  const fitsW = ww >= W - 0.5; // 0.5: float noise of box.w / (box.w / W)
  const fitsH = wh >= H - 0.5;
  const wx = fitsW ? (W - ww) / 2 : clamp(windowX ?? cx - ww / 2, 0, W - ww);
  const wy = fitsH ? (H - wh) / 2 : clamp(windowY ?? cy - wh / 2, 0, H - wh);
  const win = { x: wx, y: wy, w: ww, h: wh };
  const x0 = Math.max(view.x, win.x);
  const y0 = Math.max(view.y, win.y);
  const x1 = Math.min(view.x + view.w, win.x + win.w);
  const y1 = Math.min(view.y + view.h, win.y + win.h);
  const viewRect = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  let track = null;
  if (!fitsW) {
    const width = Math.min(box.w, Math.max(THUMB_MIN, (view.w / W) * box.w));
    const left = clamp((view.x / W) * box.w, 0, box.w - width);
    track = { left, width };
  }
  return { scale, height, window: win, viewRect, track };
}

/** World point under a map point (px in the map of `model`, box width `boxW`). */
export function mapToWorld(model, px, py, boxW) {
  const k = model.window.w / boxW;
  return { x: model.window.x + px * k, y: model.window.y + py * k };
}

/** World x of a point of the overview track (px of a `boxW` wide track) on a diagram `width` wide. */
export const trackToWorld = (px, boxW, width) => clamp(px / boxW, 0, 1) * width;

const rectPath = (r, grow = 0) => {
  const x = Math.round((r.x - grow) * 10) / 10;
  const y = Math.round((r.y - grow) * 10) / 10;
  const w = Math.round((r.w + 2 * grow) * 10) / 10;
  const hh = Math.round((r.h + 2 * grow) * 10) / 10;
  return `M${x} ${y}h${w}v${hh}h${-w}z`;
};

/**
 * Path data per group, world units. opts: errors (Set of step ids with an error), selected (step id
 * or START_ID), startId, knownType(type) (false: drawn grey like a turned-off step), range: { x0, x1 } (only blocks crossing it, so a long diagram builds only
 * what is near the window), grow: world units an error ring sticks out of its card.
 * → { frames: { type: d }, cards: { type: d }, off, err, sel } (empty strings / missing keys: nothing).
 */
export function minimapPaths(lay, { errors = new Set(), selected = null, startId = '__start', range = null, grow = 0, knownType = () => true } = {}) {
  const frames = {};
  const cards = {};
  let off = '';
  let err = '';
  let sel = '';
  const inRange = (r) => !range || (r.x < range.x1 && r.x + r.w > range.x0);
  const add = (map, type, d) => { map[type] = (map[type] ?? '') + d; };
  const card = (id, type, r, disabled) => {
    if (!inRange(r)) return;
    const d = rectPath(r);
    if (id === selected) sel += d;
    else if (disabled) off += d;
    else add(cards, type, d);
    if (id !== null && errors.has(id)) err += rectPath(r, grow);
  };
  if (lay.start) card(startId, 'start', lay.start, false);
  for (const n of lay.nodes ?? []) {
    if (n.kind === 'invalid') {
      if (inRange(n)) off += rectPath(n);
      continue;
    }
    const type = n.step?.type;
    // A missing or unknown type (older file, newer server) has no colour of its own: grey, like a turned-off step.
    const off = Boolean(n.step?.disabled) || !type || !knownType(type);
    if (n.kind === 'frame') {
      if (inRange(n)) add(frames, off ? 'unknown' : type, rectPath(n));
      card(n.id, type, n.head, off);
    } else card(n.id, type, n, off);
  }
  return { frames, cards, off, err, sel };
}

/** Number of <path> elements the groups need (frames + cards per type, plus off / err / sel). */
export const pathCount = (p) => Object.keys(p.frames).length + Object.keys(p.cards).length + 3;
