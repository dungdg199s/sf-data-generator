// Variable scope analysis (design 0005): which variables a step can use, and what every
// reference in the workflow points at. One pure function, `analyzeScope`, is the single source
// of truth for validation (server/workflow/schema.js), the Lookup "Bản ghi cha" dropdown, the
// variable picker and rename/delete propagation (browser). Pure: no DOM, no I/O; imports only
// shared/soql.js (the field list of a Query step).
//
// It knows nothing about specific step types: the catalogue says what each type provides
// (`exposes`) and how its slots run (`flow`), see server/workflow/nodes.js:
//   flow.kind  'sequence'                 → no children (or children run in order)
//              'loop'    (body)           → slots[body] runs N ≥ minIterations(config) times
//              'branch'  (alternatives)   → exactly one of the slots runs
//   exposes    { kind: 'record' | 'vars', name: { key, default?, fallback? }, label, visibleIn:
//                'downstream' | { inside: <slot> }, members, builtins?, current, pool, origin,
//                lookupParent, open? }
// `catalog` is { nodeTypes, fieldTypes } as served by /api/meta (server: its own catalogue).
//
// Certainty of a source at a step (visible):
//   always — on every path to the step the source ran before, in the same or an enclosing sequence
//   last   — always there, but created in the body of a loop that already finished (last iteration)
//   maybe  — only on some paths (created in one branch column, or in a loop that may run 0 times)
// Reason a source is hidden at a step:
//   after       — runs after the step, or is the step itself
//   otherBranch — in the other column of a branch that encloses the step
//   outsideLoop — a loop variable of a loop whose body does not contain the step
//   shadowed    — a loop variable hidden by an inner loop with the same name
//   disabled    — the source, or a container around it, is turned off

import { selectFields, soqlSobject } from './soql.js';

/** Template token `{{path}}` (also served as meta.syntax.templateToken; server/workflow/paths.js re-exports it). */
export const TEMPLATE_TOKEN_SOURCE = '\\{\\{\\s*([\\w.$]+)\\s*\\}\\}';
export const templateTokenRe = () => new RegExp(TEMPLATE_TOKEN_SOURCE, 'g');

const RANK = { always: 0, last: 1, maybe: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Lowest number of times a loop body runs (0 when it may be skipped). */
export function loopMinIterations(config = {}) {
  const c = config ?? {};
  if ((c.mode ?? 'fixed') === 'range') return Math.max(0, Number(c.min ?? 1)) || 0;
  return Math.max(0, Number(c.count ?? 0)) || 0;
}

/** Per-type helpers that cannot travel through /api/meta (functions). */
const MIN_ITERATIONS = { loop: loopMinIterations };
const VAR_EXAMPLES = {
  loop(c = {}) {
    const range = (c.mode ?? 'fixed') === 'range';
    const lo = Number(range ? c.min ?? 1 : c.count ?? 0) || 0;
    const hi = Number(range ? c.max ?? 1 : c.count ?? 0) || 0;
    const times = range ? `${lo}–${hi}` : `${hi}`;
    return {
      label: `Vòng lặp ${times} lần`,
      examples: { index: hi >= 1 ? `1…${hi}` : '—', index0: hi >= 1 ? `0…${hi - 1}` : '—', count: times },
    };
  },
};
const BUILTIN_EXAMPLES = { $n: '1, 2, 3…' };

/** `{{loop.index}}` → `loop.index` (a branch `left` may be written either way). */
export function stripPath(value) {
  const s = String(value ?? '').trim();
  const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(s);
  return (m ? m[1] : s).trim();
}

/** Text and `{{path}}` tokens of a template, with offsets. */
export function tokenize(text) {
  const s = String(text ?? '');
  const out = [];
  const re = templateTokenRe();
  let last = 0;
  for (let m; (m = re.exec(s));) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index), start: last, end: m.index });
    out.push({ kind: 'token', path: m[1], text: m[0], start: m.index, end: re.lastIndex });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last), start: last, end: s.length });
  return out;
}

/** A "{{" left as plain text (not closed, or not a valid token). */
export function hasUnclosed(text) {
  return tokenize(text).some((p) => p.kind === 'text' && p.text.includes('{{'));
}

function catalogMaps(catalog) {
  return {
    nodeTypes: new Map((catalog?.nodeTypes ?? []).map((t) => [t.type, t])),
    fieldTypes: new Map((catalog?.fieldTypes ?? []).map((t) => [t.type, t])),
  };
}

const shown = (def, values) => !def.showIf || def.showIf.in.includes(values[def.showIf.key]);
const isRefOption = (def) => Boolean(def.vars) || def.kind === 'ref';

/**
 * Every option of `step` that holds variable references (`vars: 'template' | 'path'`) or a
 * source name (`kind: 'ref'`), as currently in effect (hidden options are skipped; generator
 * options fall back to their default like the executor). Each item can write its value back.
 * → [{ field, option, mode, def, value, fieldIndex?, fieldName?, set(v) }]
 */
export function referenceOptions(step, catalog, { includeHidden = false } = {}) {
  const cat = catalog?.nodeTypes instanceof Map ? catalog : catalogMaps(catalog);
  const out = [];
  const c = step?.config ?? {};
  const type = cat.nodeTypes.get(step?.type);
  for (const def of type?.options ?? []) {
    if (!isRefOption(def)) continue;
    const values = { ...Object.fromEntries((type.options ?? []).map((d) => [d.key, d.default])), ...c };
    const isShown = shown(def, values);
    if (!includeHidden && !isShown) continue;
    out.push({
      field: def.key, option: def.key, mode: def.vars ?? 'ref', def, value: c[def.key], hidden: !isShown,
      set: (v) => { (step.config ??= {})[def.key] = v; },
    });
  }
  const fields = Array.isArray(c.fields) ? c.fields : [];
  fields.forEach((f, fieldIndex) => {
    if (!f || typeof f !== 'object') return;
    const ft = cat.fieldTypes.get(f.type);
    const opts = f.options && typeof f.options === 'object' ? f.options : {};
    const values = {};
    for (const d of ft?.options ?? []) {
      const raw = opts[d.key];
      values[d.key] = raw === undefined || raw === null || raw === '' ? d.default : raw;
    }
    for (const def of ft?.options ?? []) {
      if (!isRefOption(def)) continue;
      const isShown = shown(def, values);
      if (!includeHidden && !isShown) continue;
      out.push({
        field: `fields.${f.name}`, option: def.key, mode: def.vars ?? 'ref', def, value: values[def.key], hidden: !isShown,
        stored: opts[def.key], fieldIndex, fieldName: f.name,
        set: (v) => { f.options = { ...(f.options ?? {}), [def.key]: v }; },
      });
    }
  });
  return out;
}

/** Paths referenced by one option value: [{ path, start?, end? }]. */
export function pathsIn(mode, value) {
  if (value === undefined || value === null || value === '') return [];
  if (mode === 'template') return tokenize(value).filter((p) => p.kind === 'token').map((p) => ({ path: p.path, start: p.start, end: p.end }));
  const path = mode === 'path' ? stripPath(value) : String(value).trim();
  return path ? [{ path }] : [];
}

/** Levenshtein distance, capped (enough for "Did you mean"). */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest candidate: same name ignoring case, else at most 2 edits away. */
export function closest(name, candidates) {
  const lower = String(name).toLowerCase();
  const list = [...new Set(candidates)].filter((c) => c && c !== name);
  const ci = list.find((c) => c.toLowerCase() === lower);
  if (ci) return ci;
  // Short names need a closer match ("i" is not a typo of "z").
  let best = null;
  let bestD = Math.min(2, Math.floor(lower.length / 2)) + 1;
  for (const c of list) {
    const d = distance(lower, c.toLowerCase());
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function sourceName(step, ex) {
  const n = ex.name ?? {};
  const v = n.key ? step.config?.[n.key] : undefined;
  if (v) return String(v);
  if (n.default) return n.default;
  return n.fallback === 'id' || !n.key ? String(step.id) : '';
}

/** Members of a SELECT field list (`Owner.Name` → member Owner with member Name). */
function selectMembers(fields) {
  const list = Array.isArray(fields) ? fields : String(fields ?? '').split(/[\s,]+/);
  const root = [];
  for (const raw of list) {
    const parts = String(raw?.name ?? raw ?? '').trim().split('.').filter(Boolean);
    let level = root;
    parts.forEach((key, i) => {
      let m = level.find((x) => x.key === key);
      if (!m) {
        m = { key, valueType: 'any' };
        level.push(m);
      }
      if (i < parts.length - 1) level = (m.members ??= []);
    });
  }
  return root;
}

function buildSource(step, type, cat, off) {
  const ex = type.exposes;
  const c = step.config ?? {};
  const src = {
    nodeId: step.id,
    nodeType: step.type,
    kind: ex.kind,
    name: sourceName(step, ex),
    label: typeof ex.label === 'string' ? ex.label : ex.label?.key ? c[ex.label.key] ?? '' : '',
    current: ex.current ?? (ex.kind === 'record' ? 'last' : undefined),
    pool: ex.pool === true,
    origin: ex.origin ?? null,
    lookupParent: ex.lookupParent === true,
    open: ex.open === true,
    visibleIn: ex.visibleIn ?? 'downstream',
    disabled: off,
    members: [],
  };
  if (ex.label?.key === 'sobject' || type.options?.some((o) => o.key === 'sobject')) src.sobject = c.sobject ?? '';
  if (ex.kind === 'vars') {
    const ex2 = VAR_EXAMPLES[step.type]?.(c);
    if (ex2 && typeof ex.label === 'string') src.label = ex2.label;
    src.members = (Array.isArray(ex.members) ? ex.members : []).map((m) => ({ ...m, ...(ex2?.examples?.[m.key] ? { example: ex2.examples[m.key] } : {}) }));
  } else if (ex.members === 'fields') {
    src.members = (Array.isArray(c.fields) ? c.fields : []).filter((f) => f?.name).map((f) => {
      const ft = cat.fieldTypes.get(f.type);
      const m = { key: f.name, type: f.type, valueType: ft?.valueType ?? 'string' };
      if (ft?.members) m.members = ft.members;
      if (m.valueType === 'reference' && f.options?.ref) m.ref = f.options.ref;
      return m;
    });
  } else if (ex.members === 'select') {
    // Query (0006): builder fields (Id always first) or the SELECT list of hand-written SOQL;
    // FIELDS(...) / TYPEOF make the list open (unknown fields are only a warning).
    const sel = selectFields(c);
    src.members = selectMembers(sel.fields);
    if (sel.open) src.open = true;
    src.sobject = soqlSobject(c);
    if (ex.label?.key === 'sobject') src.label = src.sobject;
  } else if (Array.isArray(ex.members)) {
    src.members = ex.members.map((m) => ({ ...m }));
  }
  for (const b of ex.builtins ?? []) src.members.push({ ...b, builtin: true, ...(BUILTIN_EXAMPLES[b.key] ? { example: BUILTIN_EXAMPLES[b.key] } : {}) });
  // { fromSource: <optionKey> } members / label / origin are filled in once every source is known.
  src._from = ['members', 'label', 'origin'].filter((k) => ex[k]?.fromSource).map((k) => [k, c[ex[k].fromSource]]);
  return src;
}

const NOTES = {
  after: 'chạy sau bước này',
  self: 'là chính bước này',
  otherBranch: 'ở nhánh còn lại của Rẽ nhánh',
  disabled: 'đang tắt',
};

/**
 * @returns {{
 *   partial: false,
 *   sources: Record<stepId, source>,
 *   at: Record<stepId, { self, disabled, state(sourceId), varSource(name), visible: [{ source, certainty, note? }], hidden: [{ source, reason, note }] }>,
 *   (visible / hidden are computed on first access)
 *   refs: [{ nodeId, field, option, mode, path, name, member, fieldIndex?, disabled, hidden?, source, certainty?, reason?,
 *            code?, level?, suggestion?, why? }]
 *   (`hidden`: the option is hidden by its showIf — not validated, but still followed by renames)
 * }}
 */
export function analyzeScope(wf, catalog) {
  const cat = catalogMaps(catalog);
  const typeOf = (step) => cat.nodeTypes.get(step?.type);
  const slotsOf = (step) => {
    const declared = typeOf(step)?.slots?.map((s) => s.key) ?? [];
    return declared.length ? declared : Object.keys(step?.slots ?? {});
  };
  const isStep = (s) => s && typeof s === 'object' && !Array.isArray(s) && s.id !== undefined && s.id !== null && s.id !== '';

  const sources = {};
  const steps = []; // { step, off }
  const collect = (list, off) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (!isStep(step)) continue;
      const stepOff = off || step.disabled === true;
      steps.push({ step, off: stepOff });
      const type = typeOf(step);
      if (type?.exposes && !sources[step.id]) sources[step.id] = buildSource(step, type, cat, stepOff);
      for (const k of slotsOf(step)) collect(step.slots?.[k], stepOff);
    }
  };
  collect(wf?.steps, false);

  const byName = new Map(); // name → [source] in reading order
  for (const s of Object.values(sources)) {
    if (!s.name) continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  for (const s of Object.values(sources)) {
    for (const [key, refName] of s._from) {
      const from = (byName.get(refName) ?? []).find((x) => x.kind === 'record' && x !== s);
      if (!from) continue;
      // A pick (0006) remembers its pool and the step the rows come from (a Query or a Record).
      s.from = from.name;
      s.root = from.root ?? from.nodeId;
      if (key === 'members') {
        s.members = [...from.members.filter((m) => !m.builtin), ...s.members];
        if (from.open) s.open = true;
      }
      if (key === 'label') s.label = from.label;
      if (key === 'origin') s.origin = from.origin;
      if (key === 'label' && from.sobject !== undefined) s.sobject = from.sobject;
    }
    delete s._from;
  }

  // Downstream sources defined anywhere inside a list (for "the other branch").
  const definedIn = (list, out = new Set()) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (!isStep(s)) continue;
      if (sources[s.id]?.visibleIn === 'downstream') out.add(s.id);
      for (const k of slotsOf(s)) definedIn(s.slots?.[k], out);
    }
    return out;
  };

  // Downstream state is a persistent chain (each set pushes a node onto the current head), so a
  // step only keeps a pointer to the head instead of a copy: the analysis stays linear in the
  // workflow size. Lookups use the chain tree's DFS intervals; `visible`/`hidden` are built
  // lazily, only for the steps a UI asks about.
  let seq = 0;
  const ROOT = { id: null, entry: null, prev: null, kids: [] };
  const nodesOf = new Map(); // source id → chain nodes setting it
  const push = (head, id, entry) => {
    const n = { id, entry, prev: head, kids: [] };
    head.kids.push(n);
    if (!nodesOf.has(id)) nodesOf.set(id, []);
    nodesOf.get(id).push(n);
    return n;
  };
  /** Entries added on top of `base` up to `head`, latest per id. */
  const addedSince = (head, base) => {
    const out = new Map();
    for (let n = head; n && n !== base; n = n.prev) if (!out.has(n.id)) out.set(n.id, n.entry);
    return out;
  };
  const raw = new Map(); // stepId → { head, vars, others, off }
  function walk(list, head, vars, others, off) {
    for (const step of Array.isArray(list) ? list : []) {
      if (!isStep(step)) continue;
      const stepOff = off || step.disabled === true;
      if (!raw.has(step.id)) raw.set(step.id, { head, vars, others, off: stepOff });
      const type = typeOf(step);
      const keys = slotsOf(step);
      const flow = type?.flow ?? { kind: keys.length ? 'branch' : 'sequence' };
      let added = null;
      if (flow.kind === 'loop' && keys.length) {
        const body = flow.body ?? keys[0];
        const src = sources[step.id];
        const innerVars = src?.kind === 'vars' && src.visibleIn?.inside === body ? [...vars, { id: step.id, name: src.name, seq: ++seq }] : vars;
        const inner = addedSince(walk(step.slots?.[body], head, innerVars, others, stepOff), head);
        const minFn = typeof type.minIterations === 'function' ? type.minIterations : MIN_ITERATIONS[step.type];
        const once = (minFn ? minFn(step.config ?? {}) : 0) >= 1;
        const loopName = src?.name ?? step.id;
        added = new Map();
        for (const [id, e] of inner) {
          added.set(id, once ? { ...e, certainty: worse('last', e.certainty) } : { ...e, certainty: 'maybe', why: e.why ?? { loop: loopName, loopId: step.id, range: (step.config?.mode ?? 'fixed') === 'range' } });
        }
      } else if (keys.length && flow.kind !== 'sequence') {
        const alts = flow.alternatives ?? keys;
        const results = alts.map((key, i) => {
          const others2 = new Set(others);
          alts.forEach((k, j) => { if (j !== i) definedIn(step.slots?.[k], others2); });
          return addedSince(walk(step.slots?.[key], head, vars, others2, stepOff), head);
        });
        const ids = new Set(results.flatMap((r) => [...r.keys()]));
        added = new Map();
        for (const id of ids) {
          const all = results.every((r) => r.has(id));
          const entries = results.map((r) => r.get(id)).filter(Boolean);
          const e = entries[0];
          const certainty = all ? entries.map((x) => x.certainty).reduce(worse) : 'maybe';
          const why = certainty === 'maybe' ? entries.find((x) => x.why)?.why ?? (all ? undefined : { branch: step.id }) : undefined;
          const { why: _w, ...rest } = e;
          added.set(id, { ...rest, certainty, ...(why ? { why } : {}) });
        }
      } else if (keys.length) {
        for (const key of keys) head = walk(step.slots?.[key], head, vars, others, stepOff);
      }
      // Turned-off containers contribute nothing to the steps after them.
      if (added && !stepOff) for (const [id, e] of added) head = push(head, id, e);
      const own = sources[step.id];
      if (own && own.visibleIn === 'downstream' && !stepOff) head = push(head, step.id, { certainty: 'always', seq: ++seq });
    }
    return head;
  }
  walk(wf?.steps, ROOT, [], new Set(), false);

  // DFS intervals of the chain tree: node a is on the path to b iff tin[a] <= tin[b] <= tout[a].
  {
    let clock = 0;
    const stack = [[ROOT, 0]];
    ROOT.tin = clock++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [n, k] = top;
      if (k < n.kids.length) {
        top[1]++;
        const c = n.kids[k];
        c.tin = clock++;
        stack.push([c, 0]);
      } else {
        n.tout = clock++;
        stack.pop();
      }
    }
  }
  const entryAt = (head, id) => {
    let best = null;
    for (const n of nodesOf.get(id) ?? []) {
      if (n.tin <= head.tin && head.tin <= n.tout && (!best || n.tin > best.tin)) best = n;
    }
    return best?.entry ?? null;
  };
  const allSources = Object.values(sources);

  const at = {};
  for (const [id, r] of raw) at[id] = makeAt(id, r);

  function makeAt(id, r) {
    let visible = null;
    let hidden = null;
    const varByName = (name) => {
      for (let i = r.vars.length - 1; i >= 0; i--) if (r.vars[i].name === name) return r.vars[i];
      return null;
    };
    /** { certainty, why? } when visible, else { reason }. */
    const state = (sid) => {
      const s = sources[sid];
      if (!s) return { reason: 'after' };
      if (s.kind === 'vars' && s.visibleIn !== 'downstream') {
        // Outside the loop body first: a turned-off loop's variable used elsewhere is "outside".
        if (!r.vars.some((v) => v.id === sid)) return { reason: 'outsideLoop' };
        return varByName(s.name)?.id === sid ? { certainty: 'always' } : { reason: 'shadowed' };
      }
      const e = sid === id ? null : entryAt(r.head, sid);
      if (e) return { certainty: e.certainty, ...(e.why ? { why: e.why } : {}) };
      if (s.disabled) return { reason: 'disabled' };
      if (r.others.has(sid)) return { reason: 'otherBranch' };
      return { reason: 'after' };
    };
    const noteOf = (sid, st) => {
      const s = sources[sid];
      if (st.reason === 'outsideLoop') return `chỉ có bên trong vòng lặp "${s.name}"`;
      if (st.reason === 'shadowed') return `bị vòng lặp "${s.name}" bên trong che`;
      if (st.reason === 'after' && sid === id) return NOTES.self;
      return NOTES[st.reason];
    };
    return {
      self: id,
      disabled: r.off,
      state,
      /** Innermost visible loop variable called `name`, as a source. */
      varSource: (name) => {
        const v = varByName(name);
        return v ? sources[v.id] : null;
      },
      get visible() {
        if (visible) return visible;
        const list = [];
        const seen = new Set();
        const names = new Set();
        for (let i = r.vars.length - 1; i >= 0; i--) {
          const v = r.vars[i];
          if (seen.has(v.id) || names.has(v.name)) continue;
          seen.add(v.id);
          names.add(v.name);
          list.push({ source: v.id, certainty: 'always', seq: v.seq });
        }
        for (let n = r.head; n && n !== ROOT; n = n.prev) {
          if (seen.has(n.id)) continue;
          seen.add(n.id);
          list.push({ source: n.id, certainty: n.entry.certainty, seq: n.entry.seq, ...(n.entry.why ? { why: n.entry.why } : {}) });
        }
        list.sort((a, b) => b.seq - a.seq);
        for (const v of list) {
          delete v.seq;
          if (v.certainty === 'maybe') v.note = v.why?.loop ? `vòng lặp "${v.why.loop}" có thể chạy 0 lần` : 'chỉ được tạo ở một số nhánh phía trên';
          if (v.certainty === 'last') v.note = 'bản ghi cuối';
        }
        visible = list;
        return visible;
      },
      get hidden() {
        if (hidden) return hidden;
        const shown = new Set(this.visible.map((v) => v.source));
        hidden = [];
        for (const s of allSources) {
          if (shown.has(s.nodeId)) continue;
          const st = state(s.nodeId);
          hidden.push({ source: s.nodeId, reason: st.reason ?? 'after', note: noteOf(s.nodeId, st.reason ? st : { reason: 'after' }) });
        }
        return hidden;
      },
    };
  }

  const loopKeys = new Set(allSources.filter((x) => x.kind === 'vars').flatMap((x) => x.members.map((m) => m.key)));
  const refs = [];
  for (const { step, off } of steps) {
    const here = at[step.id];
    if (!here) continue;
    for (const o of referenceOptions(step, cat, { includeHidden: true })) {
      for (const { path } of pathsIn(o.mode, o.value)) {
        const ref = { ...resolveRef({ step, here, o, path, sources, byName, loopKeys }), disabled: off };
        if (o.hidden) ref.hidden = true;
        refs.push(ref);
      }
    }
  }

  return { partial: false, sources, at, refs };
}

/** State of source `id` at `here`: { certainty, why? } or { reason }. */
const stateAt = (here, id) => here.state(id);

/** `ignoreCase`: members of a source read from the org (Salesforce field names ignore case). */
function resolveMember(members, parts, ignoreCase = false) {
  let level = members;
  const same = ignoreCase ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  for (let i = 0; i < parts.length; i++) {
    const m = (level ?? []).find((x) => same(x.key, parts[i]));
    if (!m) return { missing: parts[i], depth: i, candidates: (level ?? []).map((x) => x.key) };
    if (i < parts.length - 1) {
      if (m.members?.length) {
        level = m.members;
        continue;
      }
      return m.valueType === 'reference' ? { traversal: m } : { missing: parts.slice(0, i + 2).join('.'), depth: i, candidates: [] };
    }
    if (i === parts.length - 1) return { ok: true, member: m };
  }
  return { ok: true };
}

function resolveRef({ step, here, o, path, sources, byName, loopKeys }) {
  const parts = String(path).split('.');
  const [name, ...rest] = parts;
  const member = rest.join('.');
  const base = { nodeId: step.id, field: o.field, option: o.option, mode: o.mode, path, name, member, ...(o.fieldIndex !== undefined ? { fieldIndex: o.fieldIndex } : {}) };
  const fail = (code, extra = {}) => ({ ...base, ...extra, code, level: 'error' });

  // Lookup "Bản ghi cha" and other `kind: 'ref'` options: a source name.
  if (o.mode === 'ref') {
    const accepts = o.def?.accepts ?? { lookupParent: true };
    const ok = (s) => Object.entries(accepts).every(([k, v]) => s[k] === v);
    const src = (byName.get(path) ?? []).find((s) => ok(s));
    if (!src) {
      const names = Object.values(sources).filter(ok).map((s) => s.name);
      const hint = closest(path, names);
      return fail('unknownName', hint ? { suggestion: { option: o.option, from: path, to: hint } } : {});
    }
    const st = src.nodeId === step.id ? { reason: 'after' } : stateAt(here, src.nodeId);
    if (st.reason) return fail(st.reason, { source: src.nodeId, reason: st.reason });
    return { ...base, source: src.nodeId, certainty: st.certainty, ...(st.certainty === 'maybe' ? { code: 'maybe', level: 'warning', why: st.why } : {}) };
  }

  // this.Field — fields above the current one in the same record step.
  if (name === 'this') {
    if (o.fieldIndex === undefined) return fail('thisOutsideRecord');
    const fields = (step.config?.fields ?? []).filter((f) => f && typeof f === 'object');
    if (!rest.length) return fail('wholeRecord', { source: step.id, viaThis: true });
    const key = rest[0];
    const builtin = sources[step.id]?.members.find((m) => m.builtin && m.key === key);
    if (builtin) return { ...base, source: step.id, viaThis: true, certainty: 'always' };
    const idx = (step.config?.fields ?? []).findIndex((f) => f?.name === key);
    if (idx === -1) {
      const above = fields.slice(0, o.fieldIndex).map((f) => f.name);
      const hint = closest(key, above.length ? above : fields.map((f) => f.name).filter((n) => n !== o.fieldName));
      return fail('thisUnknown', { source: step.id, viaThis: true, ...(hint ? { suggestion: { option: o.option, from: path, to: ['this', hint, ...rest.slice(1)].join('.') } } : {}) });
    }
    if (idx === o.fieldIndex) return fail('thisSelf', { source: step.id, viaThis: true });
    if (idx > o.fieldIndex) return fail('thisBelow', { source: step.id, viaThis: true });
    const own = sources[step.id];
    if (rest.length > 1 && own) {
      const r = resolveMember(own.members, rest);
      if (r.traversal) return fail('noTraversal', { source: step.id, viaThis: true, traversal: r.traversal.key, traversalRef: r.traversal.ref });
      if (r.missing) return fail('unknownMember', { source: step.id, viaThis: true, missing: r.missing });
    }
    return { ...base, source: step.id, viaThis: true, certainty: 'always' };
  }

  // A loop variable in scope wins (like the executor), then a record alias, then any loop variable.
  const visibleVar = here.varSource(name);
  const candidates = byName.get(name) ?? [];
  const src = visibleVar ?? candidates.find((s) => s.kind !== 'vars') ?? candidates.find((s) => !s.disabled) ?? candidates[0];
  if (!src) {
    // `loop.index` with no loop of that name: a loop variable shape. Point at the enclosing loop,
    // or say the step is not inside any loop.
    const varShaped = rest.length === 1 && (loopKeys.has(rest[0]) || ['index', 'index0', 'count'].includes(rest[0]));
    if (varShaped) {
      const inner = here.visible.map((v) => sources[v.source]).find((x) => x?.kind === 'vars' && x.members.some((m) => m.key === rest[0]));
      if (inner) return fail('unknownName', { suggestion: { option: o.option, from: path, to: `${inner.name}.${rest[0]}` } });
      return fail('outsideLoop', { noLoop: true });
    }
    const visibleNames = here.visible.map((v) => sources[v.source]?.name);
    const hint = closest(name, [...visibleNames, ...(o.fieldIndex !== undefined ? ['this'] : [])]) ?? closest(name, [...byName.keys()]);
    return fail('unknownName', hint ? { suggestion: { option: o.option, from: path, to: [hint, ...rest].join('.') } } : {});
  }
  const withSrc = { source: src.nodeId };

  if (src.nodeId === step.id && o.fieldIndex !== undefined && src.kind === 'record') {
    return fail('selfAlias', { ...withSrc, suggestion: { option: o.option, from: path, to: ['this', ...rest].join('.') } });
  }
  const st = src.nodeId === step.id ? { reason: 'after' } : stateAt(here, src.nodeId);
  if (st.reason) return fail(st.reason, { ...withSrc, reason: st.reason });

  if (!rest.length) return fail('wholeRecord', withSrc);
  if (src.kind === 'vars') {
    const r = resolveMember(src.members, rest);
    if (!r.ok) {
      const hint = closest(member, src.members.map((m) => m.key));
      return fail('unknownMember', { ...withSrc, missing: member, ...(hint ? { suggestion: { option: o.option, from: path, to: `${name}.${hint}` } } : {}) });
    }
  } else {
    const builtin = src.members.find((m) => m.builtin && m.key === rest[0]);
    if (!builtin) {
      if (src.current === 'none') return fail('noCurrent', withSrc);
      const r = resolveMember(src.members, rest, src.origin === 'org');
      // A path option holds one value: not an object member (Query relationship, geolocation).
      if (r.ok && o.mode === 'path' && r.member?.members?.length && r.member.valueType !== 'reference') {
        return fail('wholeRecord', { ...withSrc, objectMember: member, validMembers: r.member.members.map((m) => m.key) });
      }
      if (r.traversal) return fail('noTraversal', { ...withSrc, traversal: r.traversal.key, traversalRef: r.traversal.ref });
      if (r.missing) {
        if (r.depth === 0 && r.missing === 'Id' && src.origin === 'generated') return fail('noIdYet', withSrc);
        if (src.open) return { ...base, ...withSrc, certainty: st.certainty, code: 'openMember', level: 'warning', missing: r.missing };
        const hint = r.candidates.length ? closest(r.missing, r.candidates.filter((k) => !k.startsWith('$'))) : null;
        const to = hint ? [name, ...rest.slice(0, r.depth), hint, ...rest.slice(r.depth + 1)].join('.') : null;
        // A sub-member (Geo__c.lat): name the field and its members instead of "add the field".
        const sub = r.depth > 0 ? { memberOf: rest.slice(0, r.depth).join('.'), validMembers: r.candidates } : {};
        return fail('unknownMember', { ...withSrc, missing: r.missing, ...sub, ...(to ? { suggestion: { option: o.option, from: path, to } } : {}) });
      }
    }
  }
  if (st.certainty === 'maybe') return { ...base, ...withSrc, certainty: 'maybe', code: 'maybe', level: 'warning', ...(st.why ? { why: st.why } : {}) };
  return { ...base, ...withSrc, certainty: st.certainty };
}

/**
 * Choices for a `kind: 'ref'` option at `stepId` (Lookup "Bản ghi cha", 0006 `pick.from`):
 * usable sources first (nearest first), then the others with the reason they cannot be used.
 * `accepts` filters sources by their flags (default: lookupParent).
 * → [{ source, name, sobject, label, nodeType, origin, usable, certainty?, reason?, note }]
 */
export function refChoices(scope, stepId, accepts = { lookupParent: true }) {
  const ok = (s) => s && Object.entries(accepts ?? { lookupParent: true }).every(([k, v]) => s[k] === v);
  const here = scope?.at?.[stepId];
  const pick = (s, extra) => ({ source: s.nodeId, name: s.name, sobject: s.sobject, label: s.label, nodeType: s.nodeType, origin: s.origin, current: s.current, ...(s.from ? { from: s.from } : {}), ...extra });
  const out = [];
  const seen = new Set();
  for (const v of here?.visible ?? []) {
    const s = scope.sources[v.source];
    if (!ok(s)) continue;
    seen.add(s.nodeId);
    out.push(pick(s, { usable: true, certainty: v.certainty, note: v.note ?? '' }));
  }
  for (const s of Object.values(scope?.sources ?? {})) {
    if (!ok(s) || seen.has(s.nodeId) || s.nodeId === stepId) continue;
    const h = here?.hidden.find((x) => x.source === s.nodeId);
    out.push(pick(s, { usable: false, reason: h?.reason ?? 'after', note: h?.note ?? NOTES.after }));
  }
  return out;
}

/** References (from analyzeScope) that point at `sourceId`, optionally at one member. */
export function refsTo(scope, sourceId, member, { includeHidden = false } = {}) {
  return (scope?.refs ?? []).filter((r) => r.source === sourceId && (includeHidden || !r.hidden)
    && (member === undefined || r.member === member || r.member.startsWith(`${member}.`)));
}

/**
 * What a run must remember about record pools (design 0004), worked out from the catalogue so a
 * new step type only has to declare its options:
 *   readers    — names given to a step option `kind: 'ref'` that accepts pools (`accepts.pool`:
 *                Chọn bản ghi `from`, a Lặp over each record of 0010). Those steps read the whole
 *                records of the pool, so the executor keeps them; every other generated pool only
 *                counts its records (`alias#1…alias#n`).
 *   referenced — names a Lookup (a field option `kind: 'ref'`) points at, plus, for a source whose
 *                records come from another pool (`exposes.* = { fromSource }`, Chọn bản ghi), that
 *                pool too: a Lookup to a picked record gives the `$ref` of the source record. The
 *                inserter keeps the Ids of these aliases only.
 * Turned-off steps and hidden options (showIf) do not run, so they are not counted.
 * → { readers: Set<name>, referenced: Set<name> }
 */
export function poolUsage(wf, catalog) {
  const cat = catalog?.nodeTypes instanceof Map ? catalog : catalogMaps(catalog);
  const readers = new Set();
  const lookups = new Set();
  const fromOf = new Map(); // source name → name of the pool its records come from
  const visit = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (!step || typeof step !== 'object' || step.disabled === true) continue;
      const type = cat.nodeTypes.get(step.type);
      const ex = type?.exposes;
      if (ex?.kind === 'record') {
        const c = step.config ?? {};
        const name = c[ex.name?.key] || (ex.name?.fallback === 'id' ? step.id : '');
        const key = ['members', 'label', 'origin'].map((k) => ex[k]?.fromSource).find(Boolean);
        if (name && key && c[key]) fromOf.set(name, String(c[key]));
      }
      for (const o of referenceOptions(step, cat)) {
        if (o.mode !== 'ref' || typeof o.value !== 'string' || !o.value.trim()) continue;
        if (o.fieldIndex !== undefined) lookups.add(o.value.trim());
        else if (o.def?.accepts?.pool) readers.add(o.value.trim());
      }
      for (const children of Object.values(step.slots ?? {})) visit(children);
    }
  };
  visit(wf?.steps);
  const referenced = new Set();
  for (let name of lookups) {
    // Follow pick → its pool → … (guarded against a cycle in an invalid workflow).
    for (let hops = 0; name && !referenced.has(name) && hops < 64; hops++) {
      referenced.add(name);
      name = fromOf.get(name);
    }
  }
  return { readers, referenced };
}
