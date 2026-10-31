// Workflow library, the UI (design 0012 A): the ▾ popup next to the name (Ctrl+O), the "Quản lý
// thư viện" dialog, Mới / Mở file / Mẫu as new entries, autosave of the open entry, the storage-full
// state (▲ Chưa lưu), two tabs on one workflow, and the first-run migration of the old autosave.
// Storage itself is library.js.

import { h, toast, download } from './dom.js';
import { state, openWorkflow, replaceWorkflow, persist, setPersistHandler, updateWorkflow, emptyWorkflow } from './store.js';
import {
  createLibrary, migrateToLibrary, parseLibraryFile, sortedItems, ENTRY_PREFIX, NEW_NAME, RECENT_MAX,
} from './library.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';
import { SAMPLES } from './samples.js';

const $ = (id) => document.getElementById(id);
const LOCKED_TITLE = 'Đang chạy. Bấm Dừng hoặc chờ chạy xong rồi đổi workflow.';
const LEGACY_TITLE = 'Chưa tạo được Thư viện vì bộ nhớ trình duyệt đầy. Workflow này vẫn được tự lưu như trước.';

let lib = null;
let legacy = false; // storage full on the first run: the single autosave of before
let activeId = null;
let locked = false; // a run is going on
let lastJson = null; // what this tab last wrote into its entry (to tell our writes from another tab's)
let unsaved = false; // the last save failed: storage full
let paused = false; // another tab changed the open entry: autosave waits for the user's choice
let undoNote = null; // { text, undo } of the last delete, for 10 s (the dialog's own "Hoàn tác")
let deps = {}; // { onMigrated(report, raw, name), fileBase(name) } from main.js

const fileBase = (name) => (name || 'workflow').replace(/[^\w.-]+/g, '_');
const fmtBytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`);

/** `10:24` today, `hôm qua`, else `21/10`. */
export function whenText(ts, now = new Date()) {
  const d = new Date(ts);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'hôm qua';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const libraryReady = () => Boolean(lib) && !legacy;

/**
 * Before the first render: the library (made from the old autosave on the first run) and the
 * workflow to show. → a function to call once the app is drawn (toasts, the migration report).
 */
export function initLibrary(options) {
  deps = options;
  lib = createLibrary({ local: localStorage, session: sessionStorage });
  let res;
  try {
    res = migrateToLibrary(lib, localStorage, { samples: SAMPLES, migrateV1: options.migrateV1 });
  } catch (e) {
    console.error(e);
    res = { status: 'legacy', workflow: structuredClone(SAMPLES[0].workflow), from: 'sample' };
  }
  wireTopBar();
  const after = [];
  if (res.from === 'v2' && res.status === 'migrated') {
    after.push(() => toast('Workflow đang soạn đã được đưa vào Thư viện (nút ▾ cạnh tên). Bản lưu cũ vẫn được giữ trong trình duyệt.', 8000));
  }
  if (res.from === 'v1') after.push(() => deps.onMigrated(res.report, res.rawV1, res.workflow.name));
  if (res.v1Error) after.push(() => toast(`Không chuyển được workflow cũ trong trình duyệt (${res.v1Error}). Bản cũ vẫn được giữ nguyên.`, 6000));
  if (res.from === 'broken') {
    after.push(() => toast(
      `Không hiển thị được workflow lưu tự động (${res.brokenError}). Đang mở mẫu "${SAMPLES[0].label}"; bản lưu cũ chưa bị ghi đè${res.brokenKey ? ` và có bản sao trong trình duyệt (${res.brokenKey})` : res.brokenOlder ? ' (bản sao cũ hơn ở sfdg.workflow.v2.broken cũng được giữ nguyên)' : ''}. Bấm "Tải bản lưu" để lấy file JSON, sửa rồi Mở lại.`,
      15000,
      { label: 'Tải bản lưu', onClick: () => download('workflow-autosave.json', res.brokenRaw) },
    ));
  }
  if (res.status === 'legacy') {
    legacy = true;
    state.workflow = res.workflow;
    if (res.from === 'v1') persist(); // as before the library: the migrated v1 becomes the v2 autosave
    const btn = $('btn-library');
    btn.disabled = true;
    btn.title = LEGACY_TITLE;
    return () => after.forEach((f) => f());
  }
  setPersistHandler(save);
  state.workflow = startWorkflow(res, after);
  window.addEventListener('storage', onStorage);
  window.addEventListener('beforeunload', (e) => {
    // Storage full, or another tab's version not chosen yet: leaving would lose this tab's changes.
    if (!unsaved && !paused) return;
    e.preventDefault();
    e.returnValue = '';
  });
  return () => after.forEach((f) => f());
}

/** The entry to open at start: this tab's, else the last opened, else the newest readable one. */
function startWorkflow(res, after) {
  if (res.status === 'migrated') {
    activeId = res.id;
    lastJson = lib.raw(activeId);
    return res.workflow;
  }
  const first = lib.activeId();
  for (const id of [first, ...lib.items().map((it) => it.id)]) {
    if (!id) continue;
    const r = lib.read(id);
    if (!r.workflow) {
      if (id === first) after.push(() => brokenToast(lib.item(id), r));
      continue;
    }
    activeId = id;
    lib.setActive(id);
    lastJson = lib.raw(id);
    return r.workflow;
  }
  // Nothing readable: a new entry with the first sample.
  const wf = structuredClone(SAMPLES[0].workflow);
  try {
    activeId = lib.create(wf);
    lib.setActive(activeId);
    lastJson = lib.raw(activeId);
  } catch {
    activeId = null;
  }
  return wf;
}

function brokenToast(item, r) {
  toast(
    `Không mở được workflow "${item?.name ?? '?'}" (${r.error}). Workflow đang mở không đổi. Bấm "Tải bản lưu" để lấy file JSON, sửa rồi Mở lại.`,
    12000,
    r.raw ? { label: 'Tải bản lưu', onClick: () => download(`${fileBase(item?.name)}-hong.json`, r.raw) } : null,
  );
}

// ---------- autosave of the open entry ----------

let unsavedToastShown = false;
function save(wf) {
  if (paused) return;
  if (!activeId) {
    // No entry yet (storage was full when the tab started): try to make one now.
    try {
      activeId = lib.create(wf);
      lib.setActive(activeId);
    } catch {
      return markUnsaved(wf);
    }
  }
  const res = lib.save(activeId, wf);
  if (!res.ok) return markUnsaved(wf);
  lastJson = res.json;
  if (res.readded) toast(`"${wf.name || NEW_NAME}" đã bị xóa ở tab khác; tab này vẫn giữ và đã lưu lại.`, 6000);
  if (unsaved) {
    unsaved = false;
    unsavedToastShown = false;
    updateIndicator();
    toast(`Đã lưu lại "${wf.name || NEW_NAME}".`);
  }
  return undefined;
}

/**
 * The top bar's ▲ button: "▲ Chưa lưu" (storage full: opens the library dialog) or "▲ Tab khác đã
 * sửa" (autosave paused: the two choices again). Changes are read out by the #save-status region.
 */
function updateIndicator() {
  const b = $('btn-unsaved');
  const text = paused ? '▲ Tab khác đã sửa' : unsaved ? '▲ Chưa lưu' : '';
  b.hidden = !text;
  if (!text) return say('');
  b.textContent = text;
  b.title = paused
    ? 'Workflow này vừa được sửa ở một tab khác nên tab này tạm dừng tự lưu. Bấm để chọn giữ bản nào.'
    : 'Bộ nhớ trình duyệt đầy: thay đổi chưa được lưu. Bấm để mở Thư viện và xóa bớt workflow.';
  return say(paused ? 'Tạm dừng tự lưu: workflow vừa được sửa ở một tab khác.' : 'Chưa lưu: bộ nhớ trình duyệt đã đầy.');
}

function say(text) {
  const live = $('save-status');
  if (live && live.textContent !== text) live.textContent = text;
}

function markUnsaved(wf) {
  unsaved = true;
  updateIndicator();
  if (unsavedToastShown) return;
  unsavedToastShown = true;
  toast(
    `Bộ nhớ trình duyệt đã đầy nên chưa lưu được thay đổi của "${wf.name || NEW_NAME}". Xóa bớt workflow trong Thư viện, hoặc bấm Lưu (Ctrl+S) để tải file JSON.`,
    12000,
    { label: 'Mở Thư viện', onClick: openManage },
  );
}

/** Another tab wrote this tab's entry: stop saving until the user picks a version. */
function onStorage(e) {
  if (e.storageArea !== localStorage || !e.key?.startsWith(ENTRY_PREFIX)) return;
  lib.repair(); // entries added or removed by another tab: keep the index right
  if (!activeId || e.key !== `${ENTRY_PREFIX}${activeId}`) return;
  if (e.newValue === null || e.newValue === lastJson) return; // deleted elsewhere: the next save adds it back
  paused = true;
  updateIndicator();
  conflictToast();
}

/** [Dùng bản ở tab kia] [Giữ bản của tab này], for the entry open now (a later switch makes it stale). */
function conflictToast() {
  const id = activeId;
  const name = state.workflow.name || NEW_NAME;
  const stillHere = () => {
    if (id === activeId && paused) return true;
    toast('Workflow đó không còn mở ở tab này; không có gì để chọn.', 4000);
    return false;
  };
  toast(`"${name}" vừa được sửa ở một tab khác.`, Infinity, [
    {
      label: 'Dùng bản ở tab kia',
      onClick: () => {
        if (!stillHere()) return;
        const r = lib.read(id);
        if (!r.workflow) return brokenToast(lib.item(id), r);
        show(id, r.workflow);
        return undefined;
      },
    },
    {
      label: 'Giữ bản của tab này',
      onClick: () => {
        if (!stillHere()) return;
        paused = false;
        updateIndicator();
        persist();
      },
    },
  ]);
}

/**
 * Before leaving the open workflow while its changes are not saved (storage full, or paused by
 * another tab's change): ask, and offer the JSON file. → Promise<boolean> (go on).
 */
function confirmLeave() {
  const modal = $('modal');
  if (modal.open) modal.close();
  const name = state.workflow.name || NEW_NAME;
  const why = paused
    ? `"${name}" vừa được sửa ở một tab khác và tab này đã tạm dừng tự lưu: thay đổi của tab này chưa được lưu.`
    : `Bộ nhớ trình duyệt đầy nên thay đổi của "${name}" chưa được lưu.`;
  return new Promise((resolve) => {
    const done = (v) => { modal.onclose = null; modal.close(); resolve(v); };
    modal.replaceChildren(
      h('h2', {}, 'Đổi workflow khi chưa lưu?'),
      h('p', {}, `${why} Đổi sang workflow khác thì các thay đổi đó mất. Bấm "Tải file JSON" để giữ một bản trên máy trước.`),
      h('div', { class: 'actions' },
        h('button', { onclick: () => download(`${fileBase(state.workflow.name)}.json`, JSON.stringify(state.workflow, null, 2)) }, 'Tải file JSON'),
        h('button', { onclick: () => done(false) }, 'Hủy'),
        h('button', { class: 'danger solid', onclick: () => done(true) }, 'Vẫn đổi')),
    );
    modal.onclose = () => resolve(false);
    modal.showModal();
    modal.querySelector('.actions button:nth-child(2)')?.focus();
  });
}

// ---------- open, new, switch ----------

/** A run is going on: the workflow cannot be switched (main.js). */
export function setLibraryLocked(on) {
  locked = on;
  const btn = $('btn-new');
  btn.disabled = on;
  btn.title = on ? LOCKED_TITLE : 'Workflow mới';
  if (on && popupAnchor() === $('btn-library')) closePopup();
}

// The open entry is reused only when empty, still named "Workflow mới", and not waiting for a
// choice between this tab and another one (its stored version may have content).
const reusable = () => !paused && !state.workflow.steps?.length && (state.workflow.name ?? '') === NEW_NAME;

/**
 * Mới / Mở file / Mẫu (design 0012 A): `wf` opens as a new entry, never over another workflow,
 * except the open one when it is empty and still named "Workflow mới". → true when opened.
 */
export async function openAsNew(wf) {
  if (locked) {
    toast(LOCKED_TITLE);
    return false;
  }
  // (No await unless there is something to lose: otherwise this runs to the end synchronously.)
  if (!legacy && (unsaved || paused) && !(await confirmLeave())) return false;
  if (legacy) {
    // The single autosave of before: replaced in place, with a question (and Ctrl+Z).
    if (state.workflow.steps?.length && !confirm('Thay workflow hiện tại? (Vẫn có thể hoàn tác bằng Ctrl+Z)')) return false;
    replaceWorkflow(wf);
    return true;
  }
  if (activeId && reusable()) {
    openWorkflow(wf);
    persist();
    return true;
  }
  let id;
  try {
    id = lib.create(wf);
  } catch {
    toast('Bộ nhớ trình duyệt đã đầy nên chưa tạo được workflow mới. Xóa bớt workflow trong Thư viện rồi thử lại.', 8000, { label: 'Mở Thư viện', onClick: openManage });
    return false;
  }
  show(id, wf);
  return true;
}

function show(id, wf) {
  activeId = id;
  lib.setActive(id);
  lastJson = lib.raw(id);
  paused = false;
  unsaved = false;
  unsavedToastShown = false;
  updateIndicator();
  openWorkflow(wf);
}

/** Open entry `id` of the library. */
export async function switchTo(id) {
  if (locked) return toast(LOCKED_TITLE);
  if (id === activeId) return undefined;
  const r = lib.read(id);
  if (!r.workflow) return brokenToast(lib.item(id), r);
  if ((unsaved || paused) && !(await confirmLeave())) return undefined;
  show(id, r.workflow);
  return undefined;
}

/** "Mở file JSON…" with a library file: every workflow becomes a new entry (nothing opened). */
export function importLibraryFile(data) {
  const file = parseLibraryFile(data);
  if (!file) return false;
  if (legacy) {
    toast(LEGACY_TITLE, 6000);
    return true;
  }
  let n = 0;
  for (const wf of file.workflows) {
    try {
      lib.create(wf);
      n++;
    } catch {
      toast(`Bộ nhớ trình duyệt đã đầy: mới thêm được ${n}/${file.workflows.length} workflow vào thư viện. Xóa bớt workflow rồi mở lại file.`, 8000);
      return true;
    }
  }
  const skipped = [
    file.v1 ? `${file.v1} workflow version 1 (lưu từng workflow ra file rồi Mở file JSON… để chuyển)` : '',
    file.broken ? `${file.broken} mục không phải workflow hợp lệ` : '',
  ].filter(Boolean).join(' và ');
  toast(`${n ? `Đã thêm ${n} workflow vào thư viện.` : 'File thư viện không có workflow nào mở được.'}${skipped ? ` Bỏ qua ${skipped}.` : ''}`, skipped ? 8000 : 5000);
  return true;
}

// ---------- top bar: ▾, ▲ Chưa lưu ----------

function wireTopBar() {
  const btn = $('btn-library');
  btn.onclick = () => (popupAnchor() === btn ? closePopup() : openLibraryMenu());
  $('btn-unsaved').onclick = () => (paused ? conflictToast() : openManage());
}

/** The ▾ popup (also Ctrl+O). */
export function openLibraryMenu() {
  const btn = $('btn-library');
  if (!libraryReady()) {
    toast(LEGACY_TITLE, 6000);
    return;
  }
  const items = sortedItems(lib.repair());
  const lock = locked ? { disabled: true, title: LOCKED_TITLE } : {};
  const rows = items.map((it, i) => {
    return {
      label: it.name,
      // `broken` is cached in the index (set when an entry could not be read): no parsing here.
      desc: it.broken ? 'không mở được' : `${it.steps} bước · ${whenText(it.updatedAt)}`,
      checked: it.id === activeId,
      searchOnly: i >= RECENT_MAX,
      ...lock,
      onSelect: () => switchTo(it.id),
    };
  });
  btn.setAttribute('aria-expanded', 'true');
  openPopup(btn, {
    title: 'Thư viện',
    search: items.length > 6,
    searchLabel: 'Tìm workflow…',
    items: [
      { label: '＋ Workflow mới', ...lock, onSelect: () => openAsNew(emptyWorkflow()) },
      { label: '⇪ Mở file JSON…', ...lock, onSelect: () => $('file-input').click() },
      { group: 'Gần đây' },
      ...rows,
      { separator: true },
      { label: 'Quản lý thư viện…', onSelect: openManage },
    ],
    onClose: () => btn.setAttribute('aria-expanded', 'false'),
  });
}

// ---------- "Quản lý thư viện" ----------

export function openManage() {
  if (!libraryReady()) return;
  lib.repair();
  const modal = $('modal');
  const render = () => {
    const items = lib.items();
    const rowEl = (it) => {
      const isOpen = it.id === activeId;
      const actions = [
        { label: 'Nhân bản', onSelect: () => { duplicate(it.id); render(); } },
        { label: 'Tải JSON', onSelect: () => { const raw = lib.raw(it.id); if (raw) download(`${fileBase(it.name)}.json`, JSON.stringify(JSON.parse(raw), null, 2)); } },
        { label: 'Xóa', danger: true, onSelect: () => remove(it, render) },
      ];
      return h('li', { class: `lib-row${isOpen ? ' is-open' : ''}`, 'data-id': it.id },
        h('input', {
          class: 'lib-name',
          value: it.name,
          'aria-label': 'Tên workflow',
          onchange: (e) => rename(it.id, e.target.value.trim() || NEW_NAME),
        }),
        h('span', { class: 'lib-meta' }, `${it.steps} bước · ${whenText(it.updatedAt)} · ${fmtBytes(it.bytes)}`),
        h('span', { class: 'lib-actions' },
          h('button', { disabled: isOpen || locked, title: isOpen ? 'Workflow này đang mở.' : locked ? LOCKED_TITLE : undefined, onclick: () => { modal.close(); switchTo(it.id); } }, 'Mở'),
          ...actions.map((a) => h('button', { class: `lib-wide${a.danger ? ' danger' : ''}`, onclick: a.onSelect }, a.label)),
          h('button', {
            class: 'icon lib-more',
            'aria-label': `Thao tác khác với "${it.name}"`,
            'aria-haspopup': 'menu',
            onclick: (e) => openPopup(e.currentTarget, { title: it.name, items: actions }),
          }, '⋯')));
    };
    const used = lib.usage();
    modal.replaceChildren(...[
      h('h2', {}, 'Thư viện workflow'),
      undoNote ? h('p', { class: 'lib-undo', role: 'status' }, undoNote.text, ' ', h('button', { onclick: undoNote.undo }, 'Hoàn tác')) : null,
      h('ul', { class: 'lib-list', 'aria-label': 'Các workflow trong thư viện' }, items.map(rowEl)),
      h('p', { class: 'hint' }, `Lưu trong trình duyệt này (${location.origin}): mở bằng địa chỉ khác (ví dụ localhost thay cho 127.0.0.1) là một thư viện khác. Đã dùng khoảng ${fmtBytes(used)} / 5 MB (trình duyệt tính theo số ký tự).`),
      h('div', { class: 'actions' },
        h('button', { onclick: () => download(`sfdg-library-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(lib.exportAll(), null, 2)) }, 'Tải tất cả (JSON)'),
        h('button', { class: 'primary', onclick: () => modal.close() }, 'Đóng')),
    ].filter(Boolean));
  };
  render();
  modal.onclose = null;
  if (!modal.open) modal.showModal();
}

function duplicate(id) {
  try {
    lib.duplicate(id);
  } catch {
    toast('Bộ nhớ trình duyệt đã đầy nên chưa nhân bản được. Xóa bớt workflow rồi thử lại.', 6000);
  }
}

function rename(id, name) {
  if (id === activeId) {
    // Like typing in the name field: one undo step, the top bar follows.
    updateWorkflow((wf) => { wf.name = name; }, { source: 'app' });
  } else {
    try {
      lib.rename(id, name);
    } catch {
      toast('Bộ nhớ trình duyệt đã đầy nên chưa đổi được tên.', 5000);
    }
  }
}

function remove(item, render) {
  if (locked && item.id === activeId) return toast(LOCKED_TITLE);
  lib.remove(item.id);
  if (item.id === activeId) {
    const next = lib.items().find((it) => lib.read(it.id).workflow);
    if (next) show(next.id, lib.read(next.id).workflow);
    else {
      const wf = emptyWorkflow();
      try {
        show(lib.create(wf), wf);
      } catch {
        activeId = null;
        openWorkflow(wf);
      }
    }
  }
  const undo = () => {
    undoNote = null;
    if (lib.restoreTrash() === null) toast('Không hoàn tác được: workflow đã xóa không còn trong thùng rác.', 5000);
    if ($('modal').open) render();
  };
  // The dialog is modal (the toast behind it cannot be clicked): the undo is also a line in it.
  const note = { text: `Đã xóa workflow "${item.name}".`, undo };
  undoNote = note;
  setTimeout(() => {
    lib.clearTrash(item.id); // the undo time is over: the copy no longer takes room
    if (undoNote !== note) return;
    undoNote = null;
    if ($('modal').open) render();
  }, 10000);
  if ($('modal').open) render();
  toast(note.text, 10000, { label: 'Hoàn tác', onClick: undo });
  return undefined;
}
