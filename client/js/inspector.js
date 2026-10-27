// Right-hand panel: configuration for the selected step, or workflow settings and tips when
// the Start card (or nothing) is selected. It is the only place where configuration is edited.
// Edits made here emit source 'inspector' and do not trigger a re-render, so focus survives
// typing; structural edits (add/remove/reorder fields) use 'inspector-structure'.
// On narrow screens the panel is a bottom sheet (.inspector.open) shown while a step is selected.

import { h, toast } from './dom.js';
import { renderOptions } from './forms.js';
import { api } from './api.js';
import {
  state, subscribe, select, updateWorkflow, stepById, nodeType, fieldType, suggestAlias, recordScope, slotKeys, NODE_COLORS,
} from './store.js';
import { setStepAlias } from '/shared/workflow-tree.js';
import { recordChoices, HIDDEN_REASON } from '/shared/scope.js';
import { deleteStep, duplicateStep, toggleDisabled } from './ops.js';

let root;
const expanded = new Set(); // `${stepId}:${fieldIndex}` with options panel open
let sheetClosed = false; // narrow screens: "‹ Xong" hides the sheet but keeps the selection
let lastSelectionKey = null;
// Last good alias per step: references wait there while the alias field is empty or clashing.
const aliasMemo = new Map();

export function initInspector() {
  root = document.getElementById('inspector');
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
  const closeSheet = h('button', { class: 'sheet-close', onclick: () => { sheetClosed = true; root.classList.remove('open'); } }, '‹ Xong');
  root.replaceChildren(closeSheet, step ? renderStep(step) : renderWorkflow());
  root.classList.toggle('open', Boolean(s) && !sheetClosed);
  markIssues();
}

function renderWorkflow() {
  return h(
    'div',
    {},
    h('div', { class: 'node-head' }, h('span', { class: 'dot', style: { background: NODE_COLORS.start } }), h('h2', {}, 'Bắt đầu')),
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
      { class: 'node-head' },
      h('span', { class: 'dot', style: { background: NODE_COLORS[step.type] } }),
      h('h2', {}, type?.label ?? step.type),
      step.disabled ? h('span', { class: 'tag-off' }, 'Đã tắt') : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon', title: step.disabled ? 'Bật bước (Ctrl+/)' : 'Tắt bước (Ctrl+/)', onclick: () => toggleDisabled(step.id) }, step.disabled ? '◉' : '⊘'),
      h('button', { class: 'icon', title: 'Nhân bản (Ctrl+D)', onclick: () => duplicateStep(step.id) }, '⧉'),
      h('button', { class: 'icon danger', title: 'Xóa (Delete)', onclick: () => deleteStep(step.id) }, '✕'),
    ),
    h('p', { class: 'desc' }, type?.description ?? ''),
    step.disabled ? h('div', { class: 'warn-box' }, 'Bước này đang tắt nên không chạy và không được kiểm tra. Bấm Ctrl+/ để bật lại.') : null,
  );
  if (!type?.options.length && step.type !== 'record') return wrap;

  const form = renderOptions(type.options, step.config ?? {}, (key, v) => onStepOption(step, key, v, form), {});
  wrap.append(form);
  if (step.type === 'record') wrap.append(renderFields(step));
  return wrap;
}

function onStepOption(step, key, v, form) {
  updateWorkflow((wf) => {
    const c = (step.config ??= {});
    if (key === 'sobject' && step.type === 'record') {
      // Keep the alias in sync while it is still the auto-suggested one.
      const auto = !c.alias || c.alias === suggestAlias(c.sobject, step.id);
      c.sobject = v;
      if (auto) {
        const next = suggestAlias(v, step.id);
        setStepAlias(wf, step.id, next, { memo: aliasMemo, slotKeys });
        const input = form.querySelector('[data-key="alias"]');
        if (input) input.value = next;
      }
    } else if (key === 'alias' && (step.type === 'record' || step.type === 'loop')) {
      // References follow only to a valid, free name (a loop variable: inside its body only);
      // while the field is empty or matches another alias mid-typing, they stay put.
      setStepAlias(wf, step.id, v, { memo: aliasMemo, slotKeys });
    } else c[key] = v;
  }, { source: 'inspector', coalesceKey: `${step.id}:${key}` });
  // Card summary/alias changed; the process view re-renders, the inspector keeps focus.
}

/** Parent choices for Lookup "Bản ghi cha" at this step (usable first, nearest first). */
function parentChoices(step) {
  return recordChoices(recordScope(), step.id).map((c) => ({
    alias: c.alias,
    sobject: c.sobject,
    usable: c.usable,
    note: c.usable ? (c.state === 'maybe' ? 'có thể chưa có' : '') : HIDDEN_REASON[c.state] ?? '',
  }));
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
  const aliases = parentChoices(node);

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
            oninput: (e) => {
              updateWorkflow(() => {
                f.name = e.target.value.trim();
              }, { source: 'inspector', coalesceKey: `${key}:name` });
              card.dataset.field = `fields.${f.name}`;
            },
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
            h('button', { title: 'Xóa field', onclick: () => structural(() => fields.splice(i, 1)) }, '✕'),
          ),
        ),
      );
      if (open && ft) {
        card.append(
          h(
            'div',
            { class: 'opts' },
            renderOptions(ft.options, f.options ?? {}, (k, v) =>
              updateWorkflow(() => {
                f.options = { ...(f.options ?? {}), [k]: v };
              }, { source: 'inspector', coalesceKey: `${key}:${k}` }),
              { aliases },
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
    {},
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
  const issues = [...state.issues.errors].filter((i) => i.nodeId === s.id);
  for (const card of root.querySelectorAll('.field-card')) {
    const mine = issues.filter((i) => i.field === card.dataset.field);
    card.classList.toggle('has-error', mine.length > 0);
    const text = card.querySelector('.error-text');
    text.hidden = !mine.length;
    text.textContent = mine.map((i) => i.message).join(' ');
  }
  for (const input of root.querySelectorAll('.options [data-key]')) {
    if (input.closest('.field-card')) continue;
    input.classList.toggle('invalid', issues.some((i) => i.field === input.dataset.key));
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

function renderImportList(node, described, box, modal) {
  const existing = new Set((node.config.fields ?? []).map((f) => f.name.toLowerCase()));
  const aliases = parentChoices(node);
  const rows = described.fields.map((f) => {
    const has = existing.has(f.name.toLowerCase());
    const cb = h('input', { type: 'checkbox', checked: f.required && !has, disabled: has });
    let parentSel = null;
    if (f.type === 'lookup' || f.type === 'masterdetail') {
      // Auto-pick only among parents usable at this position (above, not in the other branch, on).
      const matches = aliases.filter((a) => a.usable && f.referenceTo?.includes(a.sobject));
      const usable = aliases.filter((a) => a.usable);
      const other = aliases.filter((a) => !a.usable);
      parentSel = h(
        'select',
        { title: 'Bản ghi cha' },
        h('option', { value: '' }, '— bản ghi cha —'),
        usable.map((a) => h('option', { value: a.alias, selected: matches.length === 1 && matches[0].alias === a.alias }, `${a.alias} (${a.sobject})${a.note ? ` · ${a.note}` : ''}`)),
        other.length
          ? h('optgroup', { label: 'Không dùng được ở vị trí này' }, other.map((a) => h('option', { value: a.alias, disabled: true, title: a.note }, `${a.alias} (${a.sobject}) · ${a.note}`)))
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
    style: { width: '100%', margin: '8px 0' },
    oninput: (e) => {
      const q = e.target.value.toLowerCase();
      for (const r of rows) r.el.hidden = q && !`${r.f.name} ${r.f.label}`.toLowerCase().includes(q);
    },
  });
  box.replaceChildren(
    h('p', { class: 'hint' }, 'Field bắt buộc đã được chọn sẵn. Field Lookup tự chọn bản ghi cha nếu chỉ có một bước Record phía trên khớp sObject.'),
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
          updateWorkflow(() => {
            node.config.sobject = described.sobject;
            if (!node.config.alias) node.config.alias = suggestAlias(described.sobject, node.id);
            for (const r of picked) {
              const options = { ...r.f.options };
              if (r.parentSel) options.ref = r.parentSel.value;
              node.config.fields.push({ name: r.f.name, type: r.f.type, options });
            }
          }, { source: 'inspector-structure' });
          modal.close();
          toast(`Đã thêm ${picked.length} field.`);
        },
      }, 'Thêm field đã chọn'),
    ),
  );
}

