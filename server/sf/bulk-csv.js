// CSV of Bulk API 2.0 jobs (design 0011 §2): what is uploaded and how results are read.
//
// Upload: columns = union of the fields of the job's records (after toSObject, so Lookups are real
// Ids and geolocations are split into __Latitude__s / __Longitude__s), in first-seen order; never a
// column that is not a field of the step (Salesforce refuses the whole job). null / missing → empty
// cell, booleans true / false, numbers String(n), strings as generated; a cell holding `"`, `,` or
// a line break is quoted. Lines end with LF (the job is created with lineEnding LF).
//
// Results: successfulResults / failedResults come back as raw CSV text (server/sf/client.js) and
// are parsed here: jsforce's parser treats `;`, `|`, tab… as delimiters too.

/** One CSV cell of a value sent to Salesforce. */
export function bulkCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same text as the cell, unquoted: how a value reads back in Salesforce's result CSV. */
export function bulkText(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * @param objs  field objects as sent to Salesforce (toSObject output)
 * → { columns, csv, keys }  keys[i]: the normalized row of objs[i] (matching failedResults rows)
 */
export function toBulkCsv(objs) {
  const columns = [];
  const seen = new Set();
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || seen.has(k)) continue;
      seen.add(k);
      columns.push(k);
    }
  }
  const lines = [columns.map(bulkCell).join(',')];
  const keys = [];
  for (const o of objs) {
    lines.push(columns.map((c) => bulkCell(o[c])).join(','));
    keys.push(rowKey(columns.map((c) => bulkText(o[c]))));
  }
  return { columns, csv: `${lines.join('\n')}\n`, keys };
}

/** Normalized key of a row's cell texts (used to find the uploaded row of a failed result). */
export function rowKey(cells) {
  return cells.map((c) => String(c ?? '').replace(/\r\n/g, '\n')).join('\u0000');
}

/** RFC 4180 CSV → rows of cells (quoted cells, doubled quotes, line breaks inside quotes, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Result CSV → { header, rows: [{ <column>: text }] } (empty lines skipped). */
export function parseResultCsv(text) {
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  return {
    header,
    rows: rows.filter((r) => !(r.length === 1 && r[0] === '')).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))),
  };
}

/**
 * `sf__Error` of a failed Bulk row ("STATUS_CODE:message:Field1,Field2 --") → the SaveResult
 * error shape { statusCode, message, fields }, so describeFailure / errorPattern group it like a
 * Collections failure. The message may contain colons.
 */
export function parseBulkError(sfError) {
  const raw = String(sfError ?? '');
  // Salesforce always writes the field segment before the closing " --" (empty when no field), so
  // with the marker the last colon is the separator even if the message ends with an Id.
  const marked = /\s*--\s*$/.test(raw);
  let s = raw.replace(/\s*--\s*$/, '');
  const colon = s.indexOf(':');
  if (colon < 0 || !/^[A-Z_]+$/.test(s.slice(0, colon))) return { statusCode: null, message: s || 'Lỗi không rõ.', fields: [] };
  const statusCode = s.slice(0, colon);
  s = s.slice(colon + 1);
  const last = s.lastIndexOf(':');
  let fields = [];
  const tail = s.slice(last + 1).trim();
  if (last >= 0 && (marked ? /^[A-Za-z0-9_, .]*$/.test(tail) : /^([A-Za-z0-9_]+(,[A-Za-z0-9_]+)*)?$/.test(tail))) {
    fields = tail.split(',').map((f) => f.trim()).filter(Boolean);
    s = s.slice(0, last);
  }
  return { statusCode, message: s, fields };
}
