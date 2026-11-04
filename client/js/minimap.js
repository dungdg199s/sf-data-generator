// Minimap of the Sơ đồ view (design 0014 §5). Pure: no DOM, no store, so node:test loads it.
//
// The diagram runs left to right and is very flat (40 steps ≈ 40 : 1, 1 000 steps up to 1 700 : 1),
// so squeezing all of it into a 240 px box leaves cards under a pixel. The scale never goes under
// 0.05 (a 210 × 76 card is still 10.5 × 3.8 px): a longer diagram is shown through a *window* that
// follows the viewport, plus an overview track with a thumb for the whole width.
//
// Drawing is one <path> per group (frames per type, cards per type, turned off, errors,
// selected), never one element per step: at most 6 + 6 + 3 = 15 paths whatever the step count.

export const MINIMAP = Object.freeze({
  minScale: 0.05,
  minH: 32, // --minimap-min-h
  maxH: 120, // --minimap-max-h
  thumbMin: 6, // px
  errorPad: 1.5, // px around a card for the error ring
  selPad: 2, // px of halo around a selected card (drawn by the path's stroke)
  viewInset: 1, // px kept between the viewport rectangle and the window edge (all 4 sides show)
});

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Geometry of the minimap.
 *   lay   { width, height } of the diagram (world px)
 *   view  { x, y, w, h } the part of the world in the viewport
 *   box   { w } inner width of the map (px); `minH` / `maxH` override the height range
 *   opts.windowX  keep the window at this x (world) while the map is dragged (it must not slide
 *                 under the pointer)
 * → { scale, height, window: { x, y, w, h }, viewRect: { x, y, w, h }, track: null | { left, width } }
 *   `window` and `viewRect` are in world px, `height` and `track` in minimap px.
 */
export function minimapModel(lay, view, box, opts = {}) {
  const minH = box.minH ?? MINIMAP.minH;
  const maxH = box.maxH ?? MINIMAP.maxH;
  const W = Math.max(1, lay.width);
  const H = Math.max(1, lay.height);
  const scale = Math.max(Math.min(box.w / W, maxH / H), MINIMAP.minScale);
  const height = clamp(H * scale, minH, maxH);
  const ww = box.w / scale;
  const wh = height / scale;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  // Fits: centred on the diagram. Longer / taller: follows the viewport, kept inside the diagram.
  const wx = W <= ww ? (W - ww) / 2 : clamp(opts.windowX ?? cx - ww / 2, 0, W - ww);
  const wy = H <= wh ? (H - wh) / 2 : clamp(cy - wh / 2, 0, H - wh);
  const win = { x: wx, y: wy, w: ww, h: wh };
  // The viewport rectangle, cut to the window (inset a little) so its four sides always show.
  const inset = MINIMAP.viewInset / scale;
  const lo = { x: win.x + inset, y: win.y + inset };
  const hi = { x: win.x + win.w - inset, y: win.y + win.h - inset };
  const x1 = clamp(view.x, lo.x, hi.x);
  const y1 = clamp(view.y, lo.y, hi.y);
  const x2 = clamp(view.x + view.w, lo.x, hi.x);
  const y2 = clamp(view.y + view.h, lo.y, hi.y);
  const minSide = 2 / scale; // a viewport outside the window still shows as a sliver at its edge
  const viewRect = {
    x: Math.min(x1, hi.x - minSide), y: Math.min(y1, hi.y - minSide),
    w: Math.max(x2 - x1, minSide), h: Math.max(y2 - y1, minSide),
  };
  let track = null;
  if (W > ww) {
    const width = Math.max(MINIMAP.thumbMin, (view.w / W) * box.w);
    track = { left: clamp((view.x / W) * box.w, 0, box.w - width), width: Math.min(width, box.w) };
  }
  return { scale, height, window: win, viewRect, track };
}

/** World point under minimap px (`mx`, `my`) of a window drawn `boxW` × `height` px. */
export function minimapPoint(win, boxW, height, mx, my) {
  return { x: win.x + (mx / boxW) * win.w, y: win.y + (my / height) * win.h };
}

/** World x of the centre the viewport should get for a press at `mx` px on the track. */
export const trackPoint = (layWidth, boxW, mx) => clamp(mx / boxW, 0, 1) * layWidth;

/** Viewport centre kept inside the window while the map is dragged (the window stands still). */
export function clampCenter(win, view, p) {
  const hw = Math.min(view.w, win.w) / 2;
  const hh = Math.min(view.h, win.h) / 2;
  return { x: clamp(p.x, win.x + hw, win.x + win.w - hw), y: clamp(p.y, win.y + hh, win.y + win.h - hh) };
}

const n1 = (v) => Math.round(v * 10) / 10;
const rectPath = (x, y, w, h) => `M${n1(x)} ${n1(y)}h${n1(w)}v${n1(h)}h${n1(-w)}z`;

/**
 * Path data of the minimap, grouped: [{ cls, type?, d }]. Only blocks that overlap the x range
 * [from, to] (world px; default: everything) are included, so a long diagram builds the window
 * and its neighbours only.
 *   lay      the layout of layout.js ({ start, nodes })
 *   opts.stepOf(id)  the step (disabled steps go to the "off" group)
 *   opts.errors      Set of step ids with an error (own, or inside a collapsed frame)
 *   opts.selected    Set of selected step ids (START id included when the Start card is selected)
 *   opts.scale       minimap scale (for the ring and halo widths in world px)
 *   opts.startId     id of the Start card in `selected`
 */
export function minimapPaths(lay, { errors = new Set(), selected = new Set(), scale = 1, from = -Infinity, to = Infinity, startId = '__start' } = {}) {
  const groups = new Map();
  const add = (cls, type, d) => {
    const key = type ? `${cls}:${type}` : cls;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { cls, type, parts: [] }));
    g.parts.push(d);
  };
  const inRange = (r) => r.x < to && r.x + r.w > from;
  const ring = MINIMAP.errorPad / scale;
  const card = (id, type, r, off) => {
    if (!inRange(r)) return;
    if (selected.has(id)) add('mm-sel', null, rectPath(r.x, r.y, r.w, r.h));
    else if (off) add('mm-off', null, rectPath(r.x, r.y, r.w, r.h));
    else add('mm-card', type, rectPath(r.x, r.y, r.w, r.h));
    if (errors.has(id)) add('mm-err', null, rectPath(r.x - ring, r.y - ring, r.w + 2 * ring, r.h + 2 * ring));
  };
  card(startId, 'start', lay.start, false);
  for (const n of lay.nodes) {
    if (n.kind === 'invalid') {
      if (inRange(n)) add('mm-off', null, rectPath(n.x, n.y, n.w, n.h));
      continue;
    }
    const type = n.step?.type ?? 'unknown';
    const off = Boolean(n.step?.disabled);
    if (n.kind === 'frame') {
      if (inRange(n)) add('mm-frame', type, rectPath(n.x, n.y, n.w, n.h));
      card(n.id, type, n.head, off);
    } else card(n.id, type, n, off);
  }
  // Paint order: frames, cards, turned off, selected, error rings on top.
  const rank = { 'mm-frame': 0, 'mm-card': 1, 'mm-off': 2, 'mm-sel': 3, 'mm-err': 4 };
  return [...groups.values()].sort((a, b) => rank[a.cls] - rank[b.cls]).map((g) => ({ cls: g.cls, type: g.type, d: g.parts.join('') }));
}

/**
 * Where a card (screen px `{ x, y, w, h }`) goes so no overlay covers it (the zoom bar at the top
 * right, the minimap at the bottom right; `{ left, top, right, bottom }`), keeping `M` px around
 * them, inside a `W` × `H` viewport. Candidates: x unchanged or left of an overlay, y unchanged,
 * below a top overlay or above a bottom one; the clear candidate with the smallest move wins
 * (none clear: the card stays where it is). Review 0014 N6: moving clear of the minimap must not
 * land under the zoom bar.
 */
export function clearOfOverlays(c, bars, { W, H, M = 0 }) {
  const hit = (x, y) => bars.some((b) => x < b.right && x + c.w > b.left - M && y < b.bottom + M && y + c.h > b.top - M);
  if (!hit(c.x, c.y)) return { x: c.x, y: c.y };
  const xs = [c.x, ...bars.map((b) => b.left - M - c.w)].filter((x) => x >= M || x === c.x);
  const ys = [c.y, ...bars.map((b) => (b.top > H / 2 ? b.top - M - c.h : b.bottom + M))].filter((y) => (y >= 0 && y + c.h <= H) || y === c.y);
  let best = null;
  for (const x of xs) {
    for (const y of ys) {
      if (hit(x, y) || x + c.w > W) continue;
      const d = Math.abs(x - c.x) + Math.abs(y - c.y);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : { x: c.x, y: c.y };
}
