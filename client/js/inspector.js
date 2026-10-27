// Right-hand panel: configuration for the selected node/edge, or workflow tips when nothing
// is selected. Edits made here emit source 'inspector' and do not trigger a re-render, so
// focus survives typing; structural edits (add/remove/reorder fields) use 'inspector-structure'.

import { h, toast } from './dom.js';
import { renderOptions } from './forms.js';
import { api } from './api.js';
import {
  state, subscribe, updateWorkflow, nodeById, nodeType, fieldType, recordAliases, suggestAlias, edgeId, NODE_COLORS,
} from './store.js';
import { deleteSelection, duplicateSelection } from './canvas.js';

let root;
const expanded = new Set(); // `${nodeId}:${fieldIndex}` with options panel open

export function initInspector() {
  root = document.getElementById('inspector');
  subscribe(({ source, kind }) => {
    if (kind === 'issues') return markIssues();
    if (source === 'inspector' || source === 'canvas-drag') return;
    render();
  });
  render();
}

function render() {
  const s = state.selection;
  if (s?.kind === 'node' && nodeById(s.id)) root.replaceChildren(renderNode(nodeById(s.id)));
  else if (s?.kind === 'edge') root.replaceChildren(renderEdge(s.id));
  else root.replaceChildren(renderEmpty());
  markIssues();
}

function renderEmpty() {
  return h(
    'div',
    {},
    h('h3', {}, 'Bắt đầu nhanh'),
    h(
      'ol',
      { class: 'hint' },
      h('li', {}, 'Chọn node Bắt đầu, bấm "Record" ở cột trái để thêm và tự nối.'),
      h('li', {}, 'Chọn org ở thanh trên rồi "Import từ org…" để lấy field có sẵn.'),
      h('li', {}, 'Bấm ▶ Xem trước (Ctrl+Enter) để kiểm tra dữ liệu trước khi insert.'),
    ),
    h('h3', {}, 'Phím tắt'),
    h(
      'ul',
      { class: 'hint' },
      h('li', {}, 'Delete: xóa node/cạnh đang chọn'),
      h('li', {}, 'Ctrl+D: nhân bản node'),
      h('li', {}, 'Ctrl+Z / Ctrl+Shift+Z: hoàn tác / làm lại'),
      h('li', {}, 'Ctrl+S: tải workflow JSON'),
      h('li', {}, 'Kéo nền để di chuyển, cuộn chuột để zoom'),
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

function renderEdge(id) {
  const e = state.workflow.edges.find((x) => edgeId(x) === id);
  if (!e) return renderEmpty();
  const from = nodeById(e.from);
  const to = nodeById(e.to);
  const portLabel = nodeType(from?.type)?.outputs.find((p) => p.port === (e.fromPort ?? 'next'))?.label;
  return h(
    'div',
    {},
    h('div', { class: 'node-head' }, h('h2', {}, 'Cạnh nối')),
    h('p', { class: 'desc' }, `${label(from)}${portLabel ? ` (${portLabel})` : ''} → ${label(to)}`),
    h('div', { class: 'btn-row' }, h('button', { class: 'danger', onclick: deleteSelection }, 'Xóa cạnh (Delete)')),
  );
}

const label = (n) => (n ? `${nodeType(n.type)?.label ?? n.type}${n.config?.alias ? ` "${n.config.alias}"` : ''}` : '?');

function renderNode(node) {
  const type = nodeType(node.type);
  const wrap = h(
    'div',
    {},
    h(
      'div',
      { class: 'node-head' },
      h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: NODE_COLORS[node.type] } }),
      h('h2', {}, type?.label ?? node.type),
      h('div', { class: 'spacer' }),
      node.type !== 'start' && h('button', { class: 'icon', title: 'Nhân bản (Ctrl+D)', onclick: duplicateSelection }, '⧉'),
      node.type !== 'start' && h('button', { class: 'icon danger', title: 'Xóa (Delete)', onclick: deleteSelection }, '✕'),
    ),
    h('p', { class: 'desc' }, type?.description ?? ''),
  );
  if (!type?.options.length && node.type !== 'record') return wrap;

  const form = renderOptions(type.options, node.config ?? {}, (key, v) => onNodeOption(node, key, v, form), {});
  wrap.append(form);
  if (node.type === 'record') wrap.append(renderFields(node));
  return wrap;
}

function onNodeOption(node, key, v, form) {
  updateWorkflow((wf) => {
    const c = node.config;
    if (key === 'sobject') {
      // Keep the alias in sync while it is still the auto-suggested one.
      const auto = !c.alias || c.alias === suggestAlias(c.sobject, node.id);
      c.sobject = v;
      if (auto) {
        const next = suggestAlias(v, node.id);
        renameAlias(wf, c.alias, next);
        c.alias = next;
        const input = form.querySelector('[data-key="alias"]');
        if (input) input.value = next;
      }
    } else if (key === 'alias') {
      renameAlias(wf, c.alias, v);
      c.alias = v;
    } else c[key] = v;
  }, { source: 'inspector', coalesceKey: `${node.id}:${key}` });
  // Node card summary/alias changed; re-render canvas only (inspector keeps focus).
}

/** Renaming an alias updates lookups and {{alias.X}} templates/conditions that used it. */
function renameAlias(wf, from, to) {
  if (!from || from === to) return;
  const re = new RegExp(`\\{\\{\\s*${from}\\.`, 'g');
  for (const n of wf.nodes) {
    for (const f of n.config?.fields ?? []) {
      if (f.options?.ref === from) f.options.ref = to;
      if (typeof f.options?.template === 'string') f.options.template = f.options.template.replace(re, `{{${to}.`);
    }
    if (n.type === 'branch' && typeof n.config?.left === 'string' && n.config.left.startsWith(`${from}.`)) {
      n.config.left = to + n.config.left.slice(from.length);
    }
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
  const aliases = recordAliases(node.id);

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
  if (s?.kind !== 'node') return;
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
  const aliases = recordAliases(node.id);
  const rows = described.fields.map((f) => {
    const has = existing.has(f.name.toLowerCase());
    const cb = h('input', { type: 'checkbox', checked: f.required && !has, disabled: has });
    let parentSel = null;
    if (f.type === 'lookup' || f.type === 'masterdetail') {
      const matches = aliases.filter((a) => f.referenceTo?.includes(a.sobject));
      parentSel = h(
        'select',
        { title: 'Node cha' },
        h('option', { value: '' }, '— node cha —'),
        aliases.map((a) => h('option', { value: a.alias, selected: matches.length === 1 && matches[0].alias === a.alias }, `${a.alias} (${a.sobject})`)),
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
    h('p', { class: 'hint' }, 'Field bắt buộc đã được chọn sẵn. Field Lookup tự chọn node cha nếu chỉ có một node khớp sObject.'),
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

