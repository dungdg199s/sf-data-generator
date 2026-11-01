// Insert history in the browser (design 0011 §4–§5): whether the server can keep it (no history ⇒
// no insert, review S7), the Id download of an insert, the "Lịch sử insert" dialog (list, details,
// Quên) and the delete confirmation. The list and the Ids live on the server (GET /api/history…);
// the client never holds or sends Ids: a delete sends only the confirmation (username, count and,
// for production or an org of unknown kind, the org name typed by hand).
//
// The delete itself runs in the results panel like an insert: main.js gives `startDelete` (it owns
// the "running" state, Dừng and the summary). A refusal before anything is deleted (400 / 404 / 409 /
// 502 / 503, among them a 409 with a new `count` after pending Bulk jobs were read) comes back here and
// is shown in the confirmation, which then needs a fresh click: never retried by itself.

import { api } from './api.js';
import { h, ico, toast } from './dom.js';
import { state } from './store.js';
import { openPopup } from './popup.js';
import { planDelete } from '/shared/insert-plan.js';

/** Last GET /api/history: { enabled, reason?, dir, maxRuns, runs, prune } (null until read or when it failed). */
let last = null;
let hooks = { startDelete: null, isRunning: () => false };
let dialog = null;
let view = null; // { filter, open: Set<hid>, details: Map<hid, entry | { error }>, note }

/** The history the server reported last time (null: not read yet, or the server did not answer). */
export const historyStatus = () => last;

/** Reads the history again (status, entries, what the next insert would prune). → the answer or null. */
export async function refreshHistory() {
  try {
    last = await api.history();
  } catch {
    // Server unreachable: keep the last answer; /api/run refuses an insert itself (503) anyway.
  }
  return last;
}

/** Why Insert is locked while history is off (design 0011 §1, the warn-box and the button's title). */
export const historyOffText = (st) => `Không ghi được Lịch sử vào ${st.dir}: ${st.reason}, nên không insert được (app phải ghi được Id để tải lại hay xóa dữ liệu). Đặt biến môi trường SFDG_DATA_DIR tới một thư mục ghi được rồi khởi động lại server.`;

/** "⤓ Id": the CSV of every Id of an insert (sobject,id,ref,step,status); the server names the file. */
export function downloadIds(hid) {
  // No `download` attribute: it would replace the server's file name (Content-Disposition: attachment)
  // with the URL's; an attachment never navigates away from the app.
  const a = h('a', { href: api.idsCsvUrl(hid) });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * hooks.startDelete({ hid, body, org, total, bySobject, onResponse }) → Promise: rejects (with
 * `status`, `body`) when the server refused before deleting anything; `onResponse` once it started.
 * hooks.isRunning() → a run (preview, insert, delete) is on.
 */
export function initHistory(h2) {
  hooks = { ...hooks, ...h2 };
  dialog = document.getElementById('history-dialog');
  dialog.addEventListener('close', () => { view = null; });
}

const fmt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const date = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
/** `HH:mm dd/MM` (list), `HH:mm ngày dd/MM/yyyy` (sentences). */
const shortWhen = (iso) => { const d = date(iso); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : '?'; };
const longWhen = (iso) => { const d = date(iso); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())} ngày ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '?'; };
const duration = (a, b) => {
  const ms = (date(b)?.getTime() ?? 0) - (date(a)?.getTime() ?? 0);
  if (!(ms > 0)) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút ${s % 60} giây`;
};
const orgName = (org) => org?.alias ?? org?.username ?? '?';
const KIND = { sandbox: 'sandbox', scratch: 'scratch org', production: 'production', unknown: 'không rõ loại' };

const RUN_STATUS = {
  running: 'Đang insert', done: 'Xong', cancelled: 'Đã dừng', stopped: 'Tự dừng (lỗi hàng loạt)', error: 'Lỗi', interrupted: 'Bị gián đoạn', corrupt: 'Hỏng',
};

/** Records an entry may still have in its org (the list's deletion.remaining counts pending Bulk jobs too). */
const remainingOf = (run) => run.deletion?.remaining ?? 0;
const busy = (run) => run.status === 'running' || Boolean(run.active);

/** "Còn trong org", "Đã xóa một phần (còn 600)", … (design 0011 §4). */
function dataStatus(run) {
  if (run.active === 'delete') return 'Đang xóa';
  const removed = (run.deletion?.deleted ?? 0) + (run.deletion?.gone ?? 0);
  const left = remainingOf(run);
  if (!left) return removed ? 'Đã xóa' : 'Không có bản ghi nào trong org';
  return removed ? `Đã xóa một phần (còn ${fmt(left)})` : 'Còn trong org';
}

/** The sentence of `rejected` (rows of the Id file no step of the entry owns), whatever shape it comes in. */
function rejectedText(x) {
  const r = x?.rejected ?? x?.remaining?.rejected;
  if (x?.rejectedMessage) return x.rejectedMessage;
  if (r && typeof r === 'object') return r.message ?? (r.count ? `${fmt(r.count)} dòng của file Id không thuộc bước nào của lần insert này nên không bao giờ bị xóa.` : null);
  if (typeof r === 'string') return r;
  return r > 0 ? `${fmt(r)} dòng của file Id không thuộc bước nào của lần insert này (file có thể đã bị sửa) nên không bao giờ bị xóa.` : null;
}

/** Pending jobs plus the ones whose Ids are lost for good (`lostBulkJobs`, each with the server's sentence). */
export const bulkJobsOf = (x) => [...(x?.pendingBulkJobs ?? []), ...(x?.lostBulkJobs ?? []).map((j) => ({ ...j, idsLost: true }))];

/** Lines about Bulk jobs whose Ids are not in history yet (a delete reads them first), or never will be. */
export function pendingLines(jobs) {
  return (jobs ?? []).map((j) => (j.idsLost
    ? j.message ?? `Job Bulk ${j.jobId} (${j.sobject}): Salesforce không còn giữ kết quả, nên Id của các bản ghi này không lấy lại được và app không xóa được chúng. Xem job trong Setup → Bulk Data Load Jobs.`
    : `Job Bulk ${j.jobId} (${j.sobject}${j.records ? `, ${fmt(j.records)} bản ghi` : ''}${j.state ? `, ${j.state}` : ''}) chưa lấy Id: lần xóa lấy Id của nó trước rồi hỏi xác nhận lại nếu số bản ghi đổi.`));
}

// ---------- the "Lịch sử insert" dialog ----------

/** Opens the dialog; `hid`: that run's details open (the "Lịch sử" link of an insert). */
export async function openHistory({ hid = null } = {}) {
  view = { filter: Boolean(state.org), open: new Set(hid ? [hid] : []), details: new Map(), note: null, focusHid: hid };
  dialog.replaceChildren(h('h2', { id: 'history-title' }, 'Lịch sử insert'), h('p', { class: 'hint' }, 'Đang đọc Lịch sử…'));
  if (!dialog.open) dialog.showModal();
  await refreshHistory();
  if (!view) return;
  if (hid) await loadDetail(hid);
  render();
  const first = hid ? dialog.querySelector(`.hist-run[data-hid="${CSS.escape(hid)}"] .hist-main`) : null;
  (first ?? dialog.querySelector('.hist-filter input') ?? dialog.querySelector('.hist-close')).focus();
  first?.scrollIntoView({ block: 'nearest' });
}

async function loadDetail(hid) {
  try {
    view?.details.set(hid, await api.historyEntry(hid));
  } catch (e) {
    view?.details.set(hid, { error: e.message });
  }
}

/** Re-reads the list (after a forget, a delete) and redraws, keeping the open details. */
async function reload() {
  if (!view) return;
  await refreshHistory();
  for (const hid of view.open) await loadDetail(hid);
  if (view) render();
}

function render() {
  if (!view || !dialog.open) return;
  const st = last;
  const active = document.activeElement?.closest?.('[data-focus]')?.dataset.focus;
  const orgSel = state.org;
  const runs = (st?.runs ?? []).filter((r) => !view.filter || !orgSel || r.status === 'corrupt' || r.org?.alias === orgSel || r.org?.username === orgSel);
  dialog.replaceChildren(...[
    h('div', { class: 'hist-head' },
      h('h2', { id: 'history-title' }, 'Lịch sử insert'),
      h('button', { class: 'icon hist-close', 'aria-label': 'Đóng', title: 'Đóng (Esc)', onclick: () => dialog.close() }, ico('x'))),
    !st
      ? h('div', { class: 'warn-box' }, 'Không đọc được Lịch sử: server không trả lời. Kiểm tra server rồi mở lại hộp này.')
      : st.enabled
        ? h('p', { class: 'hist-where' }, `Lưu trên máy này tại ${st.dir} · giữ ${fmt(st.maxRuns)} lần insert gần nhất`)
        : h('div', { class: 'warn-box history-off' }, historyOffText(st)),
    view.note ? h('p', { class: `hist-note${view.note.error ? ' err' : ''}`, role: 'status' }, view.note.text) : null,
    orgSel && st?.enabled
      ? h('label', { class: 'check-line hist-filter' },
        h('input', { type: 'checkbox', checked: view.filter, 'data-focus': 'filter', onchange: (e) => { view.filter = e.target.checked; render(); } }),
        `Chỉ org đang chọn (${orgSel})`)
      : null,
    st?.enabled
      ? runs.length
        ? h('div', { class: 'hist-table' },
          h('div', { class: 'hist-cols', 'aria-hidden': 'true' }, ...['Thời gian', 'Org', 'Workflow', 'Bản ghi', 'Trạng thái'].map((t) => h('span', {}, t)), h('span', {})),
          h('ul', { class: 'hist-list', 'aria-labelledby': 'history-title' }, runs.map(runRow)))
        : h('p', { class: 'hint hist-empty' }, view.filter && orgSel ? `Chưa có lần insert nào vào ${orgSel} được ghi trên máy này. Bỏ chọn "Chỉ org đang chọn" để xem mọi org.` : 'Chưa có lần insert nào được ghi trên máy này.')
      : null,
  ].filter(Boolean));
  if (active) dialog.querySelector(`[data-focus="${CSS.escape(active)}"]`)?.focus();
}

function runRow(run) {
  const hid = run.id;
  const open = view.open.has(hid);
  const detailId = `hist-d-${hid}`;
  if (run.status === 'corrupt') {
    return h('li', { class: 'hist-run corrupt', 'data-hid': hid },
      h('div', { class: 'hist-row' },
        h('span', { class: 'hist-main hist-static' },
          h('span', { class: 'hist-when' }, hid),
          h('span', { class: 'hist-status warning-text', title: run.error ?? '' }, RUN_STATUS.corrupt)),
        h('span', { class: 'hist-actions' })),
      h('p', { class: 'hint hist-detail-line' }, run.error ?? ''));
  }
  const left = remainingOf(run);
  const removed = (run.deletion?.deleted ?? 0) + (run.deletion?.gone ?? 0);
  const sent = run.inserted ?? 0;
  const count = run.total && sent + (run.failed ?? 0) < run.total ? `${fmt(sent)}/${fmt(run.total)}` : fmt(sent);
  const interrupted = run.status === 'interrupted';
  const lockTitle = run.status === 'running' || run.active === 'insert' ? 'Lần insert này đang chạy.' : run.active === 'delete' ? 'Đang xóa dữ liệu của lần insert này.' : run.active ? 'Lần insert này đang được dùng.' : hooks.isRunning() ? 'Đang chạy. Bấm "Dừng" hoặc chờ lần chạy xong.' : null;
  const forget = () => askForget(run);
  return h('li', { class: `hist-run${open ? ' open' : ''}`, 'data-hid': hid },
    h('div', { class: 'hist-row' },
      h('button', {
        class: 'hist-main',
        'aria-expanded': String(open),
        'aria-controls': detailId,
        'data-focus': `main-${hid}`,
        title: 'Bấm (hoặc Enter) để xem chi tiết',
        onclick: async () => {
          if (view.open.has(hid)) view.open.delete(hid);
          else {
            view.open.add(hid);
            if (!view.details.has(hid)) await loadDetail(hid);
          }
          render();
        },
      },
      h('span', { class: 'hist-when', title: longWhen(run.startedAt) }, ico(open ? 'chevron-down' : 'chevron-right'), shortWhen(run.startedAt)),
      h('span', { class: 'hist-org', title: [run.org?.username, run.org?.orgId, KIND[run.org?.kind] ?? run.org?.kind].filter(Boolean).join(' · ') }, orgName(run.org)),
      h('span', { class: 'hist-wf' }, run.workflowName || '(không tên)'),
      h('span', { class: 'hist-count' }, count, run.failed ? h('span', { class: 'err' }, ` · lỗi ${fmt(run.failed)}`) : ''),
      h('span', { class: 'hist-status', title: `${RUN_STATUS[run.status] ?? run.status} · ${dataStatus(run)}` },
        h('span', {
          class: interrupted ? 'warning-text' : run.status === 'error' || run.status === 'stopped' ? 'err' : '',
          title: interrupted ? `Server dừng giữa lúc insert. Đã ghi được ${fmt(sent)} Id; có thể thiếu Id của lô cuối hoặc job Bulk đang chạy.` : undefined,
        }, RUN_STATUS[run.status] ?? run.status),
        ' · ', dataStatus(run))),
      h('span', { class: 'hist-actions' },
        sent ? h('button', { class: 'small', title: 'Tải mọi Id đã insert của lần này (CSV)', onclick: () => downloadIds(hid) }, ico('download'), 'Id') : null,
        left ? h('button', {
          class: 'danger small hist-delete',
          disabled: Boolean(lockTitle),
          title: lockTitle ?? undefined,
          'data-focus': `del-${hid}`,
          onclick: () => confirmDelete(hid),
        }, removed ? 'Xóa phần còn lại…' : 'Xóa khỏi org…') : null,
        h('button', {
          class: 'icon small hist-more',
          'aria-label': `Thao tác khác với lần insert lúc ${shortWhen(run.startedAt)}`,
          'aria-haspopup': 'menu',
          'data-focus': `more-${hid}`,
          onclick: (e) => openPopup(e.currentTarget, {
            title: `Lần insert lúc ${shortWhen(run.startedAt)}`,
            items: [{ label: 'Quên lần insert này', disabled: Boolean(busy(run)), title: busy(run) ? lockTitle : undefined, onSelect: forget }],
          }),
        }, ico('more')))),
    h('div', { class: 'hist-detail', id: detailId, hidden: !open }, open ? detailView(run) : null));
}

/** The ▾ details of one run (GET /api/history/:hid). */
function detailView(run) {
  const d = view.details.get(run.id);
  if (!d) return h('p', { class: 'hint' }, 'Đang đọc…');
  if (d.error) return h('p', { class: 'err' }, d.error);
  const remainingByStep = new Map((d.remaining?.steps ?? []).map((s) => [s.nodeId, s.remaining]));
  const jobs = d.bulkJobs ?? [];
  const stepLine = (s) => {
    const nJobs = jobs.filter((j) => j.nodeId === s.nodeId).length;
    const mode = s.mode === 'bulk' ? ` (Bulk${nJobs ? `, ${nJobs} job` : ''}${s.fallback ? ', đã chuyển về sObject Collections' : ''})` : '';
    const left = remainingByStep.get(s.nodeId);
    return `${s.alias || s.nodeId} · ${s.sobject} ${fmt(s.inserted)}${s.total && s.total !== s.inserted ? `/${fmt(s.total)}` : ''}${mode}${s.failed ? ` · lỗi ${fmt(s.failed)}` : ''}${left !== undefined && left !== s.inserted ? ` · còn trong org ${fmt(left)}` : ''}`;
  };
  const del = d.deletion ?? {};
  const groups = (list, other) => (list?.length
    ? h('ul', { class: 'hist-groups' },
      list.slice(0, 5).map((g) => h('li', {}, `${g.sobject}${g.nodeId ? ` (${g.nodeId})` : ''}: `, h('span', { class: 'err' }, g.message), ` · ${fmt(g.count)} bản ghi`)),
      list.length > 5 || other ? h('li', { class: 'hint' }, `… và ${fmt(Math.max(0, list.length - 5) + (other?.groups ?? 0))} nhóm lỗi khác`) : null)
    : null);
  const dur = duration(d.startedAt, d.finishedAt);
  const lines = [
    h('ul', { class: 'hist-steps' }, (d.steps ?? []).map((s) => h('li', {}, stepLine(s)))),
    h('p', {}, [`Seed ${d.seed}`, Number.isFinite(d.now) ? `now ${new Date(d.now).toISOString()}` : null, dur, d.notSent ? `chưa gửi ${fmt(d.notSent)}` : null].filter(Boolean).join(' · ')),
    jobs.length ? h('p', {}, `Job Bulk: ${jobs.slice(0, 5).map((j) => j.jobId).join(', ')}${jobs.length > 5 ? ` và ${jobs.length - 5} job khác` : ''}`) : null,
    ...pendingLines(bulkJobsOf(d)).map((t) => h('p', { class: 'warning-text' }, t)),
    rejectedText(d) ? h('p', { class: 'warning-text' }, rejectedText(d)) : null,
    d.stopped?.message || d.stopped?.text ? h('p', { class: 'err' }, d.stopped.text ?? d.stopped.message) : null,
    d.error ? h('p', { class: 'err' }, d.error) : null,
    d.errorGroups?.length ? h('p', {}, 'Lỗi insert:') : null,
    groups(d.errorGroups, d.errorGroupsOther),
    del.lastAt
      ? h('p', {}, `Lần xóa gần nhất: ${longWhen(del.lastAt)} · đã xóa ${fmt(del.deleted)} · đã không còn ${fmt(del.gone)}${del.failed ? ` · lỗi ${fmt(del.failed)}` : ''}${del.cancelled ? ' · đã dừng' : ''}`)
      : null,
    del.stopped ? h('p', { class: 'err' }, del.stopped.text ?? del.stopped.message) : null,
    groups(del.errorGroups),
  ];
  return lines.filter(Boolean);
}

/** "Quên lần insert này" (a confirmation on top of the history dialog: nothing in the org changes). */
function askForget(run) {
  const modal = document.getElementById('modal');
  const left = remainingOf(run);
  modal.replaceChildren(
    h('h2', {}, 'Quên lần insert này?'),
    h('p', {}, 'Xóa lần insert này khỏi Lịch sử? Chỉ xóa ghi chép trên máy này, không xóa gì trong org. Sau đó sẽ không tải Id hay xóa dữ liệu của lần insert này qua app được nữa.'),
    left ? h('div', { class: 'warn-box' }, `Lần này còn ${fmt(left)} bản ghi trong ${orgName(run.org)}.`) : '',
    h('div', { class: 'actions' },
      h('button', { onclick: () => modal.close() }, 'Hủy'),
      h('button', {
        class: 'forget-ok',
        onclick: async () => {
          modal.close();
          try {
            await api.forgetHistory(run.id);
            if (view) view.note = { text: `Đã quên lần insert lúc ${shortWhen(run.startedAt)} (${run.workflowName || 'không tên'}).` };
          } catch (e) {
            if (view) view.note = { text: e.message, error: true };
          }
          await reload();
          dialog.querySelector('.hist-filter input, .hist-close')?.focus();
        },
      }, 'Quên lần insert này')),
  );
  modal.onclose = null;
  modal.showModal();
  modal.querySelector('.actions button').focus();
}

// ---------- delete confirmation (design 0011 §5) ----------

/** Says `text` where the user is looking: in the history dialog when it is open, else as a toast. */
function tell(text, error = true) {
  if (view && dialog.open) {
    view.note = { text, error };
    render();
  } else toast(text, 10000);
}

/**
 * The delete confirmation of insert `hid`: numbers from GET /api/history/:hid, org kind from
 * GET /api/orgs right now (unknown ⇒ like production: the org name typed by hand). Focus starts
 * on Hủy; the button names the count and is `.danger.solid`.
 */
export async function confirmDelete(hid) {
  if (hooks.isRunning()) return tell('Đang chạy. Bấm "Dừng" hoặc chờ lần chạy xong rồi mới xóa.');
  let entry;
  let orgs;
  try {
    [entry, orgs] = await Promise.all([api.historyEntry(hid), api.orgs().catch(() => null)]);
  } catch (e) {
    return tell(e.message);
  }
  if (entry.status === 'running' || entry.active === 'insert') return tell('Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.');
  if (entry.active === 'delete') return tell('Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
  if (!entry.remaining?.total && !entry.pendingBulkJobs?.length) return tell('Lần insert này không còn bản ghi nào để xóa.');
  const was = entry.org ?? {};
  const name = orgName(was);
  // Kind as the sf CLI says now (not at insert time); no answer ⇒ unknown, treated as production.
  const listed = orgs ? orgs.find((o) => (was.username && o.username === was.username) || (was.alias && o.alias === was.alias)) : null;
  const missing = Boolean(orgs) && !listed;
  const kind = !orgs ? 'unknown' : !listed ? was.kind ?? 'unknown' : listed.isScratch ? 'scratch' : listed.isSandbox ? 'sandbox' : 'production';
  const mustType = kind !== 'sandbox' && kind !== 'scratch';
  const names = [was.alias, was.username].filter(Boolean).map((x) => x.toLowerCase());
  const minBulk = state.meta?.limits?.bulkMinRecords ?? 10000;
  const modal = document.getElementById('modal');
  let bulk = 'auto';
  let refusal = null;
  let sending = false;
  let typed = '';

  const render = () => {
    const count = entry.remaining?.total ?? 0;
    const steps = entry.remaining?.steps ?? [];
    const partial = (entry.deletion?.deleted ?? 0) + (entry.deletion?.gone ?? 0) > 0;
    const order = [];
    for (const s of [...steps].reverse()) {
      if (!s.remaining) continue;
      const o = order.find((x) => x.sobject === s.sobject);
      if (o) o.n += s.remaining;
      else order.push({ sobject: s.sobject, n: s.remaining });
    }
    const plan = planDelete({ steps, bulk, limits: state.meta?.limits });
    const c = plan.apiCalls;
    const canBulk = steps.some((s) => s.remaining >= minBulk);
    const cascade = new Set((entry.steps ?? []).map((s) => s.sobject)).size > 1;
    const pending = entry.pendingBulkJobs ?? [];
    const okName = !mustType || names.includes(typed.trim().toLowerCase());
    const btn = h('button', {
      class: 'danger solid delete-ok',
      disabled: missing || !okName || sending || (!count && !pending.length),
      onclick: () => submit(count),
    }, sending ? 'Đang gửi…' : count || !pending.length ? `Xóa ${fmt(count)} bản ghi` : 'Lấy Id từ job Bulk rồi xác nhận');
    const input = mustType && !missing
      ? h('input', {
        type: 'text',
        class: 'type-org',
        value: typed,
        placeholder: was.alias ?? was.username ?? '',
        'aria-label': 'Gõ tên org để xác nhận xóa',
        autocomplete: 'off',
        spellcheck: 'false',
        oninput: (e) => {
          typed = e.target.value;
          btn.disabled = missing || sending || !names.includes(typed.trim().toLowerCase()) || (!count && !pending.length);
        },
      })
      : null;
    modal.replaceChildren(...[
      h('h2', {}, partial ? 'Xóa phần còn lại?' : 'Xóa dữ liệu đã insert?'),
      h('p', {}, 'Org: ', h('b', {}, name), was.username && was.alias ? ` (${was.username})` : '', ` · ${KIND[kind] ?? kind}`),
      missing ? h('div', { class: 'warn-box org-missing' }, `Org "${name}" không còn đăng nhập trong sf CLI. Chạy sf org login web --alias ${name} rồi mở lại hộp này.`) : null,
      input
        ? h('div', { class: 'warn-box type-org-box' },
          h('div', {},
            kind === 'production'
              ? 'Org này là production (không phải sandbox hay scratch org). Gõ tên org để xác nhận: '
              : 'Không biết org này là sandbox hay production (sf CLI không trả lời), nên coi như production. Gõ tên org để xác nhận: ',
            input))
        : null,
      refusal ? h('div', { class: 'warn-box delete-refused', role: 'alert' }, refusal) : null,
      h('p', { class: 'delete-count' }, `Sẽ xóa ${fmt(count)} bản ghi${partial ? ' còn lại' : ''} do lần insert lúc ${longWhen(entry.startedAt)} (workflow "${entry.workflowName || 'không tên'}") tạo ra:`),
      order.length ? h('p', {}, `${order.map((o) => `${o.sobject} ${fmt(o.n)}`).join(', ')}.${order.length > 1 ? ' Xóa bản ghi con trước, bản ghi cha sau.' : ''}`) : null,
      ...pendingLines([...pending, ...(entry.lostBulkJobs ?? []).map((j) => ({ ...j, idsLost: true }))]).map((t) => h('p', { class: 'hint pending-jobs' }, t)),
      rejectedText(entry) ? h('p', { class: 'hint' }, rejectedText(entry)) : null,
      h('p', { class: 'hint' }, 'Chỉ xóa đúng các Id app đã ghi lúc insert, kể cả bản ghi đã bị sửa sau đó. Bản ghi đã bị xóa trước đó được bỏ qua.'),
      cascade ? h('p', { class: 'hint' }, 'Xóa bản ghi cha có thể làm Salesforce tự xóa bản ghi con của nó (ví dụ Contact, Opportunity của Account), kể cả bản ghi con không do app tạo.') : null,
      h('p', { class: 'hint' }, 'Bản ghi bị xóa vào Thùng rác của org (khôi phục được trong 15 ngày nếu Thùng rác chưa đầy).'),
      canBulk
        ? h('label', { class: 'check-line bulk-check' },
          h('input', { type: 'checkbox', checked: bulk === 'auto', onchange: (e) => { bulk = e.target.checked ? 'auto' : 'off'; render(); } }),
          `Dùng Bulk API 2.0 cho bước từ ${fmt(minBulk)} bản ghi`)
        : null,
      count ? h('p', { class: 'hint delete-calls' }, c.bulk
        ? `Khoảng ${fmt(c.total)} lời gọi API (sObject Collections ${fmt(c.collections)}, Bulk khoảng ${fmt(c.bulk)}), tính vào giới hạn API 24 giờ của org.`
        : `Khoảng ${fmt(c.total)} lời gọi API (200 bản ghi mỗi lời gọi), tính vào giới hạn API 24 giờ của org.`) : null,
      h('p', { class: 'hint' }, 'Có thể bấm "Dừng" bất cứ lúc nào; bản ghi đã xóa nằm trong Thùng rác.'),
      h('div', { class: 'actions' },
        h('button', { class: 'delete-cancel', onclick: () => modal.close() }, 'Hủy'),
        btn),
    ].filter(Boolean));
  };

  async function submit(count) {
    if (sending) return;
    sending = true;
    refusal = null;
    render();
    const body = { confirm: { username: was.username, count, ...(mustType ? { typedOrg: typed.trim() } : {}) }, bulk };
    try {
      await hooks.startDelete({
        hid, body, org: name, total: count, bySobject: entry.remaining?.bySobject ?? {},
        onResponse: () => {
          // The delete runs: the results panel shows it (both dialogs out of the way).
          modal.onclose = null;
          modal.close();
          if (dialog.open) dialog.close();
        },
      });
    } catch (e) {
      // Refused before anything was deleted. A new count (pending Bulk jobs read, or the history
      // changed): show it and ask again — never sent again by itself.
      sending = false;
      if (e.status === 409 && Number.isInteger(e.body?.count)) {
        try {
          entry = await api.historyEntry(hid);
        } catch {
          // keep the old numbers; the count below is the server's
        }
        entry.remaining = { ...(entry.remaining ?? {}), total: e.body.count };
      }
      refusal = e.message;
      if (!modal.open) return;
      render();
      modal.querySelector('.delete-cancel')?.focus();
    }
  }

  render();
  modal.onclose = null;
  modal.showModal();
  modal.querySelector('.delete-cancel').focus();
  return undefined;
}

/** After a delete (or anything that changed the history): an open dialog shows the new state. */
export function historyChanged() {
  if (view && dialog?.open) reload();
  else refreshHistory();
}
