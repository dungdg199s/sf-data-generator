// client/js/history-text.js (design 0011 and its review): texts of the history dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteButtonLabel, dataStatus, canDelete, groupTarget, runStatus } from '../client/js/history-text.js';

test('delete button: "Lấy Id và xóa" when only unread Bulk jobs are left', () => {
  assert.equal(deleteButtonLabel(12005, 0), 'Xóa 12 005 bản ghi');
  assert.equal(deleteButtonLabel(0, 1), 'Lấy Id và xóa');
  assert.equal(deleteButtonLabel(3, 1), 'Xóa 3 bản ghi');
});

test('a run with an unread Bulk job still offers the delete and says why', () => {
  const run = { inserted: 5, deletion: { remaining: 0, deleted: 5, gone: 0, unreadJobs: 1 } };
  assert.equal(dataStatus(run), 'Còn 1 job Bulk chưa lấy Id');
  assert.equal(canDelete(run), true);
  assert.equal(canDelete({ inserted: 5, deletion: { remaining: 0, deleted: 5 } }), false);
  assert.equal(runStatus({ status: 'interrupted', inserted: 1200 }).title, 'Server dừng giữa lúc insert. Đã ghi được 1 200 Id; có thể thiếu Id của lô cuối hoặc job Bulk đang chạy.');
});

test('error group rows only point at steps still in the workflow', () => {
  const has = (id) => id === 'con';
  assert.equal(groupTarget({ nodeId: 'con' }, has), 'con');
  assert.equal(groupTarget({ nodeId: 'gone' }, has), null);
  assert.equal(groupTarget({}, has), null);
});
