// SOQL helpers for the Query step (design 0006). Pure: no DOM, no I/O, no imports, so the
// server (validation, pre-fetch, executor tests) and the browser (the "SOQL sẽ chạy" line, the
// variable picker via shared/scope.js) use the very same code.
//
// A Query step is written either with the builder (`mode: 'builder'`: sobject, fields, where,
// orderBy, limit) or as hand-written SOQL (`mode: 'soql'`). Only read-only SELECT statements are
// accepted. Outside string literals, anywhere in the text (subqueries and parentheses included):
// no FOR UPDATE / FOR VIEW / FOR REFERENCE (they lock or mark records), no UPDATE at all
// (UPDATE VIEWSTAT / UPDATE TRACKING write statistics to the org), no `;`. The server only ever
// calls the REST `/query` endpoint (never `queryAll`). Salesforce field names are not case
// sensitive: rows are re-keyed to the spelling of the SELECT list (rekeyRow) and lookups into a
// row read from the org ignore case.

/** Defaults of the builder options (server/workflow/nodes.js uses these for the catalogue). */
export const QUERY_DEFAULTS = { mode: 'builder', sobject: 'Account', fields: ['Id', 'Name'], where: '', orderBy: 'Id', limit: 200 };

/** Sample rows per Query step when no org is selected. */
export const SAMPLE_ROWS = 5;

const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export const isFieldPath = (s) => FIELD_PATH.test(String(s ?? '').trim());

/** Text with string literals ('…', with \' escapes) blanked out, same length, so keywords inside strings never match. */
export function blankStrings(text) {
  return String(text ?? '').replace(/'(?:[^'\\]|\\.)*'?/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}${m.length > 1 ? "'" : ''}`);
}

/** Index of the first top-level (outside parentheses) match of `re` in blanked text `s`, from `from`. */
function topLevel(s, re, from = 0) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  g.lastIndex = from;
  for (let m; (m = g.exec(s));) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
    }
    if (depth <= 0) return { index: m.index, match: m };
  }
  return null;
}

/** Split a SELECT list at top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Parse the parts of a SOQL statement the app needs.
 * → { select: boolean, sobject, fields: [path], open, subquery, hasOrderBy, limit (number|null), forClause, template }
 * `open`: the SELECT has FIELDS(...), TYPEOF or a function without alias, so the field list is not known.
 */
export function parseSoql(text) {
  const raw = String(text ?? '');
  const s = blankStrings(raw);
  const out = { select: false, sobject: '', fields: [], open: false, subquery: false, hasOrderBy: false, limit: null, forClause: false, template: /\{\{/.test(raw) };
  const head = /^\s*SELECT\s/i.exec(s);
  if (!head) return out;
  out.select = true;
  const from = topLevel(s, /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/i, head[0].length);
  const list = from ? raw.slice(head[0].length, from.index) : raw.slice(head[0].length);
  for (const item of splitTop(list)) {
    if (item.startsWith('(')) {
      out.subquery = true;
      continue;
    }
    if (/^(?:TYPEOF|FIELDS)\b/i.test(item)) {
      out.open = true;
      continue;
    }
    const fn = /^([A-Za-z]+)\s*\(\s*([^()]*?)\s*\)\s*([A-Za-z][A-Za-z0-9_]*)?$/.exec(item);
    if (fn) {
      // toLabel(Status), convertCurrency(Amount) → the field; COUNT(Id) cnt → the alias.
      if (fn[3]) out.fields.push(fn[3]);
      else if (/^(?:toLabel|convertCurrency|format)$/i.test(fn[1]) && isFieldPath(fn[2])) out.fields.push(fn[2]);
      else out.open = true;
      continue;
    }
    if (isFieldPath(item)) out.fields.push(item);
    else out.open = true;
  }
  if (from) {
    out.sobject = from.match[1];
    const rest = s.slice(from.index);
    out.hasOrderBy = Boolean(topLevel(rest, /\bORDER\s+BY\b/i));
    const lim = topLevel(rest, /\bLIMIT\s+(\d+)/i);
    out.limit = lim ? Number(lim.match[1]) : null;
  }
  out.forClause = FOR_CLAUSE.test(s);
  out.update = UPDATE_WORD.test(s);
  out.semicolon = s.includes(';');
  return out;
}

/**
 * `soql` with `field` appended to its outer SELECT list (right after the last item, before
 * FROM; the spacing around FROM is kept), for the "Thêm <Field> vào SELECT" quick fix (design
 * 0012 F1). Unchanged when the list already has the field (ignoring case). Null when the
 * statement cannot be edited safely: not a valid read-only SELECT, a subquery or FIELDS(…) /
 * TYPEOF in the SELECT list, or `field` is not a field path.
 */
export function addSelectField(soql, field) {
  const raw = String(soql ?? '');
  const name = String(field ?? '').trim();
  if (!isFieldPath(name)) return null;
  if (checkSoql(raw).some((i) => i.level === 'error')) return null;
  const p = parseSoql(raw);
  if (p.subquery || p.open || !p.fields.length) return null;
  if (p.fields.some((f) => f.toLowerCase() === name.toLowerCase())) return raw;
  const head = /^\s*SELECT\s/i.exec(blankStrings(raw));
  const from = topLevel(blankStrings(raw), /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/i, head[0].length);
  if (!from) return null;
  const before = raw.slice(0, from.index);
  const at = before.length - /\s*$/.exec(before)[0].length;
  return `${raw.slice(0, at)}, ${name}${raw.slice(at)}`;
}

// Checked on text whose string literals are blanked, anywhere (not only at the top level).
const FOR_CLAUSE = /\bFOR\s+(?:UPDATE|VIEW|REFERENCE)\b/i;
const UPDATE_WORD = /\bUPDATE\b/i;

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((f) => {
    const k = f.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const mode = (config) => (config?.mode ?? QUERY_DEFAULTS.mode) === 'soql' ? 'soql' : 'builder';

/** Builder field list as entered (strings; a newline/comma separated string is accepted too). */
function builderFields(config) {
  const raw = config?.fields ?? QUERY_DEFAULTS.fields;
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\n,;]/);
  return list.map((f) => String(f ?? '').trim()).filter(Boolean);
}

/** Fields the Query step reads: { fields: ['Id', …], open }. The builder always reads Id (first). */
export function selectFields(config) {
  if (mode(config) === 'soql') {
    const p = parseSoql(config?.soql);
    return { fields: dedupe(p.fields), open: p.open };
  }
  return { fields: dedupe(['Id', ...builderFields(config)]), open: false };
}

/** sObject the Query step reads (builder: `sobject`; SOQL: the name after FROM). */
export function soqlSobject(config) {
  if (mode(config) === 'soql') return parseSoql(config?.soql).sobject;
  return String(config?.sobject ?? QUERY_DEFAULTS.sobject).trim();
}

/** The LIMIT of a builder Query (integer, may be out of range: validation reports it). */
export const builderLimit = (config) => Number(config?.limit ?? QUERY_DEFAULTS.limit);

/** The SOQL statement the server runs for a Query step. */
export function buildSoql(config) {
  if (mode(config) === 'soql') return String(config?.soql ?? '').trim().replace(/\s*;\s*$/, '');
  const where = String(config?.where ?? QUERY_DEFAULTS.where).trim();
  const orderBy = String(config?.orderBy ?? QUERY_DEFAULTS.orderBy).trim();
  return `SELECT ${selectFields(config).fields.join(', ')} FROM ${soqlSobject(config)}${where ? ` WHERE ${where}` : ''}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${builderLimit(config)}`;
}

/** Most rows the server fetches for a Query step (jsforce maxFetch). */
export function maxFetchFor(config, maxRows) {
  if (mode(config) === 'soql') {
    const limit = parseSoql(config?.soql).limit;
    // LIMIT 0 → 0: the caller must not ask jsforce (its maxFetch 0 would mean "default 10 000").
    return Math.max(0, Math.min(limit ?? maxRows, maxRows));
  }
  const limit = builderLimit(config);
  return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, maxRows) : maxRows;
}

export const SOQL_MESSAGES = {
  template: 'Bước Query không dùng được {{…}}: query chỉ chạy một lần trước khi sinh dữ liệu. Muốn lọc theo bản ghi khác (ví dụ {{acc.Id}}), dùng bộ lọc ở bước Chọn bản ghi.',
  notSelect: 'SOQL phải bắt đầu bằng SELECT. Bước Query chỉ đọc dữ liệu.',
  noFrom: 'SOQL thiếu "FROM <sObject>".',
  forClause: 'Bỏ FOR UPDATE / FOR VIEW / FOR REFERENCE: các lệnh này khóa hoặc đánh dấu bản ghi trong org.',
  update: 'Bỏ UPDATE (UPDATE VIEWSTAT / UPDATE TRACKING): lệnh này ghi số liệu vào org. Bước Query chỉ đọc dữ liệu.',
  semicolon: 'Bỏ dấu ";": mỗi bước Query chỉ chạy đúng một câu SELECT.',
  parens: 'Dấu ngoặc "(" và ")" trong ô này chưa khớp nhau. Sửa lại cho đủ cặp.',
  noOrderBy: 'SOQL không có ORDER BY nên thứ tự bản ghi có thể đổi giữa các lần chạy, cùng seed có thể chọn ra bản ghi khác. Thêm ORDER BY Id.',
  noId: 'SOQL không lấy Id nên pool này không dùng được cho Lookup. Thêm Id vào SELECT.',
  subquery: 'Subquery (SELECT … FROM quan hệ con) chưa được hỗ trợ; phần đó sẽ bị bỏ qua.',
  whereClause: 'Đặt ORDER BY và LIMIT ở ô riêng, không viết trong "Điều kiện (WHERE)".',
  orderByLimit: 'Đặt LIMIT ở ô "Số bản ghi tối đa (LIMIT)", không viết trong "Sắp xếp (ORDER BY)".',
};

/**
 * Problems of a hand-written SOQL statement: [{ code, level: 'error' | 'warning', message }].
 * Errors make the step invalid (nothing is sent to Salesforce); warnings do not.
 */
export function checkSoql(text) {
  const issues = [];
  const add = (code, level) => issues.push({ code, level, message: SOQL_MESSAGES[code] });
  const p = parseSoql(text);
  if (p.template) add('template', 'error');
  if (!p.select) {
    add('notSelect', 'error');
    return issues;
  }
  if (!p.sobject || !API_NAME.test(p.sobject)) add('noFrom', 'error');
  if (p.forClause) add('forClause', 'error');
  else if (p.update) add('update', 'error');
  if (p.semicolon) add('semicolon', 'error');
  if (issues.some((i) => i.level === 'error')) return issues;
  if (!p.hasOrderBy) add('noOrderBy', 'warning');
  if (!p.open && !p.fields.some((f) => f.toLowerCase() === 'id')) add('noId', 'warning');
  if (p.subquery) add('subquery', 'warning');
  return issues;
}

/**
 * Problems of the builder's free-text parts (WHERE, ORDER BY): [{ field, code, message }].
 * The rest (sObject, fields, LIMIT) is checked by the server validation.
 */
export function checkBuilder(config) {
  const issues = [];
  const where = String(config?.where ?? '');
  const orderBy = String(config?.orderBy ?? '');
  const add = (field, code) => issues.push({ field, code, message: SOQL_MESSAGES[code] });
  for (const [field, value] of [['where', where], ['orderBy', orderBy]]) {
    const b = blankStrings(value);
    if (/\{\{/.test(value)) add(field, 'template');
    else if (FOR_CLAUSE.test(b)) add(field, 'forClause');
    else if (UPDATE_WORD.test(b)) add(field, 'update');
    else if (b.includes(';')) add(field, 'semicolon');
    else if (!balanced(b)) add(field, 'parens');
  }
  const w = blankStrings(where);
  if (!issues.some((i) => i.field === 'where') && /\b(?:ORDER\s+BY|LIMIT|OFFSET)\b/i.test(w)) add('where', 'whereClause');
  if (!issues.some((i) => i.field === 'orderBy') && /\b(?:LIMIT|OFFSET)\b/i.test(blankStrings(orderBy))) add('orderBy', 'orderByLimit');
  return issues;
}

/** Parentheses pair up (a WHERE cannot close the statement's own parentheses, e.g. `x) FROM Lead`). */
function balanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Key of `obj` equal to `key` ignoring case (the key itself when there is none). */
export function keyOf(obj, key) {
  if (!obj || typeof obj !== 'object' || key in obj) return key;
  const lower = String(key).toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower) ?? key;
}

/**
 * A row re-keyed to the spelling of `fields` (the SELECT list, e.g. `name`, `owner.Name`), case
 * insensitively and through relationship paths; keys not in the list keep their spelling.
 */
export function rekeyRow(row, fields) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const byHead = new Map();
  for (const f of fields ?? []) {
    const [head, ...rest] = String(f).split('.');
    if (!byHead.has(head.toLowerCase())) byHead.set(head.toLowerCase(), { head, rest: [] });
    if (rest.length) byHead.get(head.toLowerCase()).rest.push(rest.join('.'));
  }
  for (const { head, rest } of byHead.values()) {
    const k = keyOf(out, head);
    if (!(k in out)) continue;
    const v = out[k];
    delete out[k];
    out[head] = rest.length && v && typeof v === 'object' && !Array.isArray(v) ? rekeyRow(v, rest) : v;
  }
  return out;
}

/** A row from Salesforce without `attributes` (recursively) and without subquery results. */
export function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'attributes') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Array.isArray(v.records) && 'totalSize' in v) continue; // subquery result: not supported
      out[k] = normalizeRow(v);
    } else out[k] = v;
  }
  return out;
}

/**
 * Deterministic sample rows when no org is selected (no rng): Id `mẫu:accs#1`, Name
 * `Account mẫu 1`, other fields `<field> mẫu 1`; relationship fields become nested objects.
 */
export function sampleRows(config, alias) {
  const max = maxFetchFor(config, SAMPLE_ROWS);
  const n = Math.max(0, Math.min(SAMPLE_ROWS, Number.isFinite(max) ? max : SAMPLE_ROWS));
  const sobject = soqlSobject(config) || 'Record';
  const fields = selectFields(config).fields;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const row = {};
    for (const f of fields) {
      const parts = f.split('.');
      // Same spelling as the SELECT list; `Owner.Name` and `owner.Email` share one Owner object.
      let level = row;
      parts.slice(0, -1).forEach((p) => {
        const k = keyOf(level, p);
        level = level[k] && typeof level[k] === 'object' ? level[k] : (level[k] = {});
      });
      const leaf = parts[parts.length - 1];
      let value = `${f} mẫu ${i}`;
      if (parts.length === 1 && leaf.toLowerCase() === 'id') value = `mẫu:${alias || 'q'}#${i}`;
      else if (parts.length === 1 && leaf.toLowerCase() === 'name') value = `${sobject} mẫu ${i}`;
      level[leaf] = value;
    }
    rows.push(row);
  }
  return rows;
}
