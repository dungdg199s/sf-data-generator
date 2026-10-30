// Right-hand panel: configuration for the selected step, or workflow settings and tips when
// the Start card (or nothing) is selected. It is the only place where configuration is edited.
// Edits made here emit source 'inspector' and do not trigger a re-render, so focus survives
// typing; structural edits (add/remove/reorder fields) use 'inspector-structure'.
// On narrow screens the panel is a bottom sheet (.inspector.open, body.sheet-open) shown while a
// step is selected (design 0009 §3).

import { h, toast, icoTile } from './dom.js';
import { renderOptions } from './forms.js';
import { api } from './api.js';
import {
  state, subscribe, select, updateWorkflow, stepById, nodeType, fieldType, suggestAlias, currentScope, slotKeys,
  suggestPoolAlias, suggestPickAlias, queryResultOf,
} from './store.js';
import { setStepAlias, renameField, insertStep } from '/shared/workflow-tree.js';
import { refChoices, refsToRecords, referenceOptions, exposesList } from '/shared/scope.js';
import { buildSoql, QUERY_DEFAULTS, SAMPLE_ROWS, addSelectField } from '/shared/soql.js';
import { deleteStep, duplicateStep, toggleDisabled, newStep, fillEach, reveal, recordPresetFields, recordPreset } from './ops.js';
import { START_ID } from './layout.js';
import { placesText } from './variables.js';
import { applySuggestion, closePicker } from './var-picker.js';

let root;
const expanded = new Set(); // `${stepId}:${fieldIndex}` with options panel open
let sheetClosed = false; // narrow screens: "‹ Xong" hides the sheet but keeps the selection
let lastSelectionKey = null;
// Last good alias per step: references wait there while the alias field is empty or clashing.
const aliasMemo = new Map();

export function initInspector() {
  root = document.getElementById('inspector');
  wireSheet();
  subscribe(({ source, kind }) => {
    if (kind === 'issues') return markIssues();
    if (kind === 'view' || kind === 'result') return undefined;
    if (source === 'inspector') return undefined;
    render();
  });
  // The first render is done by main.js (emit 'all'), which can recover from a broken autosave.
}

/** Select a step and open the options of one of its fields (field chips on the cards). */
export function openField(stepId, index) {
  expanded.add(`${stepId}:${index}`);
  select({ kind: 'step', id: stepId });
  requestAnimationFrame(() => root.querySelectorAll('.field-card')[index]?.scrollIntoView({ block: 'nearest' }));
}

function render() {
  const s = state.selection;
  const step = s?.kind === 'step' ? stepById(s.id) : null;
  const key = step ? `step:${step.id}` : s?.kind ?? 'none';
  if (key !== lastSelectionKey) sheetClosed = false;
  lastSelectionKey = key;
  // The "‹ Xong" row sticks to the top of the sheet, so it closes without scrolling back up.
  const head = h('div', { class: 'sheet-head' }, h('button', { class: 'sheet-close', title: 'Đóng bảng cấu hình (vẫn giữ bước đang chọn)', onclick: closeSheet }, '‹ Xong'));
  root.replaceChildren(head, step ? renderStep(step) : renderWorkflow());
  setSheetOpen(Boolean(s) && !sheetClosed);
  markIssues();
}

const NARROW = window.matchMedia('(max-width: 900px)');
const narrow = () => NARROW.matches;

/**
 * Narrow screens (design 0009 §3): the inspector is a bottom sheet while something is selected.
 * Only applied on narrow screens (a selection on a wide screen does not pop a sheet open when
 * the window gets narrower). While the sheet is closed it is `inert`, so focus and typing can
 * never reach the hidden form. `body.sheet-open` gives the canvas a scroll padding equal to the
 * part of it the sheet covers (measured: the canvas ends above the results header and the
 * issues bar), so the selected card is scrolled to just above the sheet's edge.
 */
function setSheetOpen(open) {
  open = open && narrow();
  const was = root.classList.contains('open');
  // Closing while focus is in the sheet (Ctrl+Enter in a field, "‹ Xong"): focus goes to the
  // selected card, never left in a hidden form.
  if (!open && was && root.contains(document.activeElement)) {
    (document.querySelector('.view-wrap .step-card.selected') ?? document.getElementById('btn-preview'))?.focus({ preventScroll: true });
  }
  root.classList.toggle('open', open);
  root.inert = narrow() && !open;
  document.body.classList.toggle('sheet-open', open);
  if (open) updateSheetOverlap();
  if (open && !was) {
    // The selected card just above the sheet's edge, in either view (Sơ đồ pans, Quy trình scrolls).
    requestAnimationFrame(() => {
      const sel = state.selection;
      if (sel) reveal(sel.kind === 'step' ? sel.id : START_ID, { focus: false, block: 'nearest' });
    });
  }
}

/** --sheet-overlap: how much of the canvas the open sheet covers (scroll padding, end spacer). */
function updateSheetOverlap() {
  if (!document.body.classList.contains('sheet-open')) return;
  const canvas = document.querySelector('.view-wrap > .view:not([hidden])').getBoundingClientRect();
  // offsetHeight ignores the slide-in transform, so this is the sheet's final position.
  const sheetTop = window.innerHeight - root.offsetHeight;
  document.body.style.setProperty('--sheet-overlap', `${Math.max(0, Math.round(canvas.bottom - sheetTop))}px`);
}

function wireSheet() {
  // Wider than 900 px: no sheet, nothing inert. Narrower: the sheet starts closed.
  NARROW.addEventListener('change', () => {
    if (narrow()) sheetClosed = true;
    setSheetOpen(false);
  });
  window.addEventListener('resize', updateSheetOverlap);
  // The canvas changes height when the issues bar appears or grows.
  const views = new ResizeObserver(updateSheetOverlap);
  for (const v of document.querySelectorAll('.view-wrap > .view')) views.observe(v);
  root.inert = narrow();
}

/** "‹ Xong", or a run started on a narrow screen: hide the sheet, keep the selection. */
export function closeSheet() {
  sheetClosed = true;
  setSheetOpen(false);
}

/** Show the sheet again for the current selection (a run failed on validation: goToIssue). */
export function openSheet() {
  sheetClosed = false;
  setSheetOpen(Boolean(state.selection));
}

function renderWorkflow() {
  return h(
    'div',
    {},
    h('div', { class: 'node-head', 'data-type': 'start' }, icoTile(), h('h2', {}, 'Bắt đầu')),
    h('h3', {}, 'Bắt đầu nhanh'),
    h(
      'ol',
      { class: 'hint' },
      h('li', {}, 'Bấm "+ Thêm bước đầu tiên" hoặc Record ở cột trái.'),
      h('li', {}, 'Chọn org ở thanh trên rồi "Import từ org…" để lấy field có sẵn.'),
      h('li', {}, 'Bấm ▶ Xem trước (Ctrl+Enter) để kiểm tra dữ liệu trước khi insert.'),
    ),
    h('h3', {}, 'Phím tắt'),
    h(
      'ul',
      { class: 'hint shortcuts' },
      h('li', {}, '↑ / ↓: chọn bước trước / sau; ← / →: thu gọn / mở khung'),
      h('li', {}, '/: thêm bước ở vị trí mặc định'),
      h('li', {}, 'Alt+↑ / Alt+↓: di chuyển bước'),
      h('li', {}, 'Ctrl+D: nhân bản; Ctrl+/: tắt / bật bước'),
      h('li', {}, 'Delete: xóa bước (khung có bước con thì hỏi)'),
      h('li', {}, 'Enter: sửa bước đang chọn; Esc: quay lại danh sách'),
      h('li', {}, 'Ctrl+Z / Ctrl+Shift+Z: hoàn tác / làm lại'),
      h('li', {}, 'Ctrl+S: tải workflow JSON; Ctrl+Enter: xem trước'),
      h('li', {}, 'Ctrl+Shift+Enter: đọc lại org cho các bước Query rồi xem trước'),
      h('li', {}, 'F8 / Shift+F8: tới lỗi hoặc cảnh báo tiếp theo / trước đó'),
      h('li', {}, 'M: đổi chế độ xem Quy trình / Sơ đồ. Trong Sơ đồ: kéo nền hoặc cuộn để di chuyển, Ctrl + cuộn hoặc + / − để thu phóng, 0: vừa khung'),
    ),
    h('h3', {}, 'Workflow'),
    renderOptions(
      [{ key: 'maxRecords', label: 'Giới hạn bản ghi mỗi lần chạy', kind: 'integer', default: state.meta?.limits.maxRecordsDefault, min: 1, max: state.meta?.limits.maxRecordsHard, help: 'Chặn workflow lỡ tay sinh quá nhiều dữ liệu.' }],
      state.workflow.settings ?? {},
      (key, v) => updateWorkflow((wf) => {
        wf.settings = { ...(wf.settings ?? {}), [key]: v };
      }, { source: 'inspector', coalesceKey: 'settings' }),
    ),
  );
}

function renderStep(step) {
  const type = nodeType(step.type);
  const wrap = h(
    'div',
    {},
    h(
      'div',
      { class: 'node-head', 'data-type': step.type },
      icoTile(),
      h('h2', {}, type?.label ?? step.type),
      step.disabled ? h('span', { class: 'tag-off', title: 'Bước này đang tắt: không chạy và không được kiểm tra.' }, 'Đã tắt') : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon', title: step.disabled ? 'Bật bước (Ctrl+/)' : 'Tắt bước (Ctrl+/)', onclick: () => toggleDisabled(step.id) }, step.disabled ? '◉' : '⊘'),
      h('button', { class: 'icon', title: 'Nhân bản (Ctrl+D)', onclick: () => duplicateStep(step.id) }, '⧉'),
      h('button', { class: 'icon danger', title: 'Xóa (Delete)', onclick: () => deleteStep(step.id) }, '✕'),
    ),
    h('p', { class: 'desc' }, type?.description ?? ''),
    step.disabled ? h('div', { class: 'warn-box' }, 'Bước này đang tắt nên không chạy và không được kiểm tra. Bấm Ctrl+/ để bật lại.') : null,
  );
  if (!type?.options.length && step.type !== 'record') return wrap;

  if (type?.needsOrg && !state.org) {
    wrap.append(h('div', { class: 'info-box' }, `ⓘ Chưa chọn org: Xem trước sẽ dùng ${SAMPLE_ROWS} bản ghi mẫu (Id giả).`));
  }
  const form = renderOptions(type.options, step.config ?? {}, (key, v, meta) => onStepOption(step, key, v, form, meta), {
    vars: { stepId: step.id },
    refChoices: (def) => parentChoices(step, def.accepts),
    suggest: suggestContext(step),
  });
  wrap.append(form);
  if (step.type === 'record') wrap.append(renderFields(step));
  if (step.type === 'query') wrap.append(renderSoqlBox(step));
  return wrap;
}

// ---------- Query (design 0006) ----------

let soqlBox = null; // { stepId, code } of the "SOQL sẽ chạy" line on screen

/** "SOQL sẽ chạy" (built by shared/soql.js, the code the server runs), "Sửa dạng SOQL", last read. */
function renderSoqlBox(step) {
  const c = step.config ?? {};
  const builder = (c.mode ?? 'builder') === 'builder';
  const code = h('code', { class: 'soql' }, buildSoql(c));
  soqlBox = { stepId: step.id, code };
  const q = queryResultOf(step.id);
  const when = q?.fetchedAt ? new Date(q.fetchedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  return h(
    'div',
    { class: 'soql-box' },
    builder ? h('div', { class: 'soql-head' }, h('span', {}, 'SOQL sẽ chạy'), h('button', {
      class: 'link',
      title: 'Chuyển sang ô SOQL với câu này để sửa tay (Ctrl+Z để quay lại)',
      onclick: () => updateWorkflow(() => {
        const cc = (step.config ??= {});
        cc.soql = buildSoql(cc);
        cc.mode = 'soql';
      }, { source: 'inspector-structure' }),
    }, 'Sửa dạng SOQL')) : null,
    builder ? code : null,
    q ? h('p', { class: 'hint' }, q.source === 'sample'
      ? `Lần xem trước dùng ${q.count} bản ghi mẫu vì chưa chọn org (xem tab ↓ ${q.alias} ở bảng kết quả).`
      : `Lần đọc gần nhất: ${q.count} bản ghi từ ${q.org} lúc ${when} (xem tab ↓ ${q.alias} ở bảng kết quả).`) : null,
  );
}

const sobjectLists = new Map(); // `${org}|${purpose}` → Promise<list>

function suggestContext(step) {
  return {
    org: state.org,
    sobjects: (purpose = 'create') => {
      const key = `${state.org}|${purpose}`;
      if (!sobjectLists.has(key)) {
        const p = api.sobjects(state.org, { purpose });
        p.catch(() => sobjectLists.delete(key));
        sobjectLists.set(key, p);
      }
      return sobjectLists.get(key);
    },
    pickFields: (def, values, apply) => openFieldPicker(values[def.suggest.sobjectKey], values[def.key], apply),
    poolFields: (alias) => {
      const scope = currentScope();
      const src = Object.values(scope.sources).find((x) => x.pool && x.name === alias);
      const out = [];
      const walk = (members, prefix) => {
        for (const m of members ?? []) {
          if (m.builtin) continue;
          if (m.members?.length && m.valueType !== 'reference') walk(m.members, `${prefix}${m.key}.`);
          else out.push(`${prefix}${m.key}`);
        }
      };
      walk(src?.members, '');
      return out;
    },
  };
}

/** Builder values a Query takes from its sObject: preset (meta.queryPresets) or the option defaults. */
const presetOf = (sobject) => ({ ...QUERY_DEFAULTS, ...(state.meta?.queryPresets?.[sobject] ?? {}) });
const PRESET_KEYS = ['fields', 'where', 'orderBy', 'limit'];
const autoFields = new Map(); // Query step id → JSON of the field list filled from the name field
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The sObject of a Query changed: every builder value still at the old sObject's preset (or the
 * default, or the name-field list filled earlier) takes the new one's. Without a preset and with
 * an org, the field list becomes Id + the name field from describe (Case → CaseNumber).
 */
function applyQueryPreset(step, from, to, form) {
  const c = step.config;
  const before = presetOf(from);
  const after = presetOf(to);
  for (const k of PRESET_KEYS) {
    const cur = c[k] ?? QUERY_DEFAULTS[k];
    const untouched = same(cur, before[k]) || (k === 'fields' && autoFields.get(step.id) === JSON.stringify(cur));
    if (!untouched || same(cur, after[k])) continue;
    c[k] = structuredClone(after[k]);
    const input = form.querySelector(`[data-key="${k}"]`);
    if (input) input.value = Array.isArray(after[k]) ? after[k].join('\n') : after[k];
  }
  autoFields.delete(step.id);
  const presetFields = state.meta?.queryPresets?.[to]?.fields;
  if (presetFields || !state.org || !/^[A-Za-z][A-Za-z0-9_]*$/.test(to)) return;
  const fieldsNow = JSON.stringify(c.fields ?? QUERY_DEFAULTS.fields);
  clearTimeout(nameFieldTimer);
  nameFieldTimer = setTimeout(async () => {
    let described;
    try {
      const known = await suggestContext(step).sobjects('query');
      if (!known.some((x) => x.name === to)) return;
      described = await api.fields(state.org, to);
    } catch {
      return;
    }
    const live = stepById(step.id);
    if (!described?.nameField || !live || live.config?.sobject !== to || JSON.stringify(live.config.fields ?? QUERY_DEFAULTS.fields) !== fieldsNow) return;
    const next = ['Id', ...(described.nameField === 'Id' ? [] : [described.nameField])];
    if (same(next, live.config.fields ?? QUERY_DEFAULTS.fields)) return;
    // No undo step of its own: undoing the sObject edit also restores the field list.
    updateWorkflow(() => { live.config.fields = next; }, { source: 'inspector', history: false });
    autoFields.set(step.id, JSON.stringify(next));
    const input = form.isConnected ? form.querySelector('[data-key="fields"]') : null;
    if (input) input.value = next.join('\n');
    refreshSoqlBox(live);
  }, 500);
}
let nameFieldTimer = 0;

function refreshSoqlBox(step) {
  if (soqlBox?.stepId === step.id && soqlBox.code.isConnected) soqlBox.code.textContent = buildSoql(step.config ?? {});
}

let fieldPickerSeq = 0;

/** "Chọn field…": the sObject's fields from describe; Id always on; Lookups can add `<relationship>.Name`. */
async function openFieldPicker(sobject, current, apply) {
  const modal = document.getElementById('modal');
  const org = state.org;
  const seq = ++fieldPickerSeq;
  const body = h('div', {}, h('p', { class: 'hint' }, 'Đang đọc describe…'));
  modal.replaceChildren(h('h2', {}, `Chọn field của ${sobject || '?'}`), body);
  modal.onclose = null;
  modal.showModal();
  let described;
  try {
    described = await api.fields(org, sobject);
  } catch (e) {
    if (seq !== fieldPickerSeq) return;
    body.replaceChildren(h('p', { class: 'err' }, e.message), h('div', { class: 'actions' }, h('button', { onclick: () => modal.close() }, 'Đóng')));
    return;
  }
  if (seq !== fieldPickerSeq) return;
  const list = (Array.isArray(current) ? current : String(current ?? '').split(/[\n,;]/)).map((x) => String(x).trim()).filter(Boolean);
  const has = new Set(list.map((x) => x.toLowerCase()));
  const rows = described.fields.map((f) => {
    const isId = f.name === 'Id';
    const cb = h('input', { type: 'checkbox', checked: isId || has.has(f.name.toLowerCase()), disabled: isId });
    const relPath = f.relationshipName ? `${f.relationshipName}.Name` : null;
    const rel = relPath ? h('input', { type: 'checkbox', checked: has.has(relPath.toLowerCase()), title: `Thêm ${relPath}` }) : null;
    const el = h('label', {}, cb, h('span', {}, `${f.label} `, h('small', {}, `${f.name} · ${f.type}${f.referenceTo ? ` → ${f.referenceTo.join(', ')}` : ''}`)),
      rel ? h('span', { class: 'rel-check' }, rel, ` kèm tên (${relPath})`) : h('span'));
    return { f, cb, rel, relPath, el };
  });
  const filter = h('input', {
    placeholder: 'Lọc field…',
    class: 'dialog-filter',
    oninput: (e) => {
      const q = e.target.value.toLowerCase();
      for (const r of rows) r.el.hidden = q && !`${r.f.name} ${r.f.label}`.toLowerCase().includes(q);
    },
  });
  body.replaceChildren(
    filter,
    h('div', { class: 'list' }, rows.map((r) => r.el)),
    h('div', { class: 'actions' },
      h('button', { onclick: () => modal.close() }, 'Hủy'),
      h('button', {
        class: 'primary',
        onclick: () => {
          const next = ['Id'];
          for (const r of rows) {
            if (r.cb.checked && r.f.name !== 'Id') next.push(r.f.name);
            if (r.rel?.checked) next.push(r.relPath);
          }
          // Paths the describe does not list (typed by hand, e.g. Account.Owner.Name) are kept.
          const known = new Set(rows.flatMap((r) => [r.f.name.toLowerCase(), r.relPath?.toLowerCase()]).filter(Boolean));
          for (const x of list) if (!known.has(x.toLowerCase()) && !next.some((y) => y.toLowerCase() === x.toLowerCase())) next.push(x);
          modal.close();
          apply(next);
        },
      }, 'Cập nhật danh sách')),
  );
  filter.focus();
}

function onStepOption(step, key, v, form, meta) {
  const setAliasInput = (next, nameKey = 'alias') => {
    const input = form.querySelector(`[data-key="${nameKey}"]`);
    if (input) input.value = next;
  };
  let filled = null;
  let fieldsChanged = false;
  updateWorkflow((wf) => {
    const c = (step.config ??= {});
    const follow = (next, nameKey = 'alias') => {
      setStepAlias(wf, step.id, next, { memo: aliasMemo, slotKeys, catalog: state.meta, scope: currentScope(), key: nameKey });
      setAliasInput(next, nameKey);
    };
    if (key === 'sobject' && step.type === 'record') {
      // Keep the alias in sync while it is still the auto-suggested one.
      const auto = !c.alias || c.alias === suggestAlias(c.sobject, step.id);
      const old = c.sobject ?? nodeType('record')?.options.find((o) => o.key === 'sobject')?.default;
      c.sobject = v;
      if (auto) follow(suggestAlias(v, step.id));
      fieldsChanged = applyRecordPreset(step, old, v);
    } else if (key === 'sobject' && step.type === 'query') {
      const old = c.sobject ?? QUERY_DEFAULTS.sobject;
      const auto = !c.alias || c.alias === suggestPoolAlias(old, step.id);
      c.sobject = v;
      applyQueryPreset(step, old, v, form);
      if (auto) follow(suggestPoolAlias(v, step.id));
    } else if (key === 'from' && step.type === 'pick') {
      const auto = !c.alias || c.alias === suggestPickAlias(c.from, step.id);
      c.from = v;
      if (auto && v) follow(suggestPickAlias(v, step.id));
    } else if (key === 'mode' && step.type === 'loop') {
      // "Mỗi bản ghi trong pool" (0010): fill the empty pool and record names; the values of
      // the other modes stay (hidden), so switching back loses nothing.
      c.mode = v;
      if (v === 'each') filled = fillEach(wf, step);
    } else if (key === 'from' && step.type === 'loop') {
      // The record name follows the pool while it is still the suggested one (accs → acc).
      const auto = !c.itemAlias || c.itemAlias === suggestPickAlias(c.from, step.id, 'itemAlias');
      c.from = v;
      if (auto && v) follow(suggestPickAlias(v, step.id, 'itemAlias'), 'itemAlias');
    } else if (exposesList(nodeType(step.type)).some((ex) => ex.name?.key === key)) {
      // References follow only to a valid, free name (a loop variable or the record looped over:
      // inside its body only); while the field is empty or matches another alias mid-typing,
      // they stay put.
      setStepAlias(wf, step.id, v, { memo: aliasMemo, slotKeys, catalog: state.meta, scope: currentScope(), key });
    } else c[key] = v;
  }, { source: 'inspector', coalesceKey: meta?.coalesceKey ?? `${step.id}:${key}` });
  // Card summary/alias changed; the process view re-renders, the inspector keeps focus.
  fillPathDefaults(step, key, form);
  // Only the field list is redrawn, so the sObject input keeps focus while typing.
  if (fieldsChanged) refreshFieldsSection(step);
  // Pool / record names filled in: show them (the mode select loses nothing by a re-render).
  if (filled && Object.keys(filled).length) updateWorkflow(() => {}, { source: 'inspector-structure', history: false });
  if (step.type === 'query') {
    refreshSoqlBox(step);
    // Switching between builder and SOQL shows / hides the "SOQL sẽ chạy" line.
    if (key === 'mode') updateWorkflow(() => {}, { source: 'inspector-structure', history: false });
  }
}

/**
 * A `vars: 'path'` option that just became visible (e.g. "So sánh giá trị") and still holds its
 * catalogue default: if the default does not resolve here (`loop.index` outside any loop), use a
 * variable that does — the innermost loop's index, else the first field of the nearest record.
 */
function fillPathDefaults(step, changedKey, form) {
  const defs = (nodeType(step.type)?.options ?? []).filter((d) => d.vars === 'path' && d.showIf?.key === changedKey);
  for (const def of defs) {
    const value = step.config?.[def.key];
    if (value !== undefined && value !== '' && value !== def.default) continue;
    if (!def.showIf.in.includes(step.config?.[changedKey])) continue;
    const scope = currentScope();
    const ref = scope.refs.find((r) => r.nodeId === step.id && r.option === def.key);
    if (ref && !ref.code) continue;
    const here = scope.at[step.id];
    let next = null;
    for (const v of here?.visible ?? []) {
      const src = scope.sources[v.source];
      if (!src || v.certainty === 'maybe') continue;
      const member = src.kind === 'vars' ? src.members[0] : src.members.find((m) => !m.builtin);
      if (member) {
        next = `${src.name}.${member.key}`;
        break;
      }
    }
    const input = form.querySelector(`[data-key="${CSS.escape(def.key)}"]`);
    if (!next || !input) continue;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * Choices for a `kind: 'ref'` option at this step (Lookup "Bản ghi cha"): usable first, nearest
 * first, then the others with the reason (shared/scope.js refChoices).
 */
function parentChoices(step, accepts, referenceTo, mode) {
  const targets = (Array.isArray(referenceTo) ? referenceTo : []).map((x) => String(x).toLowerCase());
  const pools = Boolean(accepts?.pool);
  const list = refChoices(currentScope(), step.id, accepts).map((c) => {
    // "acc (Account)", "accs (Account · đọc từ org)", "acc2 (Account · chọn từ accs)",
    // "acc (Account · bản ghi đang lặp)"; a pool list (Chọn bản ghi / Lặp `from`) says where the
    // records come from: "đọc từ org", "đã sinh", "đã chọn" (design 0010).
    const so = c.sobject || '?';
    const detail = c.nodeType === 'query' ? `${so} · đọc từ org`
      : c.current === 'item' ? `${so} · bản ghi đang lặp`
        : c.nodeType === 'pick' ? (pools ? `${so} · đã chọn` : `${so} · chọn từ ${c.from ?? '?'}`)
          : pools ? `${so} · đã sinh` : c.sobject;
    // A Lookup imported from the org knows which sObjects it points to (referenceTo).
    if (c.usable && targets.length && c.sobject && !targets.includes(c.sobject.toLowerCase())) {
      return { alias: c.name, sobject: c.sobject, detail, usable: false, note: `là ${c.sobject}, field này trỏ tới ${referenceTo.join(', ')}` };
    }
    // "Bản ghi hiện tại" of a Query: a pool has none.
    if (c.usable && mode === 'current' && c.current === 'none') {
      return { alias: c.name, sobject: c.sobject, detail, usable: false, note: 'pool nhiều bản ghi: chọn "Ngẫu nhiên trong pool" hoặc thêm bước Chọn bản ghi' };
    }
    // "Ngẫu nhiên trong pool" of the record a Lặp `each` loops over: one record, not a pool.
    if (c.usable && mode === 'random' && c.current === 'item') {
      return { alias: c.name, sobject: c.sobject, detail, usable: false, note: `bản ghi đang lặp, không phải pool: chọn pool "${c.from ?? '?'}"` };
    }
    return {
      alias: c.name,
      sobject: c.sobject,
      detail,
      nodeType: c.nodeType,
      current: c.current,
      usable: c.usable,
      // "bản ghi cuối" is about the current record; a pool option reads all of them (0010 review).
      note: c.usable ? (c.certainty === 'maybe' ? (pools ? 'có thể chưa có' : 'có thể trống') : c.certainty === 'last' && !pools ? 'bản ghi cuối' : '') : c.note ?? '',
    };
  });
  return [...list.filter((c) => c.usable), ...list.filter((c) => !c.usable)];
}

// ---------- Record default fields (design 0012 G) ----------

const autoRecordFields = new Map(); // Record step id → JSON of the field list filled automatically
const recordDescribeTimers = new Map(); // Record step id → pending describe timer
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The sObject of a Record changed (inside the sObject edit's update, so one Ctrl+Z restores
 * both): a field list still at the old sObject's preset (meta.recordPresets) or at the list
 * filled earlier for this step takes the new one's (Task → Subject). With an org, 500 ms later
 * the list follows the describe: a preset gets the required fields it lacks appended; another
 * sObject gets every required createable field, else its name field (an auto-number name
 * field: no field at all).
 * → true when the field list changed.
 */
function applyRecordPreset(step, from, to) {
  const c = step.config;
  const cur = JSON.stringify(c.fields ?? []);
  clearTimeout(recordDescribeTimers.get(step.id));
  recordDescribeTimers.delete(step.id);
  const untouched = cur === JSON.stringify(recordPresetFields(from)) || autoRecordFields.get(step.id) === cur;
  if (!untouched) {
    autoRecordFields.delete(step.id);
    return false;
  }
  const next = recordPresetFields(to);
  autoRecordFields.set(step.id, JSON.stringify(next));
  scheduleRecordDescribe(step.id, to);
  if (JSON.stringify(next) === cur) return false;
  c.fields = next;
  for (const k of [...expanded]) if (k.startsWith(`${step.id}:`)) expanded.delete(k);
  return true;
}

function scheduleRecordDescribe(stepId, sobject) {
  const org = state.org;
  if (!org || !API_NAME.test(String(sobject ?? ''))) return;
  recordDescribeTimers.set(stepId, setTimeout(async () => {
    recordDescribeTimers.delete(stepId);
    let described;
    try {
      const known = await suggestContext(stepById(stepId)).sobjects('create');
      if (!known.some((x) => x.name === sobject)) return;
      described = await api.describe(org, sobject);
    } catch {
      return; // the sObject input reports describe problems
    }
    const live = stepById(stepId);
    if (!live || state.org !== org || live.config?.sobject !== sobject || autoRecordFields.get(stepId) !== JSON.stringify(live.config.fields ?? [])) return;
    const fields = described?.fields ?? [];
    const required = fields.filter((f) => f.required);
    const cur = live.config.fields ?? [];
    const aliases = parentChoices(live);
    let next;
    let message;
    if (recordPreset(sobject)) {
      // Real describes of Task / Event mark nothing required: the preset (Event's
      // ActivityDateTime, Contact's FirstName) stays, only missing required fields are added.
      const have = new Set(cur.map((f) => String(f?.name ?? '').toLowerCase()));
      const missing = required.filter((f) => !have.has(f.name.toLowerCase()));
      if (!missing.length) return;
      next = [...structuredClone(cur), ...missing.map((f) => describedFieldSpec(f, aliases))];
      message = `Đã thêm field bắt buộc của ${sobject} theo ${org}: ${missing.map((f) => f.name).join(', ')}.`;
    } else if (required.length) {
      next = required.map((f) => describedFieldSpec(f, aliases));
    } else if (described?.nameField) {
      const name = fields.find((f) => f.name === described.nameField);
      if (name) next = [describedFieldSpec(name, aliases)];
      else if (cur.length === 1 && String(cur[0]?.name ?? '').toLowerCase() === described.nameField.toLowerCase()) {
        // An auto-number Name: Salesforce fills it, so writing it would fail every insert.
        next = [];
        message = `Field tên ${described.nameField} của ${sobject} là auto-number (Salesforce tự đánh số) nên đã bỏ khỏi danh sách field. Thêm field cần sinh, hoặc bấm "Import từ org…".`;
      }
    }
    if (!next || same(next, cur)) return;
    message ??= `Đã đặt field mặc định cho ${sobject} theo ${org}: ${next.map((f) => f.name).join(', ')}.`;
    // No undo step of its own: undoing the sObject edit also restores the field list.
    updateWorkflow(() => { live.config.fields = next; }, { source: 'inspector', history: false });
    autoRecordFields.set(stepId, JSON.stringify(next));
    refreshFieldsSection(live);
    toast(message, 5000);
  }, 500));
}

/** A field spec from describe (mapDescribe), its Lookup parent chosen like "Import từ org…". */
function describedFieldSpec(f, aliases) {
  const options = { ...(f.options ?? {}) };
  if (f.type === 'lookup' || f.type === 'masterdetail') {
    const pre = preselectParent(f, aliases);
    // "＋ … có sẵn trong org" (a new Query step) is only offered in the Import dialog.
    if (pre && !pre.startsWith(NEW_QUERY)) {
      options.ref = pre;
      if (aliases.find((a) => a.alias === pre)?.nodeType === 'query') options.mode = 'random';
    }
  }
  return { name: f.name, type: f.type, options };
}

/**
 * Redraw the field list of `step` if the inspector shows it (the rest of the form keeps focus).
 * Focus inside the list (describe landing while a field is being edited) moves to the control
 * at the same place in the new list, with its caret.
 */
function refreshFieldsSection(step) {
  if (lastSelectionKey !== `step:${step.id}`) return;
  const box = root.querySelector('.fields-section');
  if (!box) return;
  const active = document.activeElement;
  const path = [];
  if (active && active !== box && box.contains(active)) {
    for (let el = active; el !== box; el = el.parentElement) path.unshift([...el.parentElement.children].indexOf(el));
  }
  const caret = path.length && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const next = renderFields(step);
  box.replaceWith(next);
  markIssues();
  if (!path.length) return;
  let el = next;
  for (const i of path) el = el?.children[i];
  if (!el || el.tagName !== active.tagName) return;
  el.focus({ preventScroll: true });
  if (caret && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(...caret); } catch { /* not a text control */ }
  }
}

// ---------- fields editor ----------

function groupedTypeSelect(value, onchange) {
  const groups = new Map();
  for (const t of state.meta.fieldTypes) {
    if (!groups.has(t.category)) groups.set(t.category, []);
    groups.get(t.category).push(t);
  }
  return h(
    'select',
    { onchange, title: 'Kiểu dữ liệu' },
    [...groups].map(([cat, types]) => h('optgroup', { label: cat }, types.map((t) => h('option', { value: t.type, selected: t.type === value }, t.label)))),
  );
}

function renderFields(node) {
  const fields = node.config.fields ?? (node.config.fields = []);
  const structural = (fn) => updateWorkflow(fn, { source: 'inspector-structure' });

  const list = h(
    'div',
    { class: 'fields' },
    fields.map((f, i) => {
      const key = `${node.id}:${i}`;
      const open = expanded.has(key);
      const ft = fieldType(f.type);
      const card = h(
        'div',
        { class: 'field-card', 'data-field': `fields.${f.name}` },
        h(
          'div',
          { class: 'row' },
          h('input', {
            value: f.name,
            placeholder: 'API name',
            'aria-label': 'Tên field',
            onfocus: () => { renameFrom = f.name; },
            oninput: (e) => {
              updateWorkflow(() => {
                f.name = e.target.value.trim();
              }, { source: 'inspector', coalesceKey: `${key}:name` });
              card.dataset.field = `fields.${f.name}`;
            },
            onchange: () => followFieldRename(node, renameFrom, f.name),
          }),
          groupedTypeSelect(f.type, (e) =>
            structural(() => {
              f.type = e.target.value;
              f.options = {};
              expanded.add(key);
            }),
          ),
          h(
            'div',
            { class: 'actions' },
            h('button', { title: open ? 'Ẩn tùy chọn' : 'Tùy chọn', onclick: () => { open ? expanded.delete(key) : expanded.add(key); render(); } }, open ? '▴' : '⚙'),
            h('button', { title: 'Lên', disabled: i === 0, onclick: () => structural(() => fields.splice(i - 1, 0, fields.splice(i, 1)[0])) }, '↑'),
            h('button', { title: 'Xuống', disabled: i === fields.length - 1, onclick: () => structural(() => fields.splice(i + 1, 0, fields.splice(i, 1)[0])) }, '↓'),
            h('button', { title: 'Xóa field', onclick: () => removeField(node, i) }, '✕'),
          ),
        ),
      );
      if (open && ft) {
        card.append(
          h(
            'div',
            { class: 'opts' },
            renderOptions(ft.options, f.options ?? {}, (k, v, meta) =>
              updateWorkflow(() => {
                f.options = { ...(f.options ?? {}), [k]: v };
              }, { source: 'inspector', coalesceKey: meta?.coalesceKey ?? `${key}:${k}` }),
              {
                refChoices: (def, values) => parentChoices(node, def.accepts, values?.referenceTo, values?.mode ?? 'current'),
                vars: { stepId: node.id, fieldIndex: i, get fieldName() { return f.name; }, get field() { return `fields.${f.name}`; } },
              },
            ),
          ),
        );
      }
      card.append(h('div', { class: 'error-text', hidden: true }));
      return card;
    }),
  );

  return h(
    'div',
    { class: 'fields-section' },
    h('h3', {}, `Fields (${fields.length})`),
    h('p', { class: 'hint' }, 'Thứ tự field là thứ tự sinh: {{this.Field}} và Email "theo tên" chỉ thấy field phía trên.'),
    list,
    h(
      'div',
      { class: 'btn-row' },
      h('button', {
        onclick: () => structural(() => {
          fields.push({ name: '', type: 'text', options: {} });
          expanded.add(`${node.id}:${fields.length - 1}`);
        }),
      }, '+ Thêm field'),
      h('button', {
        disabled: !state.org,
        title: state.org ? `Lấy field từ ${state.org}` : 'Chọn org ở thanh trên trước',
        onclick: () => openImport(node),
      }, 'Import từ org…'),
    ),
  );
}

function markIssues() {
  const s = state.selection;
  if (s?.kind !== 'step') return;
  // Warnings show here only when they come with a quick fix (design 0012: "Đổi thành Subject").
  const issues = [...state.issues.errors, ...state.issues.warnings.filter((w) => w.fix)].filter((i) => i.nodeId === s.id);
  const isError = (i) => state.issues.errors.includes(i);
  for (const card of root.querySelectorAll('.field-card')) {
    const mine = issues.filter((i) => i.field === card.dataset.field);
    card.classList.toggle('has-error', mine.some(isError));
    card.classList.toggle('has-warning', mine.length > 0 && !mine.some(isError));
    fillErrors(card.querySelector('.error-text'), mine);
  }
  for (const input of root.querySelectorAll('.options [data-key]')) {
    if (input.closest('.field-card')) continue;
    const mine = issues.filter((i) => i.field === input.dataset.key);
    input.classList.toggle('invalid', mine.some(isError));
    const box = input.closest('.form-row')?.querySelector('.opt-error');
    if (box) fillErrors(box, mine);
  }
}

/**
 * Error lines with a one-click "Sửa thành …" button when the issue has a suggestion, and a
 * quick-fix button when the server attached a `fix` (design 0012 F/G).
 */
function fillErrors(box, issues) {
  if (!box) return;
  box.hidden = !issues.length;
  box.replaceChildren(...issues.map((i) => h(
    'div',
    { class: `error-line${state.issues.errors.includes(i) ? '' : ' warn-line'}` },
    i.message,
    i.suggestion ? h('button', { class: 'link fix-btn', onclick: () => applyFix(i) }, `Sửa thành ${suggestionText(i)}`) : null,
    i.fix && fixText(i.fix) ? h('button', { class: 'link fix-btn quick-fix', 'data-fix': i.fix.kind, onclick: () => applyQuickFix(i.fix) }, fixText(i.fix)) : null,
  )));
}

/** Button text of an issue's `fix`, or null for a kind this client does not know. */
function fixText(fix) {
  if (fix.kind === 'renameField') return `Đổi thành ${fix.to}`;
  if (fix.kind === 'addSelectField') return `Thêm ${fix.field} vào SELECT của "${stepById(fix.stepId)?.config?.alias || fix.stepId}"`;
  return null;
}

/** Apply an issue's `fix` (one undo step). */
function applyQuickFix(fix) {
  closePicker();
  if (fix.kind === 'renameField') {
    // The issue may be stale (the field was renamed or the target added since): change nothing.
    const fields = stepById(fix.stepId)?.config?.fields ?? [];
    if (!fields.some((x) => x?.name === fix.from) || fields.some((x) => String(x?.name ?? '').toLowerCase() === String(fix.to).toLowerCase())) return;
    // References ({{task.Name}}) move first, while the field still has its old name.
    const res = updateWorkflow((wf) => {
      const out = renameField(wf, fix.stepId, fix.from, fix.to, { catalog: state.meta });
      const live = stepById(fix.stepId);
      const f = live?.config?.fields?.find((x) => x?.name === fix.from);
      if (!f) return out;
      f.name = fix.to;
      // A Name still at the old defaults takes the preset's options for the new field (Subject:
      // the Call / Send Letter list), so the generated values fit the field.
      const spec = recordPresetFields(live.config.sobject).find((x) => x.name === fix.to);
      const plain = !f.options || !Object.keys(f.options).length || ['name', 'company'].includes(f.options.mode) && Object.keys(f.options).length === 1;
      if (spec && f.type === 'text' && plain) Object.assign(f, structuredClone({ type: spec.type, options: spec.options }));
      return out;
    }, { source: 'inspector-structure' });
    toast(`Đã đổi field ${fix.from} thành ${fix.to}${res?.count ? ` và cập nhật ${res.count} tham chiếu` : ''}. Ctrl+Z để hoàn tác.`);
  } else if (fix.kind === 'addSelectField') {
    // The Query is another step: its builder list or its hand-written SOQL gets the field.
    const q = stepById(fix.stepId);
    if (q?.type !== 'query') return;
    const name = q.config?.alias || q.id;
    const done = updateWorkflow(() => {
      const c = (q.config ??= {});
      if ((c.mode ?? 'builder') === 'soql') {
        const next = addSelectField(c.soql, fix.field);
        if (next === null) return false;
        c.soql = next;
        return true;
      }
      const raw = c.fields ?? QUERY_DEFAULTS.fields;
      const list = (Array.isArray(raw) ? raw : String(raw).split(/[\n,;]/)).map((x) => String(x ?? '').trim()).filter(Boolean);
      if (!list.some((x) => x.toLowerCase() === fix.field.toLowerCase())) list.push(fix.field);
      c.fields = list;
      return true;
    }, { source: 'inspector-structure' });
    if (done) toast(`Đã thêm ${fix.field} vào Query "${name}". Bấm Xem trước để đọc lại.`);
    else toast(`Không sửa được SOQL của Query "${name}". Thêm ${fix.field} vào SELECT bằng tay.`);
  }
}

function issueOption(issue) {
  const step = stepById(issue.nodeId);
  return step ? referenceOptions(step, state.meta, { includeHidden: true }).find((x) => x.field === issue.field && x.option === issue.suggestion?.option) : null;
}

const suggestionText = (issue) => (issueOption(issue)?.mode === 'template' ? `{{${issue.suggestion.to}}}` : issue.suggestion.to);

/** Apply an issue's suggestion to the first matching reference (one undo step). */
function applyFix(issue) {
  const step = stepById(issue.nodeId);
  if (!step) return;
  closePicker();
  updateWorkflow(() => {
    const o = issueOption(issue);
    if (!o) return;
    const value = o.fieldIndex !== undefined ? o.stored ?? o.value : o.value;
    o.set(applySuggestion(o.mode, value, issue.suggestion));
  }, { source: 'inspector-structure' });
}

// ---------- rename / delete keep references (design 0005) ----------

let renameFrom = null;

/** After a field was renamed (on change, not per key): move {{alias.Old}} / {{this.Old}} along. */
function followFieldRename(step, from, to) {
  renameFrom = to;
  if (!from || !to || from === to) return;
  // Dry run first: history: false always emits, and a re-render on blur would steal the focus.
  if (!renameField(structuredClone(state.workflow), step.id, from, to, { catalog: state.meta }).count) return;
  // history: false — the references move in the same undo step as the name (one Ctrl+Z undoes both).
  const res = updateWorkflow((wf) => renameField(wf, step.id, from, to, { catalog: state.meta }), { source: 'inspector-structure', history: false });
  if (!res?.count) return;
  const pairs = res.names.map((n) => `${n}.${from} → ${n}.${to}`).join(', ');
  toast(`Đã cập nhật ${res.count} tham chiếu: ${pairs}. Ctrl+Z để hoàn tác.`, 5000);
}

function removeField(step, index) {
  const f = step.config.fields[index];
  const refs = f?.name ? refsToRecords(currentScope(), step.id, f.name).filter((r) => r.mode !== 'ref' && !(r.nodeId === step.id && r.fieldIndex === index)) : [];
  updateWorkflow(() => step.config.fields.splice(index, 1), { source: 'inspector-structure' });
  const places = placesText(refs);
  if (places.length) {
    toast(`Field "${f.name}" đang được dùng ở ${places.length} chỗ: ${places.join(', ')}. ${places.length > 1 ? 'Các chỗ đó' : 'Chỗ đó'} sẽ báo lỗi cho tới khi sửa. Ctrl+Z để hoàn tác.`, 7000);
  }
}

// ---------- import from org ----------

let sobjectCache = { org: null, list: [] };

async function openImport(node) {
  const modal = document.getElementById('modal');
  const org = state.org;
  const body = h('div', {}, h('p', { class: 'hint' }, 'Đang tải danh sách sObject…'));
  modal.replaceChildren(h('h2', {}, `Import field từ ${org}`), body);
  modal.showModal();
  try {
    if (sobjectCache.org !== org) sobjectCache = { org, list: await api.sobjects(org) };
  } catch (e) {
    body.replaceChildren(h('p', { class: 'err' }, e.message), h('div', { class: 'actions' }, h('button', { onclick: () => modal.close() }, 'Đóng')));
    return;
  }
  const datalist = h('datalist', { id: 'sobject-list' }, sobjectCache.list.map((s) => h('option', { value: s.name }, s.label)));
  const input = h('input', { list: 'sobject-list', value: node.config.sobject ?? '', placeholder: 'Account', style: { width: '100%' } });
  const listBox = h('div');
  const load = async () => {
    listBox.replaceChildren(h('p', { class: 'hint' }, 'Đang đọc describe…'));
    try {
      renderImportList(node, await api.describe(org, input.value.trim()), listBox, modal);
    } catch (e) {
      listBox.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  };
  input.addEventListener('change', load);
  body.replaceChildren(h('div', { class: 'form-row' }, h('label', {}, 'sObject'), input, datalist), listBox);
  if (input.value) load();
}

const NEW_QUERY = '+query:';

/**
 * The parent a Lookup from describe starts with (Import, Record defaults): only among parents
 * usable at this position (above, not in the other branch, on): one Record / Chọn bản ghi of that
 * sObject (current), else one Query (random), else "＋ … có sẵn trong org" (NEW_QUERY + sObject)
 * when nothing matches (design 0006); '' when it is ambiguous.
 */
function preselectParent(f, aliases) {
  const fits = (a) => a.usable && f.referenceTo?.includes(a.sobject);
  const records = aliases.filter((a) => fits(a) && a.nodeType !== 'query');
  const pools = aliases.filter((a) => fits(a) && a.nodeType === 'query');
  // Inside a Lặp `each`, the record looped over of that sObject (nearest first) wins (0010).
  const items = records.filter((a) => a.current === 'item');
  if (items.length) return items[0].alias;
  if (records.length === 1) return records[0].alias;
  if (!records.length && pools.length === 1) return pools[0].alias;
  if (!records.length && !pools.length && f.referenceTo?.length) return `${NEW_QUERY}${f.referenceTo[0]}`;
  return '';
}

function renderImportList(node, described, box, modal) {
  const existing = new Set((node.config.fields ?? []).map((f) => f.name.toLowerCase()));
  const aliases = parentChoices(node);
  const rows = described.fields.map((f) => {
    const has = existing.has(f.name.toLowerCase());
    const cb = h('input', { type: 'checkbox', checked: f.required && !has, disabled: has });
    let parentSel = null;
    if (f.type === 'lookup' || f.type === 'masterdetail') {
      // Auto-pick only among parents usable at this position (above, not in the other branch, on):
      // one Record / Chọn bản ghi of that sObject (current), else one Query (random), else
      // "＋ … có sẵn trong org" when nothing matches (design 0006).
      const pre = preselectParent(f, aliases);
      const usable = aliases.filter((a) => a.usable);
      const other = aliases.filter((a) => !a.usable);
      parentSel = h(
        'select',
        { title: 'Bản ghi cha' },
        h('option', { value: '' }, '— bản ghi cha —'),
        usable.map((a) => h('option', { value: a.alias, selected: pre === a.alias }, `${a.alias} (${a.detail || a.sobject})${a.note ? ` · ${a.note}` : ''}`)),
        (f.referenceTo ?? []).slice(0, 3).map((t) => h('option', { value: `${NEW_QUERY}${t}`, selected: pre === `${NEW_QUERY}${t}` }, `＋ ${t} có sẵn trong org (thêm bước Query)`)),
        other.length
          ? h('optgroup', { label: 'Không dùng được ở đây' }, other.map((a) => h('option', { value: a.alias, disabled: true, title: a.note }, `${a.alias} (${a.detail || a.sobject}) — ${a.note}`)))
          : null,
      );
    }
    const typeLabel = fieldType(f.type)?.label ?? f.type;
    return {
      f,
      cb,
      parentSel,
      el: h(
        'label',
        {},
        cb,
        h('span', {}, `${f.label} `, h('small', {}, `${f.name} · ${typeLabel}${f.referenceTo ? ` → ${f.referenceTo.join(', ')}` : ''}${f.required ? ' · bắt buộc' : ''}${has ? ' · đã có' : ''}`)),
        parentSel ?? h('span'),
      ),
    };
  });
  const filter = h('input', {
    placeholder: 'Lọc field…',
    class: 'dialog-filter',
    oninput: (e) => {
      const q = e.target.value.toLowerCase();
      for (const r of rows) r.el.hidden = q && !`${r.f.name} ${r.f.label}`.toLowerCase().includes(q);
    },
  });
  box.replaceChildren(
    h('p', { class: 'hint' }, 'Field bắt buộc đã được chọn sẵn. Field Lookup tự chọn bản ghi cha nếu chỉ có một bước khớp sObject; chọn "＋ … có sẵn trong org" để dùng bản ghi có sẵn.'),
    filter,
    h('div', { class: 'list' }, rows.map((r) => r.el)),
    h(
      'div',
      { class: 'actions' },
      h('button', { onclick: () => modal.close() }, 'Hủy'),
      h('button', {
        class: 'primary',
        onclick: () => {
          const picked = rows.filter((r) => r.cb.checked && !r.cb.disabled);
          const added = []; // Query steps added for "＋ … có sẵn"
          updateWorkflow((wf) => {
            node.config.sobject = described.sobject;
            if (!node.config.alias) node.config.alias = suggestAlias(described.sobject, node.id);
            const newQueries = new Map(); // sObject → alias (one Query per sObject)
            for (const r of picked) {
              const options = { ...r.f.options };
              const choice = r.parentSel?.value ?? '';
              if (choice.startsWith(NEW_QUERY)) {
                const sobject = choice.slice(NEW_QUERY.length);
                if (!newQueries.has(sobject)) {
                  // Same undo step as the fields; first in the workflow so it runs before every step.
                  const q = newStep('query', { parentId: null, slot: null, index: 0 });
                  q.config.sobject = sobject;
                  Object.assign(q.config, structuredClone(state.meta?.queryPresets?.[sobject] ?? {}));
                  delete q.config.alias;
                  q.config.alias = suggestPoolAlias(sobject);
                  if (sobject === 'RecordType') q.config.where = `${q.config.where ? `${q.config.where} AND ` : ''}SobjectType = '${described.sobject}'`;
                  insertStep(wf, { parentId: null, slot: null, index: newQueries.size }, q);
                  newQueries.set(sobject, q.config.alias);
                  added.push({ alias: q.config.alias, sobject });
                }
                options.ref = newQueries.get(sobject);
                options.mode = 'random';
              } else if (r.parentSel) {
                options.ref = choice;
                if (aliases.find((a) => a.alias === choice)?.nodeType === 'query') options.mode = 'random';
              }
              node.config.fields.push({ name: r.f.name, type: r.f.type, options });
            }
          }, { source: 'inspector-structure' });
          modal.close();
          const qs = added.map((q) => `"${q.alias}" (${q.sobject} có sẵn trong org)`).join(', ');
          toast(added.length ? `Đã thêm ${picked.length} field và bước Query ${qs}.` : `Đã thêm ${picked.length} field.`, added.length ? 5000 : undefined);
        },
      }, 'Thêm field đã chọn'),
    ),
  );
}
