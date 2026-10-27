// Hand-written version-1 graphs used by the migration tests (design 0003, "Các dạng đồ thị v1").
// Structured ones must migrate to a tree that produces byte-identical records.

const name = [{ name: 'Name', type: 'text', options: { mode: 'company', unique: true } }];
const rec = (id, sobject, alias, fields = name, extra = {}) => ({ id, type: 'record', config: { sobject, alias, fields, ...extra } });
const E = (from, to, fromPort = 'next') => ({ from, to, fromPort });
export const W = (nodes, edges, extra = {}) => ({ version: 1, name: 'test', nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} }, ...nodes], edges, ...extra });
export { rec, E };

export const STRUCTURED = {
  // 1: merge after a branch, inside a loop, then continue after the loop.
  mergeAfterBranch: W(
    [{ id: 'l', type: 'loop', config: { count: 20 } }, { id: 'b', type: 'branch', config: { probability: 0.3 } }, rec('a', 'Account', 'a'), rec('x', 'Lead', 'x'), rec('y', 'Task', 'y')],
    [E('start', 'l'), E('l', 'b', 'body'), E('b', 'a', 'true'), E('a', 'x'), E('b', 'x', 'false'), E('x', 'y'), E('l', 'y', 'done')],
  ),
  // 2: nested merge.
  nestedBranchMerge: W(
    [{ id: 'b1', type: 'branch', config: { probability: 0.5 } }, { id: 'b2', type: 'branch', config: { probability: 0.5 } }, rec('a', 'A', 'a'), rec('c', 'C', 'c'), rec('j', 'J', 'j'), { id: 'l', type: 'loop', config: { count: 7 } }],
    [E('start', 'l'), E('l', 'b1', 'body'), E('b1', 'a', 'true'), E('a', 'j'), E('b1', 'b2', 'false'), E('b2', 'c', 'true'), E('c', 'j'), E('b2', 'j', 'false')],
  ),
  // Loop inside a branch, then merge.
  loopInBranchThenMerge: W(
    [{ id: 'b', type: 'branch', config: { probability: 0.6 } }, { id: 'l', type: 'loop', config: { mode: 'range', min: 0, max: 3 } }, rec('a', 'A', 'a'), rec('x', 'X', 'x'), { id: 'o', type: 'loop', config: { count: 9, alias: 'o' } }],
    [E('start', 'o'), E('o', 'b', 'body'), E('b', 'l', 'true'), E('l', 'a', 'body'), E('l', 'x', 'done'), E('b', 'x', 'false')],
  ),
  // 3: unconnected false branch ends the chain; compare branch on a loop index.
  openFalseBranch: W(
    [{ id: 'l', type: 'loop', config: { count: 10 } }, { id: 'b', type: 'branch', config: { kind: 'compare', left: 'loop.index', op: 'divisibleBy', right: '3' } }, rec('a', 'A', 'a'), rec('z', 'Z', 'z')],
    [E('start', 'l'), E('l', 'b', 'body'), E('b', 'a', 'true'), E('l', 'z', 'done')],
  ),
  // Loop with no body still draws its random count (rng order must not change).
  emptyRangeLoop: W(
    [{ id: 'l', type: 'loop', config: { mode: 'range', min: 1, max: 9 } }, rec('a', 'A', 'a', name, { count: 3 }), { id: 'b', type: 'branch', config: { probability: 0.5 } }, rec('c', 'C', 'c')],
    [E('start', 'l'), E('l', 'a', 'done'), E('a', 'b'), E('b', 'c', 'false')],
  ),
};
