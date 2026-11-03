// Workflow library in the app (design 0012 A): boot (first-start migration, the tab's open item),
// autosave of the open item (quota, two tabs), the "▾" popup next to the name (Ctrl+O) and the
// "Quản lý thư viện" dialog. Storage rules: library.js.

import { h, ico, toast, download, keepToast, releaseToast } from './dom.js';
import { state, setPersistHook, loadWorkflow, updateWorkflow, emptyWorkflow } from './store.js';
import {
  KEYS, readIndex, repairIndex, copyName, migrateToLibrary, saveItem, readItem, exportLibrary, byRecent, trySet,
  usedBytes, RECENT, countSteps, createLibrary, itemKey,
} from './library.js';
import { openPopup, closePopup, popupAnchor } from './popup.js';

const $ = (id) => document.getElementById(id);
const store = window.localStorage;
const session = window.sessionStorage;
const BUSY = 'Đang chạy. Bấm Dừng hoặc chờ chạy xong rồi đổi workflow.';
const LEGACY = 'Chưa tạo được Thư viện vì bộ nhớ trình duyệt đầy. Workflow này vẫn được tự lưu như trước.';

const lib = {
  mode: 'library', // 'library' | 'legacy' (storage full at the first start: one autosave as before)
  unsaved: false, // the last save failed (quota)
  quotaToasted: false,
};
let ctl = createLibrary({ storage: store, now: () => Date.now(), newId: () => newId() }); // open item, pause (library.js)
let isRunning = () => false;
let onOpenFile = () => {};

export const libraryMode = () => lib.mode;

function newId() {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
const setSessionActive = (id) => { try { session.setItem(KEYS.active, id); } catch { /* optional */ } };

/**
 * Before the first render: the workflow this tab shows. deps: { sample, migrateV1 }.
 * → { announce } for main.js (v1 report, v2 moved, broken autosave).
 */
export function bootLibrary({ sample, migrateV1 }) {
  let index = readIndex(store);
  if (!index) {
    const res = migrateToLibrary(store, { sample, migrateV1, now: Date.now(), newId });
    state.workflow = res.workflow;
    if (res.mode === 'legacy') {
      lib.mode = 'legacy';
      return { announce: res.announce, legacy: true };
    }
    ctl = createLibrary({ storage: store, now: () => Date.now(), newId, activeId: res.activeId });
    setSessionActive(res.activeId);
    setPersistHook(save);
    return { announce: res.announce };
  }
  const repaired = repairIndex(index, store);
  index = repaired.index;
  if (repaired.changed) trySet(store, KEYS.index, JSON.stringify(index));
  let wanted = null;
  try { wanted = session.getItem(KEYS.active); } catch { /* optional */ }
  const order = [...new Set([wanted, index.activeId, ...byRecent(index.items).map((it) => it.id)].filter((id) => id && index.items.some((it) => it.id === id)))];
  let opened = null;
  for (const id of order) {
    const r = readItem(store, id);
    if (r.workflow) {
      opened = { id, workflow: r.workflow };
      break;
    }
  }
  if (!opened) {
    const id = newId();
    const wf = structuredClone(sample);
    saveItem(store, id, wf, { now: Date.now() });
    opened = { id, workflow: wf };
  }
  ctl = createLibrary({ storage: store, now: () => Date.now(), newId, activeId: opened.id });
  state.workflow = opened.workflow;
  setSessionActive(opened.id);
  setPersistHook(save);
  return { announce: null };
}

/** The open item could not be shown: a new item with `wf` takes its place (the broken one is kept). */
export function replaceBrokenActive(wf) {
  if (lib.mode !== 'library') return;
  const res = ctl.create(wf);
  if (res.ok) setSessionActive(res.id);
}

/** Autosave of the open item (the store's persist hook). */
function save(wf) {
  const res = ctl.save(wf);
  if (res.paused) return updateIndicator();
  if (!res.ok) return setUnsaved(true, wf);
  if (lib.unsaved) {
    setUnsaved(false);
    toast(`Đã lưu lại "${wf.name || 'Workflow'}".`);
  }
  return undefined;
}

/**
 * The persistent indicator next to the name (review 0012 B1): "Tạm dừng lưu" while another tab's
 * change waits for a choice (reopens it), else "Chưa lưu" when storage is full (opens the library).
 */
function updateIndicator() {
  const btn = $('btn-unsaved');
  if (!btn) return;
  const paused = ctl.isPaused();
  btn.hidden = !paused && !lib.unsaved;
  btn.textContent = paused ? 'Tạm dừng lưu' : 'Chưa lưu';
  btn.title = paused
    ? 'Workflow này vừa được sửa ở một tab khác nên tab này tạm dừng tự lưu. Bấm để chọn giữ bản nào.'
    : 'Chưa lưu được thay đổi vào trình duyệt. Bấm để mở Thư viện.';
  btn.onclick = paused ? showConflict : openManager;
}

function setUnsaved(on, wf) {
  lib.unsaved = on;
  updateIndicator();
  if (on && !lib.quotaToasted) {
    lib.quotaToasted = true;
    toast(`Bộ nhớ trình duyệt đã đầy nên chưa lưu được thay đổi của "${wf?.name || 'Workflow'}". Xóa bớt workflow trong Thư viện, hoặc bấm Lưu (Ctrl+S) để tải file JSON.`, 12000, { label: 'Mở Thư viện', onClick: openManager });
  }
  if (!on) lib.quotaToasted = false;
}

/** beforeunload must ask: unsaved changes, or autosave paused by another tab. */
export const mustWarnOnLeave = () => lib.unsaved || ctl.isPaused();

/** Another tab wrote or deleted the open item (storage event). */
function onStorage(e) {
  if (lib.mode !== 'library' || e.storageArea !== store || !ctl.activeId) return;
  if (e.key !== itemKey(ctl.activeId)) return;
  const name = state.workflow.name || 'Workflow';
  if (e.newValue === null) {
    // Deleted in another tab: this tab keeps it and saves it back.
    save(state.workflow);
    toast(`"${name}" đã bị xóa ở tab khác; tab này vẫn giữ và đã lưu lại.`, 6000);
    return;
  }
  if (e.newValue === JSON.stringify(state.workflow)) return;
  ctl.pause();
  updateIndicator();
  showConflict();
}

/**
 * The choice for a paused item (also from "Tạm dừng lưu"). Both actions do nothing once another
 * item was opened (the pause ended with it); "Dùng bản ở tab kia" waits while a run goes on.
 */
function showConflict() {
  const id = ctl.activeId;
  if (!ctl.isPaused()) return;
  toast(`"${state.workflow.name || 'Workflow'}" vừa được sửa ở một tab khác. Tab này tạm dừng tự lưu tới khi bạn chọn.`, Infinity, [
    {
      label: 'Dùng bản ở tab kia',
      onClick: () => {
        if (ctl.activeId !== id || !ctl.isPaused()) return;
        if (isRunning()) {
          toast(`${BUSY} Rồi bấm "Tạm dừng lưu" để chọn lại.`, 6000);
          return;
        }
        const r = readItem(store, id);
        ctl.resume(id);
        if (r.workflow) loadWorkflow(r.workflow);
        updateIndicator();
      },
    },
    {
      label: 'Giữ bản của tab này',
      onClick: () => {
        if (!ctl.resume(id)) return;
        save(state.workflow);
        updateIndicator();
      },
    },
  ]);
}

/** Toolbar wiring: ▾, Ctrl+O, "Chưa lưu", the running lock. */
export function initLibraryUi({ running, openFile }) {
  isRunning = running;
  onOpenFile = openFile;
  const btn = $('btn-library');
  if (lib.mode === 'legacy') {
    btn.disabled = true;
    btn.title = LEGACY;
  } else btn.onclick = () => (popupAnchor() === btn ? closePopup() : openLibraryMenu());
  updateIndicator();
  window.addEventListener('storage', onStorage);
  window.addEventListener('beforeunload', (e) => {
    if (!mustWarnOnLeave()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/** Locks what would change the workflow while a run goes on (Mới, the popup's rows). */
export function setLibraryBusy(busy) {
  const nb = $('btn-new');
  nb.disabled = busy;
  nb.title = busy ? BUSY : 'Workflow mới (thêm vào Thư viện)';
}

const hhmm = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (same(d, y)) return 'hôm qua';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
};
const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** The ▾ popup (also Ctrl+O): new, open file, recent workflows (radio), manage. */
export function openLibraryMenu() {
  const btn = $('btn-library');
  if (lib.mode !== 'library') return toast(LEGACY, 6000);
  const index = readIndex(store) ?? { items: [] };
  const busy = isRunning();
  const lock = (it) => (busy ? { ...it, disabled: true, title: BUSY } : it);
  const recent = byRecent(index.items);
  const rows = recent.map((it, i) => {
    const r = readItem(store, it.id);
    return lock({
      label: it.name || 'Workflow',
      desc: r.workflow ? `${it.steps ?? countSteps(r.workflow)} bước · ${hhmm(it.updatedAt)}` : 'không mở được',
      checked: it.id === ctl.activeId,
      hiddenUntilSearch: i >= RECENT,
      onSelect: () => switchTo(it.id),
    });
  });
  btn.setAttribute('aria-expanded', 'true');
  openPopup(btn, {
    title: 'Thư viện',
    search: recent.length > 6,
    searchLabel: 'Tìm workflow…',
    items: [
      lock({ label: '+ Workflow mới', onSelect: () => newWorkflow(emptyWorkflow()) }),
      lock({ label: 'Mở file JSON…', onSelect: () => onOpenFile() }),
      { group: 'Gần đây' },
      ...rows,
      { group: 'Thư viện' },
      { label: 'Quản lý thư viện…', onSelect: openManager },
    ],
    onClose: () => btn.setAttribute('aria-expanded', 'false'),
  });
  return undefined;
}

/** Open item `id` (undo reset, no result). A broken item: toast, the open workflow stays. */
export function switchTo(id) {
  if (isRunning()) return toast(BUSY);
  if (id === ctl.activeId) return undefined;
  const r = ctl.open(id);
  if (!r.workflow) {
    return toast(`Không mở được workflow này (${r.error}). Workflow đang mở không đổi. Bấm "Tải bản lưu" để lấy file JSON, sửa rồi Mở file lại.`, 12000,
      r.raw ? { label: 'Tải bản lưu', onClick: () => download('workflow-luu.json', r.raw) } : null);
  }
  setSessionActive(id);
  loadWorkflow(r.workflow);
  updateIndicator();
  return undefined;
}

/**
 * Mới, Mở file, Mẫu: a new item with `wf`, opened. The open item is reused when it is empty and
 * still named "Workflow mới" (no junk items). Legacy mode: replaces the one autosave.
 */
export function newWorkflow(wf) {
  if (isRunning()) return toast(BUSY);
  if (lib.mode !== 'library') {
    loadWorkflow(wf);
    updateWorkflow(() => {}, { history: false }); // persists to sfdg.workflow.v2 as before
    return undefined;
  }
  const cur = state.workflow;
  // Not over an item another tab is editing (paused).
  const reuse = !(cur.steps?.length) && (cur.name ?? 'Workflow mới') === 'Workflow mới' && !ctl.isPaused();
  const res = ctl.create(wf, { reuseId: reuse ? ctl.activeId : null });
  if (!res.ok) {
    setUnsaved(true, wf);
    return toast('Bộ nhớ trình duyệt đã đầy nên chưa tạo được workflow mới. Xóa bớt workflow trong Thư viện hoặc tải file JSON.', 8000, { label: 'Mở Thư viện', onClick: openManager });
  }
  setSessionActive(res.id);
  loadWorkflow(wf);
  updateIndicator();
  return undefined;
}

/** A library file was opened: every workflow becomes a new item (none is opened). */
export function addWorkflows(list) {
  let n = 0;
  for (const wf of list) {
    if (ctl.add(wf)) n++;
  }
  toast(n === list.length ? `Đã thêm ${n} workflow vào thư viện.` : `Đã thêm ${n}/${list.length} workflow vào thư viện; bộ nhớ trình duyệt đã đầy.`, 6000);
}

// ---------- "Quản lý thư viện" ----------

function rename(id, name) {
  if (id === ctl.activeId) {
    updateWorkflow((wf) => { wf.name = name; }, { source: 'library' });
    return;
  }
  const r = readItem(store, id);
  if (r.workflow) saveItem(store, id, { ...r.workflow, name }, { now: Date.now(), activeId: ctl.activeId });
}

function duplicate(id) {
  const r = readItem(store, id);
  const index = readIndex(store);
  if (!r.workflow || !index) return;
  const name = copyName(r.workflow.name || 'Workflow', index.items.map((it) => it.name));
  const copyId = newId();
  const res = saveItem(store, copyId, { ...r.workflow, name }, { now: Date.now(), activeId: ctl.activeId });
  if (!res.ok) return toast('Bộ nhớ trình duyệt đã đầy nên chưa nhân bản được.', 6000);
  // Right below the original in the list (same edit time; the copy comes after it).
  const orig = res.index.items.find((it) => it.id === id);
  const copy = res.index.items.find((it) => it.id === copyId);
  if (orig && copy) {
    copy.updatedAt = orig.updatedAt;
    trySet(store, KEYS.index, JSON.stringify(res.index));
  }
  return undefined;
}

function remove(id) {
  // The open workflow cannot go while a run uses it (review 0012 S1).
  if (id === ctl.activeId && isRunning()) return toast(BUSY);
  const name = readIndex(store)?.items.find((it) => it.id === id)?.name ?? 'Workflow';
  const res = ctl.remove(id, { empty: emptyWorkflow() });
  if (!res.ok) {
    return toast(res.error === 'quota' ? 'Bộ nhớ trình duyệt đã đầy nên chưa xóa được workflow đang mở (không tạo được workflow thay nó). Xóa một workflow khác trước.' : 'Workflow này không còn trong thư viện.', 6000);
  }
  if (res.opened) {
    setSessionActive(res.opened.id);
    loadWorkflow(res.opened.workflow);
    updateIndicator();
  }
  // The undo keeps the item and its JSON in memory: it works even when the trash was not written.
  toast(`Đã xóa workflow "${name}".`, 10000, { label: 'Hoàn tác', onClick: () => restoreDeleted(res.undo) });
  return undefined;
}

function restoreDeleted(undo) {
  const res = ctl.restore(undo);
  if (!res.ok) return toast('Bộ nhớ trình duyệt đã đầy nên chưa hoàn tác được. Xóa bớt workflow khác rồi tải lại file JSON nếu cần.', 8000, { label: 'Tải bản đã xóa', onClick: () => download('workflow-da-xoa.json', undo.raw) });
  toast(`Đã khôi phục "${undo.item.name}".`);
  if ($('modal').open && $('modal').dataset.dialog === 'library') openManager();
  return undefined;
}

/** "Quản lý thư viện…" (also the "Chưa lưu" button): rename, duplicate, download, delete. */
export function openManager() {
  const modal = $('modal');
  closePopup();
  const index = readIndex(store) ?? { items: [] };
  const rows = byRecent(index.items).map((it) => {
    const r = readItem(store, it.id);
    const name = h('input', {
      value: it.name, 'aria-label': 'Tên workflow', class: 'lib-name',
      onchange: (e) => { rename(it.id, e.target.value.trim() || 'Workflow'); },
    });
    const dl = () => r.workflow && download(`${(r.workflow.name || 'workflow').replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(r.workflow, null, 2));
    const act = (label, onclick, attrs = {}) => h('button', { onclick, ...attrs }, label);
    const more = h('button', {
      class: 'icon lib-more', title: 'Thao tác khác', 'aria-label': `Thao tác khác với "${it.name}"`, 'aria-haspopup': 'menu',
      onclick: () => openPopup(more, { title: it.name, items: [
        { label: 'Nhân bản', onSelect: () => { duplicate(it.id); openManager(); } },
        { label: 'Tải JSON', disabled: !r.workflow, onSelect: dl },
        { label: 'Xóa', danger: true, disabled: it.id === ctl.activeId && isRunning(), title: it.id === ctl.activeId && isRunning() ? BUSY : undefined, onSelect: () => { remove(it.id); openManager(); } },
      ] }),
    }, ico('more'));
    return h('div', { class: `lib-row${it.id === ctl.activeId ? ' active' : ''}`, role: 'row', 'data-id': it.id },
      h('span', { role: 'cell', class: 'lib-cell-name' }, name),
      h('span', { role: 'cell', class: 'lib-meta' }, r.workflow ? `${it.steps ?? countSteps(r.workflow)} bước · ${hhmm(it.updatedAt)} · ${kb(it.bytes ?? 0)}` : 'không mở được'),
      h('span', { role: 'cell', class: 'lib-actions' },
        act('Mở', () => { modal.close(); switchTo(it.id); }, { disabled: it.id === ctl.activeId || isRunning() || !r.workflow, title: isRunning() ? BUSY : undefined }),
        act('Nhân bản', () => { duplicate(it.id); openManager(); }, { class: 'lib-wide' }),
        act('Tải JSON', dl, { class: 'lib-wide', disabled: !r.workflow }),
        act('Xóa', () => { remove(it.id); openManager(); }, { class: 'danger lib-wide', disabled: it.id === ctl.activeId && isRunning(), title: it.id === ctl.activeId && isRunning() ? BUSY : undefined }),
        more));
  });
  const used = usedBytes(store) / 1048576;
  modal.dataset.dialog = 'library';
  modal.replaceChildren(
    h('h2', {}, 'Thư viện workflow'),
    h('div', { class: 'lib-table', role: 'table', 'aria-label': 'Các workflow trong thư viện' },
      h('div', { class: 'lib-row lib-head', role: 'row' }, h('span', { role: 'columnheader' }, 'Tên'), h('span', { role: 'columnheader' }, 'Bước · Sửa lúc · Dung lượng'), h('span', { role: 'columnheader' }, '')),
      rows),
    h('p', { class: 'hint lib-where' }, `Lưu trong trình duyệt này (${location.origin}); địa chỉ khác (ví dụ localhost thay cho 127.0.0.1) có thư viện riêng. Đã dùng ${used.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB / khoảng 5 MB.`),
    h('div', { class: 'actions' },
      h('button', { onclick: () => download(`sfdg-library-${new Date().toISOString().slice(0, 10)}.json`, exportLibrary(store, readIndex(store) ?? { items: [] }, new Date().toISOString())) }, 'Tải tất cả (JSON)'),
      h('button', { class: 'primary', onclick: () => modal.close() }, 'Đóng')),
  );
  modal.onclose = () => {
    delete modal.dataset.dialog;
    releaseToast();
  };
  if (!modal.open) modal.showModal();
  keepToast(modal);
}
