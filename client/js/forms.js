// Renders option forms from server-provided option definitions (generators/common.js format).
// The UI never hard-codes per-type options: adding a generator on the server is enough.

import { h } from './dom.js';
import { attachVarPicker } from './var-picker.js';

let uid = 0;

/**
 * @param defs     option definitions
 * @param values   current values (missing → default shown)
 * @param onChange (key, value, meta?) => void; meta.coalesceKey is set for a variable insertion
 *                 (its own undo step)
 * @param ctx      { aliases: [{ alias, sobject, usable, note }], refChoices?(def, values), invalidKeys: Set,
 *                   vars?: { stepId, fieldIndex?, fieldName?, field } }
 *                 aliases (or refChoices) feed `ref` dropdowns; `usable: false` ones are listed
 *                 disabled, with `note` saying why (below this step, other branch, turned off).
 *                 Options declaring `vars` get the variable picker (var-picker.js) for `ctx.vars`.
 */
export function renderOptions(defs, values, onChange, ctx = {}) {
  const root = h('div', { class: 'options' });
  const rows = [];
  const current = { ...Object.fromEntries(defs.map((d) => [d.key, d.default])), ...values };

  // `ref` dropdowns may depend on sibling options (Lookup referenceTo): rebuild them in place.
  const refreshRefs = (changed) => {
    if (!ctx.refChoices) return;
    for (const { def, row } of rows) {
      if (def.kind !== 'ref' || def.key === changed) continue;
      const old = row.querySelector(`[data-key="${CSS.escape(def.key)}"]`);
      if (!old) continue;
      const next = renderControl(def, current[def.key], old._set, old.id, ctx, current);
      next.dataset.key = def.key;
      next._set = old._set;
      next.className = old.className;
      old.replaceWith(next);
    }
  };
  const refreshVisibility = () => {
    for (const { def, row } of rows) row.hidden = def.showIf ? !def.showIf.in.includes(current[def.showIf.key]) : false;
  };

  for (const def of defs) {
    const id = `opt-${++uid}`;
    const set = (v, meta) => {
      current[def.key] = v;
      onChange(def.key, v, meta);
      refreshVisibility();
      refreshRefs(def.key);
    };
    const control = renderControl(def, values?.[def.key], set, id, ctx, current);
    control.dataset.key = def.key;
    control._set = set;
    let field = control;
    let strip = null;
    if (def.vars && ctx.vars && (def.kind === 'string' || def.kind === undefined)) {
      // Getters, not a spread: the field can be renamed while this form stays on screen.
      const vctx = ctx.vars;
      ({ wrap: field, strip } = attachVarPicker(control, {
        get stepId() { return vctx.stepId; },
        get fieldIndex() { return vctx.fieldIndex; },
        get fieldName() { return vctx.fieldName; },
        get field() { return vctx.field ?? def.key; },
        option: def.key,
        mode: def.vars,
        unsaved: values?.[def.key] === undefined || values?.[def.key] === '',
      }));
    }
    const row =
      def.kind === 'boolean'
        ? h('div', { class: 'form-row check' }, control, h('label', { for: id }, def.label), def.help && h('div', { class: 'help', style: { gridColumn: '1 / -1' } }, def.help))
        : h('div', { class: 'form-row' }, h('label', { for: id }, def.label), field, strip, def.help && h('div', { class: 'help' }, def.help), ctx.vars && !ctx.vars.fieldName && def.vars ? h('div', { class: 'opt-error', hidden: true }) : null);
    if (ctx.invalidKeys?.has(def.key)) control.classList.add('invalid');
    rows.push({ def, row });
    root.append(row);
  }
  refreshVisibility();
  return root;
}

let insertSeq = 0;

function renderControl(def, value, set, id, ctx, current) {
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
      const aliases = (ctx.refChoices ? ctx.refChoices(def, current) : ctx.aliases) ?? [];
      const usable = aliases.filter((a) => a.usable !== false);
      const other = aliases.filter((a) => a.usable === false);
      const text = (a) => `${a.alias} (${a.sobject || '?'})${a.note ? `${a.usable === false ? ' — ' : ' · '}${a.note}` : ''}`;
      const sel = h(
        'select',
        { id, onchange: (e) => set(e.target.value) },
        h('option', { value: '' }, usable.length ? '— chọn bản ghi cha —' : '— chưa có bước Record nào phía trên —'),
        usable.map((a) => h('option', { value: a.alias, selected: a.alias === v, title: a.note || undefined }, text(a))),
        other.length
          ? h(
            'optgroup',
            { label: 'Không dùng được ở đây' },
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
      return h('input', {
        id,
        type: 'text',
        value: v ?? '',
        // A variable inserted by the picker is its own undo step (not merged with typing).
        oninput: (e) => set(e.target.value, e.target._varInsert ? { coalesceKey: `insert:${++insertSeq}` } : undefined),
      });
  }
}
