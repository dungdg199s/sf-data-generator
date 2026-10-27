// Renders option forms from server-provided option definitions (generators/common.js format).
// The UI never hard-codes per-type options: adding a generator on the server is enough.

import { h } from './dom.js';

let uid = 0;

/**
 * @param defs     option definitions
 * @param values   current values (missing → default shown)
 * @param onChange (key, value) => void
 * @param ctx      { aliases: [{ alias, sobject, usable, note }], invalidKeys: Set }
 *                 aliases feed `ref` dropdowns; `usable: false` ones are listed disabled, with
 *                 `note` saying why (below this step, other branch, turned off).
 */
export function renderOptions(defs, values, onChange, ctx = {}) {
  const root = h('div', { class: 'options' });
  const rows = [];
  const current = { ...Object.fromEntries(defs.map((d) => [d.key, d.default])), ...values };

  const refreshVisibility = () => {
    for (const { def, row } of rows) row.hidden = def.showIf ? !def.showIf.in.includes(current[def.showIf.key]) : false;
  };

  for (const def of defs) {
    const id = `opt-${++uid}`;
    const set = (v) => {
      current[def.key] = v;
      onChange(def.key, v);
      refreshVisibility();
    };
    const control = renderControl(def, values?.[def.key], set, id, ctx);
    control.dataset.key = def.key;
    const row =
      def.kind === 'boolean'
        ? h('div', { class: 'form-row check' }, control, h('label', { for: id }, def.label), def.help && h('div', { class: 'help', style: { gridColumn: '1 / -1' } }, def.help))
        : h('div', { class: 'form-row' }, h('label', { for: id }, def.label), control, def.help && h('div', { class: 'help' }, def.help));
    if (ctx.invalidKeys?.has(def.key)) control.classList.add('invalid');
    rows.push({ def, row });
    root.append(row);
  }
  refreshVisibility();
  return root;
}

function renderControl(def, value, set, id, ctx) {
  const v = value ?? def.default;
  switch (def.kind) {
    case 'boolean':
      return h('input', { id, type: 'checkbox', checked: Boolean(v), onchange: (e) => set(e.target.checked) });
    case 'integer':
    case 'number':
      return h('input', {
        id,
        type: 'number',
        value: v ?? '',
        min: def.min,
        max: def.max,
        step: def.step ?? (def.kind === 'integer' ? 1 : 'any'),
        oninput: (e) => set(e.target.value === '' ? undefined : Number(e.target.value)),
      });
    case 'select':
      return h(
        'select',
        { id, onchange: (e) => set(e.target.value) },
        def.choices.map((c) => h('option', { value: c.value, selected: c.value === v }, c.label)),
      );
    case 'list':
    case 'numberList':
      return h('textarea', {
        id,
        rows: 3,
        value: Array.isArray(v) ? v.join('\n') : v ?? '',
        oninput: (e) => {
          const items = e.target.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
          set(def.kind === 'numberList' ? items.map(Number) : items);
        },
      });
    case 'text':
      return h('textarea', { id, rows: 3, value: v ?? '', oninput: (e) => set(e.target.value) });
    case 'ref': {
      const aliases = ctx.aliases ?? [];
      const usable = aliases.filter((a) => a.usable !== false);
      const other = aliases.filter((a) => a.usable === false);
      const text = (a) => `${a.alias} (${a.sobject || '?'})${a.note ? ` · ${a.note}` : ''}`;
      const sel = h(
        'select',
        { id, onchange: (e) => set(e.target.value) },
        h('option', { value: '' }, usable.length ? '— chọn bản ghi cha —' : '— chưa có bước Record nào phía trên —'),
        usable.map((a) => h('option', { value: a.alias, selected: a.alias === v, title: a.note || undefined }, text(a))),
        other.length
          ? h(
            'optgroup',
            { label: 'Không dùng được ở vị trí này' },
            // The current value stays selectable so it is shown (and flagged by validation).
            other.map((a) => h('option', { value: a.alias, disabled: a.alias !== v, selected: a.alias === v, title: a.note || undefined }, text(a))),
          )
          : null,
      );
      // Keep a value pointing at a since-renamed alias visible instead of silently dropping it.
      if (v && !aliases.some((a) => a.alias === v)) sel.append(h('option', { value: v, selected: true }, `${v} (không tồn tại)`));
      return sel;
    }
    case 'time':
      return h('input', { id, type: 'time', value: v ?? '', oninput: (e) => set(e.target.value) });
    default:
      return h('input', { id, type: 'text', value: v ?? '', oninput: (e) => set(e.target.value) });
  }
}
