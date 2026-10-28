// Issues bar (design 0009 §1): count label and F8 / Shift+F8 order. client/js/issues.js only
// imports dom.js, so its pure helpers load in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCountsLabel, issueCountParts, nextIssueIndex } from '../client/js/issues.js';

test('issue count label: errors, warnings, both, none', () => {
  assert.equal(issueCountsLabel({ errors: 2, warnings: 1 }), '2 lỗi · 1 cảnh báo');
  assert.equal(issueCountsLabel({ errors: 2, warnings: 0 }), '2 lỗi');
  assert.equal(issueCountsLabel({ errors: 0, warnings: 1 }), '1 cảnh báo');
  assert.equal(issueCountsLabel({ errors: 0, warnings: 0 }), '');
  assert.equal(issueCountsLabel(), '');
  // Each part carries its level, so the bar draws ⊗ or ▲ next to it.
  assert.deepEqual(issueCountParts({ errors: 1, warnings: 3 }), [{ level: 'error', text: '1 lỗi' }, { level: 'warning', text: '3 cảnh báo' }]);
});

test('F8 goes forward and wraps to the first row', () => {
  assert.equal(nextIssueIndex(-1, 3, 1), 0);
  assert.equal(nextIssueIndex(0, 3, 1), 1);
  assert.equal(nextIssueIndex(2, 3, 1), 0);
});

test('Shift+F8 goes back and wraps to the last row', () => {
  assert.equal(nextIssueIndex(-1, 3, -1), 2);
  assert.equal(nextIssueIndex(1, 3, -1), 0);
  assert.equal(nextIssueIndex(0, 3, -1), 2);
});

test('F8 after the list changed starts over; an empty list has no row', () => {
  assert.equal(nextIssueIndex(5, 3, 1), 0); // the current row was fixed and the list got shorter
  assert.equal(nextIssueIndex(5, 3, -1), 2);
  assert.equal(nextIssueIndex(0, 1, 1), 0);
  assert.equal(nextIssueIndex(-1, 0, 1), -1);
  assert.equal(nextIssueIndex(0, 0, -1), -1);
});
