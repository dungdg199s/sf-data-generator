// Auto-layout of the "Sơ đồ" view (design 0003, đợt B). A pure function of the step tree: no DOM,
// no store, no imports, so test/layout.test.js runs it in Node.
//
// Shape (world coordinates, px, origin top-left):
//   - A sequence runs left to right on one horizontal "spine". Before, between and after its steps
//     there is a connector of `gap` px with a "+" in the middle (insert index 0…n).
//   - A step type with one slot (Lặp) is a frame: a header bar (the step's card) across the top and
//     its body sequence inside, entered at the left edge and left at the right edge.
//   - A step type with two or more slots (Rẽ nhánh) is a card followed by one lane per slot,
//     stacked top to bottom in declaration order (Đúng above Sai). Lane 0 continues the spine; the
//     lanes join again at a dot, and the flow leaves on the spine.
//   - A collapsed container is a plain card. An empty slot holds a "+ Thêm bước" box.
// Which types have slots comes from the catalogue (`slotsOf(type)` → [{ key, label }] from
// /api/meta), never from a list of type names here.
//
// Cost: one measuring pass (bottom-up) and one placing pass (top-down), both O(number of steps);
// long sequences are iterated, only nesting recurses.

export const DIM = Object.freeze({
  cardW: 210, // step card
  cardH: 76,
  gap: 60, // connector between two steps (the "+" sits in its middle)
  headH: 44, // header bar of a frame (its card)
  pad: 16, // inside a frame: left, right and bottom
  bodyTop: 10, // between a frame's header and its body
  frameMinW: 250,
  emptyW: 170, // "+ Thêm bước" box of an empty slot
  emptyH: 44,
  edge: 20, // connector on each side of an empty box
  laneGap: 28, // vertical space between two lanes
  splitW: 72, // from a lanes card to its lanes (lane labels sit here)
  trunk: 16, // x offset of the vertical fork / join lines
  mergeW: 40, // from the longest lane to the step after the join dot
  margin: 40, // around the whole diagram
});

export const START_ID = '__start';

const isStep = (s) => s !== null && typeof s === 'object' && !Array.isArray(s);

/**
 * @param {Array} steps  workflow.steps (v2 tree)
 * @param {object} opts
 *   slotsOf(type)  → slot definitions [{ key, label, empty?, hint? }] of a step type ([] or undefined: none)
 *   collapsed      Set of step ids drawn collapsed
 *   dims           overrides of DIM
 * @returns {{
 *   width, height, start: { x, y, w, h },
 *   nodes:   [{ kind: 'card' | 'frame' | 'invalid', id, step, x, y, w, h, head?, level, parentId, slot, index, container, collapsed, path }],
 *   slots:   [{ parentId, key, label, x, y, w, h }],   // frame body / lane areas (issue outlines)
 *   adds:    [{ parentId, slot, index, x, y, after, before }],   // "+" centres; neighbouring steps
 *   empties: [{ parentId, slot, def, root, x, y, w, h }],
 *   labels:  [{ parentId, slot, text, x, y, w }],       // lane labels, y = baseline box top
 *   edges:   [[x1, y1, x2, y2, …]],                    // connector polylines
 *   dots:    [{ x, y }],                                // lane join points
 *   order:   [{ id, parentId, level, container, collapsed }],   // visible steps in reading order, Start first
 * }}
 */
export function layout(steps, { slotsOf = () => [], collapsed = new Set(), dims = {} } = {}) {
  const D = { ...DIM, ...dims };
  const defsOf = (step) => {
    const defs = isStep(step) ? slotsOf(step.type) : null;
    return Array.isArray(defs) ? defs : [];
  };
  const listOf = (step, key) => (Array.isArray(step.slots?.[key]) ? step.slots[key] : []);

  // ---------- measure (bottom-up, memoised on the step objects) ----------
  const sizes = new Map(); // step object → { w, h, a (spine offset from top), kind, … }

  function measureSeq(list) {
    if (!list.length) return { w: D.edge * 2 + D.emptyW, above: D.emptyH / 2, below: D.emptyH / 2, empty: true };
    let w = D.gap;
    let above = 0;
    let below = 0;
    for (const s of list) {
      const m = measureItem(s);
      w += m.w + D.gap;
      above = Math.max(above, m.a);
      below = Math.max(below, m.h - m.a);
    }
    return { w, above, below };
  }

  function measureItem(step) {
    if (isStep(step) && sizes.has(step)) return sizes.get(step);
    let m;
    const defs = defsOf(step);
    if (!isStep(step)) m = { kind: 'invalid', w: D.cardW, h: D.cardH, a: D.cardH / 2 };
    else if (!defs.length || collapsed.has(step.id)) m = { kind: 'card', w: D.cardW, h: D.cardH, a: D.cardH / 2 };
    else if (defs.length === 1) {
      const body = measureSeq(listOf(step, defs[0].key));
      const top = D.headH + D.bodyTop;
      m = { kind: 'frame', body, w: Math.max(D.frameMinW, body.w + 2 * D.pad), h: top + body.above + body.below + D.pad, a: top + body.above };
    } else {
      const lanes = defs.map((d) => measureSeq(listOf(step, d.key)));
      let t = 0;
      const tops = lanes.map((l) => {
        const top = t;
        t += l.above + l.below + D.laneGap;
        return top;
      });
      const lanesBottom = t - D.laneGap;
      const spine0 = lanes[0].above;
      const shift = Math.max(0, D.cardH / 2 - spine0); // the card must not stick out above the lanes
      const lanesW = Math.max(...lanes.map((l) => l.w));
      m = {
        kind: 'lanes',
        lanes,
        tops: tops.map((x) => x + shift),
        lanesW,
        w: D.cardW + D.splitW + lanesW + D.mergeW,
        h: Math.max(lanesBottom + shift, spine0 + shift + D.cardH / 2),
        a: spine0 + shift,
      };
    }
    if (isStep(step)) sizes.set(step, m);
    return m;
  }

  // ---------- place (top-down) ----------
  const out = { nodes: [], slots: [], adds: [], empties: [], labels: [], edges: [], dots: [], order: [] };
  const line = (...pts) => out.edges.push(pts);

  function placeSeq(list, m, x, spine, ctx) {
    const { parentId, slot, level, path } = ctx;
    if (m.empty) {
      line(x, spine, x + D.edge, spine);
      out.empties.push({ parentId, slot, def: ctx.def ?? null, root: parentId === null, x: x + D.edge, y: spine - D.emptyH / 2, w: D.emptyW, h: D.emptyH });
      line(x + D.edge + D.emptyW, spine, x + m.w, spine);
      return;
    }
    let cx = x;
    list.forEach((step, index) => {
      line(cx, spine, cx + D.gap, spine);
      out.adds.push({ parentId, slot, index, x: cx + D.gap / 2, y: spine, after: list[index - 1], before: step });
      cx += D.gap;
      const im = measureItem(step);
      placeItem(step, im, cx, spine - im.a, { parentId, slot, index, level, path: `${path}.${index}` });
      cx += im.w;
    });
    line(cx, spine, cx + D.gap, spine);
    out.adds.push({ parentId, slot, index: list.length, x: cx + D.gap / 2, y: spine, after: list[list.length - 1], before: undefined });
  }

  function placeItem(step, m, x, y, at) {
    const base = { step, x, y, w: m.w, h: m.h, level: at.level, parentId: at.parentId, slot: at.slot, index: at.index, path: at.path };
    if (m.kind === 'invalid') {
      out.nodes.push({ ...base, kind: 'invalid', id: null, container: false, collapsed: false });
      return;
    }
    const defs = defsOf(step);
    const container = defs.length > 0;
    const isCollapsed = container && collapsed.has(step.id);
    out.order.push({ id: step.id, parentId: at.parentId, level: at.level, container, collapsed: isCollapsed });
    const inner = { level: at.level + 1, path: at.path };
    if (m.kind === 'card') {
      out.nodes.push({ ...base, kind: 'card', id: step.id, container, collapsed: isCollapsed });
      return;
    }
    if (m.kind === 'frame') {
      out.nodes.push({ ...base, kind: 'frame', id: step.id, container, collapsed: false, head: { x, y, w: m.w, h: D.headH } });
      const def = defs[0];
      const spine = y + m.a;
      const bx = x + D.pad;
      const top = y + D.headH + D.bodyTop;
      out.slots.push({ parentId: step.id, key: def.key, label: def.label ?? '', x: bx - D.pad / 2, y: top - D.bodyTop / 2, w: m.body.w + D.pad, h: m.body.above + m.body.below + D.bodyTop / 2 + D.pad / 2 });
      line(x, spine, bx, spine);
      placeSeq(listOf(step, def.key), m.body, bx, spine, { parentId: step.id, slot: def.key, def, ...inner });
      line(bx + m.body.w, spine, x + m.w, spine);
      return;
    }
    // Lanes: the card on the spine, then one lane per slot.
    const spine = y + m.a;
    out.nodes.push({ ...base, kind: 'card', id: step.id, container, collapsed: false, x, y: spine - D.cardH / 2, w: D.cardW, h: D.cardH, box: { x, y, w: m.w, h: m.h } });
    const cardRight = x + D.cardW;
    const laneX = cardRight + D.splitW;
    const forkX = cardRight + D.trunk;
    const joinX = laneX + m.lanesW + D.trunk;
    const spines = m.lanes.map((l, i) => y + m.tops[i] + l.above);
    const last = spines[spines.length - 1];
    line(cardRight, spine, laneX, spine);
    if (spines.length > 1) line(forkX, spine, forkX, last);
    defs.forEach((def, i) => {
      const lane = m.lanes[i];
      const s = spines[i];
      if (i > 0) line(forkX, s, laneX, s);
      if (def.label) out.labels.push({ parentId: step.id, slot: def.key, text: def.label, x: forkX + 4, y: s - 18, w: laneX - forkX - 6 });
      out.slots.push({ parentId: step.id, key: def.key, label: def.label ?? '', x: laneX - 4, y: y + m.tops[i] - 4, w: lane.w + 8, h: lane.above + lane.below + 8 });
      placeSeq(listOf(step, def.key), lane, laneX, s, { parentId: step.id, slot: def.key, def, ...inner });
      line(laneX + lane.w, s, joinX, s);
    });
    if (spines.length > 1) line(joinX, last, joinX, spine);
    out.dots.push({ x: joinX, y: spine });
    line(joinX, spine, x + m.w, spine);
  }

  const list = Array.isArray(steps) ? steps : [];
  const root = measureSeq(list);
  const startA = D.cardH / 2;
  const spine = D.margin + Math.max(startA, root.above);
  const start = { x: D.margin, y: spine - startA, w: D.cardW, h: D.cardH };
  out.order.push({ id: START_ID, parentId: null, level: 1, container: false, collapsed: false });
  placeSeq(list, root, D.margin + D.cardW, spine, { parentId: null, slot: null, level: 1, path: 'steps' });
  return {
    ...out,
    start,
    width: D.margin * 2 + D.cardW + root.w,
    height: spine + Math.max(startA, root.below) + D.margin,
  };
}
