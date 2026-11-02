// Insert history and delete confirmation (design 0011).
//
// The history lives on the server (server/history.js): this module only shows it. The "Lịch sử
// insert" dialog lists the runs (filtered on the selected org by default), opens a run's details,
// downloads its Ids, forgets it (after a confirmation that says nothing in the org changes) and
// opens the delete confirmation. The delete confirmation reads the run again (what is left to
// delete) and the org list (its type now, not at insert time): production asks for the org name to
// be typed. The confirmed delete itself runs in main.js (same "running" state as an insert).

import { api } from './api.js';
import { h, toast, download } from './dom.js';
import { state } from './store.js';
import { openPopup, closePopup } from './popup.js';
import { planDelete } from '/shared/insert-plan.js';
import { runStatus, dataStatus, canDelete, deleteButtonLabel } from './history-text.js';

const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const shortTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};
const longTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())} ngày ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};
const duration = (a, b) => {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  if (!Number.isFinite(s)) return '';
  return s >= 60 ? `${Math.floor(s / 60)} phút ${s % 60} giây` : `${s} giây`;
};
const orgName = (o) => o?.alias || o?.username || '?';
const kindOf = (o) => (!o ? 'unknown' : o.isScratch ? 'scratch' : o.isSandbox ? 'sandbox' : 'production');
const KIND_LABEL = { sandbox: 'sandbox', scratch: 'scratch org', production: 'production', unknown: 'không rõ loại' };

let hooks = { onDelete: async () => {}, isRunning: () => false };
let dialog = null;
let filterOn = true;
let openRun = null; // hid whose details are shown
let loaded = null; // last GET /api/history

/** hooks.onDelete(run, body, { org }) runs a confirmed delete; hooks.isRunning() → a run is going on. */
export function initHistory(h0) {
  hooks = { ...hooks, ...h0 };
  dialog = document.getElementById('history-dialog');
  dialog.addEventListener('close', () => { openRun = null; });
}

export const isHistoryOpen = () => Boolean(dialog?.open);

export { runStatus, dataStatus };

/** Downloads the Ids of a run (CSV). */
export async function downloadIds(hid) {
  try {
    const { blob, filename } = await api.historyIds(hid);
    download(filename, blob);
  } catch (e) {
    toast(e.message, 6000);
  }
}

/** Opens the "Lịch sử insert" dialog; `focus`: a run to show with its details open. */
export async function openHistory({ focus = null } = {}) {
  closePopup();
  openRun = focus;
  filterOn = true;
  try {
    loaded = await api.history();
  } catch (e) {
    toast(`Không đọc được Lịch sử: ${e.message}`, 6000);
    return;
  }
  render();
  if (!dialog.open) dialog.showModal();
  const first = dialog.querySelector('#history-filter') ?? dialog.querySelector('.history-close');
  first?.focus();
}

/** Reloads the open dialog (after a delete or a forget). */
export async function refreshHistory() {
  if (!dialog?.open) return;
  try {
    loaded = await api.history();
    render();
  } catch {
    // keep what is shown
  }
}

function render() {
  const data = loaded ?? { runs: [] };
  const org = state.org;
  const showFilter = Boolean(org) && data.enabled;
  const runs = (data.runs ?? []).filter((r) => !showFilter || !filterOn || r.org?.alias === org || r.org?.username === org);
  const head = h('div', { class: 'history-head' },
    h('h2', { id: 'history-title' }, 'Lịch sử insert'),
    h('button', { class: 'history-close', 'aria-label': 'Đóng Lịch sử insert', title: 'Đóng (Esc)', onclick: () => dialog.close() }, 'Đóng'));
  const where = data.enabled
    ? h('p', { class: 'hint history-where' }, `Lưu trên máy này tại ${data.dir} · giữ ${fmt(data.maxRuns)} lần insert gần nhất`)
    : h('div', { class: 'warn-box' }, disabledText(data));
  const filter = showFilter
    ? h('label', { class: 'history-filter' }, h('input', {
      id: 'history-filter', type: 'checkbox', checked: filterOn,
      onchange: (e) => { filterOn = e.target.checked; render(); dialog.querySelector('#history-filter')?.focus(); },
    }), ` Chỉ org đang chọn (${org})`)
    : null;
  const body = runs.length
    ? h('table', { class: 'data history-table' },
      h('thead', {}, h('tr', {}, ['Thời gian', 'Org', 'Workflow', 'Bản ghi', 'Trạng thái', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, runs.flatMap((r) => rowOf(r))))
    : h('p', { class: 'hint history-empty' }, data.enabled ? (filterOn && showFilter ? `Chưa có lần insert nào vào ${org}.` : 'Chưa có lần insert nào.') : '');
  dialog.replaceChildren(head, where, filter, h('div', { class: 'history-scroll' }, body));
}

function disabledText(data) {
  return `Không ghi được Lịch sử vào ${data.dir}: ${data.reason ?? 'lỗi không rõ'}. App không insert khi không ghi được Lịch sử (để luôn tải Id và xóa lại được). Đặt biến môi trường SFDG_DATA_DIR tới một thư mục ghi được rồi khởi động lại server.`;
}

/** Text of the history line of the Insert confirmation (null: history on). */
export function historyOffText(data) {
  return data && !data.enabled ? disabledText(data) : null;
}

function rowOf(r) {
  const st = runStatus(r);
  const left = r.deletion?.remaining ?? 0;
  const busy = r.status === 'running' || r.deletion?.status === 'running';
  const deletable = canDelete(r);
  const records = `${fmt(r.inserted)}${r.total && r.inserted + (r.failed ?? 0) < r.total ? `/${fmt(r.total)}` : ''}`;
  const expanded = openRun === r.id;
  const toggle = () => {
    openRun = expanded ? null : r.id;
    render();
    dialog.querySelector(`tr.history-row[data-hid="${r.id}"]`)?.focus();
  };
  const actions = h('td', { class: 'history-actions' },
    r.inserted ? h('button', { class: 'small', 'data-action': 'ids', title: 'Tải mọi Id đã insert của lần chạy này (CSV)', onclick: (e) => { e.stopPropagation(); downloadIds(r.id); } }, 'Tải Id') : null,
    deletable || busy ? h('button', {
      class: 'danger small', 'data-action': 'delete',
      disabled: busy || hooks.isRunning(),
      title: busy ? 'Lần insert này đang chạy.' : hooks.isRunning() ? 'Đang chạy. Bấm "Dừng" nếu muốn xóa.' : left ? `Xóa ${fmt(left)} bản ghi khỏi ${orgName(r.org)}` : 'Lấy Id của job Bulk chưa lấy kết quả rồi xóa',
      onclick: (e) => { e.stopPropagation(); openDeleteConfirm(r.id); },
    }, (r.deletion?.deleted ?? 0) + (r.deletion?.gone ?? 0) > 0 ? 'Xóa phần còn lại…' : 'Xóa khỏi org…') : null,
    h('button', {
      class: 'small history-more', 'aria-label': 'Thao tác khác', 'aria-haspopup': 'menu', disabled: busy,
      onclick: (e) => {
        e.stopPropagation();
        openPopup(e.currentTarget, { title: 'Lần insert này', items: [{ label: 'Quên lần insert này', onSelect: () => confirmForget(r) }] });
      },
    }, '⋯'));
  const row = h('tr', {
    class: `history-row${expanded ? ' open' : ''}`, 'data-hid': r.id, tabindex: '0', 'aria-expanded': String(expanded),
    title: 'Bấm (hoặc Enter) để xem chi tiết',
    onclick: toggle,
    onkeydown: (e) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggle();
      }
    },
  },
  h('td', { title: new Date(r.startedAt).toLocaleString('vi-VN') }, h('span', { class: 'history-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'), ` ${shortTime(r.startedAt)}`),
  h('td', { title: [r.org?.username, r.org?.orgId, KIND_LABEL[r.org?.kind] ?? r.org?.kind].filter(Boolean).join(' · ') }, orgName(r.org)),
  h('td', { class: 'wrap' }, r.workflowName || '—'),
  h('td', { class: 'num' }, records, r.failed ? h('span', { class: 'err' }, ` · lỗi ${fmt(r.failed)}`) : ''),
  h('td', { class: 'wrap' }, h('span', { class: st.cls ?? '', title: st.title }, st.text), ` · ${dataStatus(r)}`),
  actions);
  if (!expanded) return [row];
  const detail = h('tr', { class: 'history-detail' }, h('td', { colspan: '6', class: 'wrap' }, h('span', { class: 'hint' }, 'Đang tải chi tiết…')));
  loadDetail(r.id, detail.firstChild);
  return [row, detail];
}

async function loadDetail(hid, cell) {
  let run;
  try {
    run = await api.historyRun(hid);
  } catch (e) {
    cell.replaceChildren(h('span', { class: 'err' }, e.message));
    return;
  }
  const bySo = {};
  for (const s of run.steps ?? []) {
    const x = (bySo[s.sobject] ??= { inserted: 0, failed: 0, bulk: false });
    x.inserted += s.inserted ?? 0;
    x.failed += s.failed ?? 0;
    if (s.mode === 'bulk') x.bulk = true;
  }
  const jobs = (run.bulkJobs ?? []).length;
  const d = run.deletion ?? {};
  const lines = [
    Object.entries(bySo).map(([s, x]) => `${s} ${fmt(x.inserted)}${x.failed ? ` (lỗi ${fmt(x.failed)})` : ''}${x.bulk ? ` (Bulk, ${fmt(jobs)} job)` : ''}`).join(' · ')
      + ` · seed ${run.seed} · now ${new Date(run.now).toISOString()}${run.finishedAt ? ` · ${duration(run.startedAt, run.finishedAt)}` : ''} · ${fmt((run.errorGroups ?? []).length)} nhóm lỗi`,
    run.remaining?.total ? `Còn trong org: ${Object.entries(run.remaining.bySobject).map(([s, n]) => `${s} ${fmt(n)}`).join(', ')}.` : null,
    (d.deleted || d.gone) ? `Đã xóa ${fmt(d.deleted)}, đã không còn ${fmt(d.gone)}${d.failed ? `, lỗi ${fmt(d.failed)}` : ''}${d.lastAt ? ` (lần xóa gần nhất ${shortTime(d.lastAt)})` : ''}.` : null,
    jobs ? `Job Bulk: ${run.bulkJobs.map((j) => `${j.jobId} (${j.sobject}, ${j.state})`).join(', ')}.` : null,
    run.pendingBulkJobs?.length ? `Chưa lấy Id của ${run.pendingBulkJobs.length} job Bulk (${run.pendingBulkJobs.map((j) => j.jobId).join(', ')}); app lấy trước khi xóa.` : null,
  ].filter(Boolean);
  const groups = [...(run.errorGroups ?? []).slice(0, 5).map((g) => `Lỗi insert ${g.sobject}: ${g.message} (${fmt(g.count)})`), ...(d.errorGroups ?? []).slice(0, 5).map((g) => `Lỗi xóa ${g.sobject}: ${g.message} (${fmt(g.count)})`)];
  cell.replaceChildren(...lines.map((l) => h('div', {}, l)), groups.length ? h('ul', { class: 'history-errors' }, groups.map((g) => h('li', { class: 'err' }, g))) : '');
}

/** "Quên lần insert này": a confirmation (nothing in the org changes), then POST /forget. */
function confirmForget(r) {
  const modal = document.getElementById('modal');
  const left = r.deletion?.remaining ?? 0;
  const done = async (yes) => {
    modal.close();
    if (!yes) return;
    try {
      await api.forgetRun(r.id);
      toast('Đã quên lần insert này.');
    } catch (e) {
      toast(e.message, 6000);
    }
    await refreshHistory();
  };
  modal.replaceChildren(...[
    h('h2', {}, 'Quên lần insert này?'),
    h('p', {}, 'Xóa lần insert này khỏi Lịch sử? Chỉ xóa ghi chép trên máy này, không xóa gì trong org. Sau đó sẽ không tải Id hay xóa dữ liệu của lần insert này qua app được nữa.'),
    left ? h('p', {}, `Lần này còn ${fmt(left)} bản ghi trong ${orgName(r.org)}.`) : null,
    h('div', { class: 'actions' },
      h('button', { autofocus: true, onclick: () => done(false) }, 'Hủy'),
      h('button', { 'data-action': 'forget', onclick: () => done(true) }, 'Quên lần insert này')),
  ].filter(Boolean));
  modal.onclose = null;
  modal.showModal();
}

/**
 * The delete confirmation of a run: org (and its type now), what will be deleted per sObject,
 * order, Recycle Bin, cascades, Bulk, API calls. Production: the org name must be typed.
 */
export async function openDeleteConfirm(hid) {
  if (hooks.isRunning()) {
    toast('Đang chạy. Bấm "Dừng" nếu muốn chạy lại.');
    return;
  }
  let run;
  let orgs = null;
  try {
    [run, orgs] = await Promise.all([api.historyRun(hid), api.orgs().catch(() => null)]);
  } catch (e) {
    toast(e.message, 6000);
    return;
  }
  if (run.status === 'running') {
    toast('Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.', 6000);
    return;
  }
  const target = run.org?.alias || run.org?.username;
  const listed = (orgs ?? []).find((o) => o.alias === target || o.username === target) ?? null;
  const kind = orgs ? kindOf(listed) : 'unknown';
  const production = kind !== 'sandbox' && kind !== 'scratch';
  const missing = orgs && !listed;
  const count = run.remaining?.total ?? 0;
  const partial = (run.deletion?.deleted ?? 0) + (run.deletion?.gone ?? 0) > 0;
  const limits = state.meta?.limits ?? {};
  const groups = run.remaining?.bySteps ?? [];
  const canBulk = groups.some((g) => g.count >= (limits.bulkMinRecords ?? 10000));
  const modal = document.getElementById('modal');
  let bulk = 'auto';
  const callsLine = h('p', { class: 'hint delete-calls' });
  const updateCalls = () => {
    const p = planDelete({ groups, bulk, limits });
    callsLine.textContent = p.apiCalls.bulk
      ? `Khoảng ${fmt(p.apiCalls.total)} lời gọi API (sObject Collections ${fmt(p.apiCalls.collections)}, Bulk khoảng ${fmt(p.apiCalls.bulk)}), tính vào giới hạn API 24 giờ của org.`
      : `Khoảng ${fmt(p.apiCalls.total)} lời gọi API (200 bản ghi mỗi lời gọi), tính vào giới hạn API 24 giờ của org.`;
  };
  updateCalls();
  const pending = run.pendingBulkJobs?.length ?? 0;
  const confirmBtn = h('button', { class: 'danger solid', 'data-action': 'confirm-delete', disabled: true }, deleteButtonLabel(count, pending));
  const typed = h('input', {
    type: 'text', class: 'typed-org', placeholder: target, 'aria-label': 'Gõ tên org để xác nhận xóa', autocomplete: 'off', spellcheck: 'false',
    oninput: () => sync(),
  });
  const names = [target, run.org?.username, listed?.alias, listed?.username].filter(Boolean).map((x) => String(x).toLowerCase());
  const sync = () => {
    const ok = !missing && (count > 0 || pending > 0) && (!production || names.includes(typed.value.trim().toLowerCase()));
    confirmBtn.disabled = !ok;
  };
  const bySo = Object.entries(run.remaining?.bySobject ?? {}).map(([s, n]) => `${s} ${fmt(n)}`).join(', ');
  const cancelBtn = h('button', { 'data-action': 'cancel', onclick: () => modal.close() }, 'Hủy');
  modal.replaceChildren(...[
    h('h2', {}, partial ? 'Xóa phần còn lại?' : 'Xóa dữ liệu đã insert?'),
    h('p', {}, 'Org: ', h('b', {}, target), run.org?.username && run.org.username !== target ? ` (${run.org.username})` : '', ` · ${KIND_LABEL[kind]}`),
    missing ? h('div', { class: 'warn-box' }, `Org "${target}" không còn đăng nhập trong sf CLI. Chạy sf org login web --alias ${target} rồi mở lại hộp này.`) : null,
    production && !missing ? h('div', { class: 'warn-box prod-delete' }, h('div', {},
      h('div', {}, kind === 'unknown'
        ? 'Không biết loại org (sf CLI lỗi), nên coi như production. Gõ tên org để xác nhận:'
        : 'Org này là production (không phải sandbox hay scratch org). Gõ tên org để xác nhận:'),
      typed)) : null,
    h('p', { class: 'delete-count' }, `Sẽ xóa ${fmt(count)} bản ghi${partial ? ' còn lại' : ''} do lần insert lúc ${longTime(run.startedAt)} (workflow "${run.workflowName || '—'}") tạo ra:`),
    h('p', {}, `${bySo}. Xóa bản ghi con trước, bản ghi cha sau.`),
    h('p', { class: 'hint' }, 'Chỉ xóa đúng các Id app đã ghi lúc insert, kể cả bản ghi đã bị sửa sau đó. Bản ghi đã bị xóa trước đó được bỏ qua.'),
    // Review S5: always — any deleted record can be the parent of records the app did not create.
    h('p', { class: 'hint cascade-line' }, 'Xóa một bản ghi là cha của bản ghi khác có thể làm Salesforce tự xóa cả bản ghi con của nó (ví dụ Contact, Opportunity của Account), kể cả bản ghi con không do app tạo.'),
    h('p', { class: 'hint' }, 'Bản ghi bị xóa vào Thùng rác của org (khôi phục được trong 15 ngày nếu Thùng rác chưa đầy).'),
    run.pendingBulkJobs?.length ? h('p', { class: 'hint' }, `Lấy Id của ${run.pendingBulkJobs.length} job Bulk chưa lấy kết quả (${run.pendingBulkJobs.map((j) => j.jobId).join(', ')}) trước khi xóa.`) : null,
    canBulk ? h('label', { class: 'bulk-check', title: 'Nhanh hơn và ít lời gọi API hơn.' }, h('input', {
      type: 'checkbox', checked: true, onchange: (e) => { bulk = e.target.checked ? 'auto' : 'off'; updateCalls(); },
    }), ` Dùng Bulk API 2.0 cho sObject từ ${fmt(limits.bulkMinRecords ?? 10000)} bản ghi`) : null,
    callsLine,
    h('p', { class: 'hint' }, 'Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã xóa nằm trong Thùng rác.'),
    h('div', { class: 'actions' }, cancelBtn, confirmBtn),
  ].filter(Boolean));
  sync();
  confirmBtn.onclick = () => {
    modal.close();
    if (dialog?.open) dialog.close();
    const confirm = { username: run.org?.username ?? '', count, ...(production ? { typedOrg: typed.value.trim() } : {}) };
    hooks.onDelete(run, { confirm, bulk }, { org: target });
  };
  modal.onclose = null;
  modal.showModal();
  cancelBtn.focus();
}
