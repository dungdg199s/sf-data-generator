// Auto-layout of the "Sơ đồ" view (design 0003 đợt B): client/js/layout.js is a pure module,
// imported directly. Slots come from the real catalogue (server/workflow/nodes.js), as /api/meta
// serves them to the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, DIM, START_ID } from '../client/js/layout.js';
import { NODE_TYPES } from '../server/workflow/nodes.js';
import { allSteps } from '../shared/workflow-tree.js';

const slotsOf = (type) => NODE_TYPES.find((t) => t.type === type)?.slots ?? [];
const slotKeys = (type) => slotsOf(type).map((s) => s.key);
const run = (steps, opts = {}) => layout(steps, { slotsOf, ...opts });

const r = (id) => ({ id, type: 'record', config: { sobject: 'Account', alias: id, fields: [] } });
const q = (id) => ({ id, type: 'query', config: { alias: id } });
const p = (id) => ({ id, type: 'pick', config: { alias: id } });
const loop = (id, body = [], config = {}) => ({ id, type: 'loop', config: { alias: 'loop', ...config }, slots: { body } });
const branch = (id, yes = [], no = []) => ({ id, type: 'branch', config: {}, slots: { true: yes, false: no } });

const node = (lay, id) => lay.nodes.find((n) => n.id === id);
/** The rectangle a node draws as its card: the header bar of a frame, else the node. */
const cardRect = (n) => n.head ?? n;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/** Everything drawn on top (cards, frame headers, empty boxes, lane labels, "+" hit areas) must not overlap. */
function assertNoOverlap(lay) {
  const boxes = [
    { name: 'start', ...lay.start },
    ...lay.nodes.map((n) => ({ name: `card ${n.id ?? n.path}`, ...cardRect(n) })),
    ...lay.empties.map((e) => ({ name: `empty ${e.parentId}.${e.slot}`, ...e })),
    ...lay.labels.map((l) => ({ name: `label ${l.parentId}.${l.slot}`, x: l.x, y: l.y, w: l.w, h: 16 })),
    ...lay.adds.map((a) => ({ name: `add ${a.parentId}.${a.slot}.${a.index}`, x: a.x - 11, y: a.y - 11, w: 22, h: 22 })),
  ];
  // Sweep on x so 1 000-step workflows stay fast.
  boxes.sort((a, b) => a.x - b.x);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].x < boxes[i].x + boxes[i].w; j++) {
      assert.ok(!overlaps(boxes[i], boxes[j]), `${boxes[i].name} overlaps ${boxes[j].name}`);
    }
  }
  // Lane labels sit between the fork line and their lanes' outlines, never on them.
  for (const l of lay.labels) {
    for (const sl of lay.slots.filter((x) => x.parentId === l.parentId)) assert.ok(!overlaps({ x: l.x, y: l.y, w: l.w, h: 16 }, sl), `label ${l.parentId}.${l.slot} overlaps the outline of ${sl.parentId}.${sl.key}`);
  }
  for (const b of boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= lay.width && b.y + b.h <= lay.height, `${b.name} is outside the diagram`);
}

/** Every step inside a frame is drawn inside the frame's body, below its header. */
function assertNested(lay) {
  for (const n of lay.nodes) {
    if (!n.parentId) continue;
    const parent = node(lay, n.parentId);
    const area = parent.box ?? parent;
    assert.ok(inside(n, area), `${n.id} is outside its parent ${n.parentId}`);
    if (parent.head) assert.ok(n.y >= parent.head.y + parent.head.h, `${n.id} overlaps the header of ${n.parentId}`);
  }
}

test('empty workflow: the Start card and one "+ Thêm bước đầu tiên" box on the spine', () => {
  const lay = run([]);
  assert.deepEqual(lay.order.map((o) => o.id), [START_ID]);
  assert.equal(lay.nodes.length, 0);
  assert.equal(lay.empties.length, 1);
  const e = lay.empties[0];
  assert.equal(e.root, true);
  assert.equal(e.parentId, null);
  assert.equal(e.y + e.h / 2, lay.start.y + lay.start.h / 2);
  assert.equal(lay.width, 2 * DIM.margin + DIM.cardW + 2 * DIM.edge + DIM.emptyW);
  assertNoOverlap(lay);
});

test('a sequence runs left to right: card width, gaps and one "+" per insert position', () => {
  const lay = run([r('a'), q('b'), p('c')]);
  const xs = ['a', 'b', 'c'].map((id) => node(lay, id).x);
  const first = DIM.margin + DIM.cardW + DIM.gap;
  assert.deepEqual(xs, [first, first + DIM.cardW + DIM.gap, first + 2 * (DIM.cardW + DIM.gap)]);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(node(lay, id).w, DIM.cardW);
    assert.equal(node(lay, id).y, lay.start.y);
  }
  assert.equal(lay.width, 2 * DIM.margin + 4 * DIM.cardW + 4 * DIM.gap);
  assert.equal(lay.height, 2 * DIM.margin + DIM.cardH);
  // "+" at the middle of every connector, index 0…3, with the neighbours named.
  assert.deepEqual(lay.adds.map((a) => a.index), [0, 1, 2, 3]);
  assert.equal(lay.adds[0].x, DIM.margin + DIM.cardW + DIM.gap / 2);
  assert.equal(lay.adds[1].after.id, 'a');
  assert.equal(lay.adds[1].before.id, 'b');
  assert.equal(lay.adds[3].before, undefined);
  assert.deepEqual(lay.order.map((o) => o.id), [START_ID, 'a', 'b', 'c']);
  assertNoOverlap(lay);
});

test('Lặp is a frame around its body: header on top, body inside, entered and left on the spine', () => {
  const lay = run([loop('l', [r('a'), r('b')]), r('z')]);
  const l = node(lay, 'l');
  assert.equal(l.kind, 'frame');
  assert.equal(l.head.h, DIM.headH);
  assert.equal(l.head.w, l.w);
  const bodyW = 3 * DIM.gap + 2 * DIM.cardW;
  assert.equal(l.w, bodyW + 2 * DIM.pad);
  assert.equal(l.h, DIM.headH + DIM.bodyTop + DIM.cardH + DIM.pad);
  // The body cards sit on the frame's spine, and the step after the frame on the root spine.
  const a = node(lay, 'a');
  assert.equal(a.y + a.h / 2, l.y + DIM.headH + DIM.bodyTop + DIM.cardH / 2);
  assert.equal(node(lay, 'z').y + DIM.cardH / 2, l.y + DIM.headH + DIM.bodyTop + DIM.cardH / 2);
  assert.equal(node(lay, 'z').x, l.x + l.w + DIM.gap);
  // The body has its own "+" row: index 0…2 in slot body.
  assert.deepEqual(lay.adds.filter((x) => x.parentId === 'l').map((x) => `${x.slot}:${x.index}`), ['body:0', 'body:1', 'body:2']);
  assert.equal(lay.slots.filter((s) => s.parentId === 'l').length, 1);
  assert.deepEqual(lay.order.map((o) => `${o.id}@${o.level}`), [`${START_ID}@1`, 'l@1', 'a@2', 'b@2', 'z@1']);
  assertNoOverlap(lay);
  assertNested(lay);
});

test('an empty Lặp is a frame of minimum width with a "+ Thêm bước" box', () => {
  const lay = run([loop('l')]);
  const l = node(lay, 'l');
  assert.equal(l.w, Math.max(DIM.frameMinW, 2 * DIM.edge + DIM.emptyW + 2 * DIM.pad));
  assert.equal(lay.empties.length, 1);
  assert.equal(lay.empties[0].parentId, 'l');
  assert.equal(lay.empties[0].slot, 'body');
  assert.equal(lay.empties[0].def.empty, 'Thêm bước vào vòng lặp');
  assertNoOverlap(lay);
  assertNested(lay);
});

test('Rẽ nhánh: a card, then one lane per slot (Đúng above Sai), joined at a dot on the spine', () => {
  const lay = run([branch('b', [r('t1'), r('t2')], [r('f')]), r('z')]);
  const b = node(lay, 'b');
  assert.equal(b.kind, 'card');
  assert.equal(b.w, DIM.cardW);
  const [t1, t2, f, z] = ['t1', 't2', 'f', 'z'].map((id) => node(lay, id));
  // Đúng continues the spine, Sai is below it.
  assert.equal(t1.y, b.y);
  assert.equal(t2.y, b.y);
  assert.ok(f.y >= t1.y + t1.h + DIM.laneGap);
  assert.equal(t1.x, b.x + DIM.cardW + DIM.splitW + DIM.gap);
  assert.equal(f.x, t1.x);
  assert.deepEqual(lay.labels.map((l) => l.text), ['Đúng', 'Sai']);
  assert.equal(lay.dots.length, 1);
  assert.equal(lay.dots[0].y, b.y + DIM.cardH / 2);
  // The step after the branch is after the longest lane and the join.
  const lanesW = 3 * DIM.gap + 2 * DIM.cardW;
  assert.equal(z.x, b.x + DIM.cardW + DIM.splitW + lanesW + DIM.mergeW + DIM.gap);
  assert.equal(z.y, b.y);
  assert.deepEqual(lay.order.map((o) => o.id), [START_ID, 'b', 't1', 't2', 'f', 'z']);
  assertNoOverlap(lay);
  assertNested(lay);
});

test('an empty Sai lane is a "+ Thêm bước" box carrying its hint', () => {
  const lay = run([branch('b', [r('t')], [])]);
  assert.equal(lay.empties.length, 1);
  assert.equal(lay.empties[0].slot, 'false');
  assert.equal(lay.empties[0].def.hint, 'Để trống: không làm gì');
  assertNoOverlap(lay);
});

test('nested branches and loops do not overlap and stay inside their parents', () => {
  const steps = [
    q('accs'),
    loop('l1', [
      r('acc'),
      branch('b1', [r('c1'), branch('b2', [loop('l2', [r('t1')]), r('t2')], [branch('b3', [], [r('t3')])])], [loop('l3'), r('c2')]),
      p('pk'),
    ]),
    branch('b4', [], []),
    r('z'),
  ];
  const lay = run(steps);
  assertNoOverlap(lay);
  assertNested(lay);
  // Reading order = the tree's pre-order (true before false), as in the Quy trình view.
  assert.deepEqual(lay.order.slice(1).map((o) => o.id), allSteps({ steps }, slotKeys).map((s) => s.id));
  // Levels follow nesting.
  assert.equal(lay.order.find((o) => o.id === 't1').level, 5);
});

test('a collapsed container is a plain card: its steps are not drawn nor in the reading order', () => {
  const lay = run([loop('l', [r('a'), branch('b', [r('t')])]), branch('b2', [r('x')], [r('y')])], { collapsed: new Set(['l', 'b2']) });
  assert.deepEqual(lay.nodes.map((n) => `${n.id}:${n.kind}:${n.collapsed}`), ['l:card:true', 'b2:card:true']);
  assert.deepEqual(lay.order.map((o) => o.id), [START_ID, 'l', 'b2']);
  assert.equal(lay.adds.length, 3);
  assert.equal(lay.empties.length, 0);
  assert.equal(lay.dots.length, 0);
});

test('slots come from the catalogue: any 1-slot type is a frame, any multi-slot type has lanes', () => {
  const custom = { body2: [{ key: 'inside', label: '' }], switch3: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }] };
  const lay = layout(
    [
      { id: 's', type: 'switch3', slots: { a: [r('a1')], b: [], c: [r('c1'), r('c2')] } },
      { id: 'w', type: 'body2', slots: { inside: [r('i')] } },
      { id: 'u', type: 'unknown', slots: { body: [r('hidden')] } },
    ],
    { slotsOf: (t) => custom[t] },
  );
  assert.deepEqual(lay.labels.map((l) => l.text), ['A', 'B', 'C']);
  assert.equal(lay.empties.length, 1);
  assert.equal(node(lay, 'w').kind, 'frame');
  // A type the catalogue gives no slots is a plain card; its stray `slots` are not drawn.
  assert.equal(node(lay, 'u').kind, 'card');
  assert.equal(node(lay, 'hidden'), undefined);
  const [a1, c1] = [node(lay, 'a1'), node(lay, 'c1')];
  assert.ok(c1.y > a1.y);
  assertNoOverlap(lay);
  assertNested(lay);
});

test('an entry that is not a step object is drawn as an invalid card and keeps its place', () => {
  const lay = run([r('a'), 42, r('b')]);
  assert.deepEqual(lay.nodes.map((n) => n.kind), ['card', 'invalid', 'card']);
  assert.equal(lay.nodes[1].path, 'steps.1');
  assert.deepEqual(lay.order.map((o) => o.id), [START_ID, 'a', 'b']);
  assertNoOverlap(lay);
});

/** Deterministic pseudo-random tree of about `n` steps (no Math.random in tests either). */
function bigTree(n, seed = 1) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  let made = 0;
  const seq = (depth) => {
    const out = [];
    const len = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < len && made < n; i++) {
      made++;
      const k = rnd();
      if (depth < 6 && k < 0.15) out.push(loop(`l${made}`, seq(depth + 1)));
      else if (depth < 6 && k < 0.3) out.push(branch(`b${made}`, seq(depth + 1), rnd() < 0.3 ? [] : seq(depth + 1)));
      else out.push(r(`r${made}`));
    }
    return out;
  };
  const steps = [];
  while (made < n) steps.push(...seq(0));
  return steps;
}

test('1 000 steps: linear work and output, without overlaps', () => {
  // No timing (it flakes under parallel load): count the work instead. Each step is measured once
  // (memoised) and placed once, so the catalogue is asked exactly twice per step; the output grows
  // by a bounded amount per step.
  for (const [n, seed] of [[1000, 1], [8000, 7]]) {
    const steps = bigTree(n, seed);
    const count = allSteps({ steps }, slotKeys).length;
    assert.ok(count >= n);
    let calls = 0;
    const lay = layout(steps, { slotsOf: (type) => { calls++; return slotsOf(type); } });
    assert.equal(calls, 2 * count, `catalogue asked ${calls} times for ${count} steps`);
    assert.equal(lay.order.length, count + 1);
    assert.equal(lay.nodes.length, count);
    // One "+" per step plus one at the end of each non-empty sequence; ≤ 7 connector segments per step.
    const containers = allSteps({ steps }, slotKeys).filter((x) => slotKeys(x.type).length).length;
    assert.ok(lay.adds.length <= count + 2 * containers + 1, `${lay.adds.length} "+" for ${count} steps`);
    assert.ok(lay.edges.length <= 7 * count + 2, `${lay.edges.length} connectors for ${count} steps`);
    assert.ok(lay.empties.length + lay.labels.length + lay.slots.length <= 6 * containers + 1);
    if (n === 1000) {
      assertNoOverlap(lay);
      assertNested(lay);
    }
  }
});

test('aria-setsize / aria-posinset: siblings of a sequence, the Start card first at the root', () => {
  const lay = run([r('a'), 'oops', loop('l', [r('b'), r('c')]), branch('br', [r('t')], [])]);
  const at = (id) => lay.order.find((o) => o.id === id);
  assert.deepEqual([at(START_ID), at('a'), at('l'), at('br')].map((o) => `${o.posinset}/${o.setsize}`), ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual([at('b'), at('c'), at('t')].map((o) => `${o.posinset}/${o.setsize}`), ['1/2', '2/2', '1/1']);
  assert.equal(node(lay, 'c').posinset, 2);
});
