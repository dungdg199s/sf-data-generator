// Texts of the insert history (design 0011): pure functions, no imports, so they are tested in
// Node (test/history-text.test.js) like issues.js.

const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Status of the run itself: { text, cls?, title? }. */
export function runStatus(run) {
  if (run.status === 'running') return { text: 'Đang insert' };
  if (run.status === 'done') return { text: 'Xong' };
  if (run.status === 'cancelled') return { text: 'Đã dừng' };
  if (run.status === 'stopped') return { text: ['allFailing', 'bulkFailing'].includes(run.stopped?.reason) ? 'Tự dừng (lỗi hàng loạt)' : 'Tự dừng' };
  if (run.status === 'error') return { text: 'Lỗi' };
  if (run.status === 'interrupted') {
    return { text: 'Bị gián đoạn', cls: 'warning-text', title: `Server dừng giữa lúc insert. Đã ghi được ${fmt(run.inserted)} Id; có thể thiếu Id của lô cuối hoặc job Bulk đang chạy.` };
  }
  return { text: run.status ?? '?' };
}

/** Status of the data in the org (list summary: deletion.remaining, deletion.unreadJobs). */
export function dataStatus(run) {
  const d = run.deletion ?? {};
  if (d.status === 'running') return 'Đang xóa';
  if (!d.remaining && d.unreadJobs) return `Còn ${d.unreadJobs} job Bulk chưa lấy Id`;
  if (!run.inserted) return 'Không có bản ghi nào trong org';
  if (!d.remaining) return 'Đã xóa';
  if ((d.deleted ?? 0) + (d.gone ?? 0) > 0) return `Đã xóa một phần (còn ${fmt(d.remaining)})`;
  return 'Còn trong org';
}

/** Something the delete can still do: records left, or Bulk jobs whose Ids were never read. */
export const canDelete = (run) => Boolean(run.deletion?.remaining || run.deletion?.unreadJobs);

/**
 * Label of the delete button of a run: `count` Ids known to be left, `pendingJobs` Bulk jobs whose
 * Ids are fetched first. Only unread jobs left (count 0): "Lấy Id và xóa" (review nit).
 */
export function deleteButtonLabel(count, pendingJobs = 0) {
  if (!count && pendingJobs) return 'Lấy Id và xóa';
  return `Xóa ${fmt(count)} bản ghi`;
}

/** Group rows of the error tabs select their step only while the step is still in the workflow. */
export const groupTarget = (group, hasStep) => (group?.nodeId && hasStep(group.nodeId) ? group.nodeId : null);
