// CSV for Bulk API 2.0 jobs (design 0011) and the parsing of their results.
//
// Upload: columns = union of the fields of the rows (after toSObject, so Lookups are real Ids and
// geolocations are split into __Latitude__s / __Longitude__s), in order of first appearance; never
// a column that is not a field of the step (Salesforce refuses the whole job for an unknown column).
// null / missing → empty cell (Salesforce leaves the field unset on insert); booleans true / false;
// numbers String(n); strings as generated, quoted when they hold `"`, `,` or a line break.
// Line ending LF and comma delimiter (the job is created with lineEnding LF, columnDelimiter COMMA).

/** One CSV cell. */
export function csvValue(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Columns of a set of rows: union of keys in order of first appearance. */
export function csvColumns(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** One row as a CSV line (no line ending) for `cols`. */
export const csvLine = (row, cols) => cols.map((c) => csvValue(row[c])).join(',');

/** → { columns, csv } with a header line and one line per row, LF line endings. */
export function toBulkCsv(rows) {
  const columns = csvColumns(rows);
  const lines = [columns.map(csvValue).join(',')];
  for (const r of rows) lines.push(csvLine(r, columns));
  return { columns, csv: `${lines.join('\n')}\n` };
}

/** CSV of one Id column (Bulk delete jobs). */
export function idsCsv(ids) {
  return `Id\n${ids.join('\n')}\n`;
}

/**
 * Key of a row's content as Salesforce echoes it back in failedResults (every value a string,
 * empty cell = ''), so a failure can be matched to the uploaded line it came from.
 */
export function rowKey(row, cols) {
  return cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return '';
    return typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }).join('\u0000');
}

/**
 * `sf__Error` of a Bulk result line ("STATUS_CODE:message:Field1,Field2 --") as the error of a
 * SaveResult: { statusCode, message, fields }. The message itself may contain colons; the fields
 * part is the text after the last colon when it is a comma list of field names (or empty).
 */
export function parseBulkError(raw) {
  let s = String(raw ?? '').trim().replace(/\s*--\s*$/, '');
  const first = s.indexOf(':');
  if (first < 0 || !/^[A-Z_]+$/.test(s.slice(0, first))) return { statusCode: undefined, message: s || 'Lỗi không rõ.', fields: [] };
  const statusCode = s.slice(0, first);
  s = s.slice(first + 1);
  const last = s.lastIndexOf(':');
  let fields = [];
  if (last >= 0 && /^[A-Za-z0-9_]*(?:,[A-Za-z0-9_]+)*$/.test(s.slice(last + 1).trim())) {
    fields = s.slice(last + 1).trim().split(',').filter(Boolean);
    s = s.slice(0, last);
  }
  return { statusCode, message: s.trim(), fields };
}

/** Columns of a Bulk result line that are not data (sf__Id, sf__Error, sf__Created). */
export const RESULT_META = /^sf__/;

/** The data columns of a result line (strings, as uploaded). */
export function dataOf(line) {
  const out = {};
  for (const [k, v] of Object.entries(line ?? {})) if (!RESULT_META.test(k)) out[k] = v;
  return out;
}
