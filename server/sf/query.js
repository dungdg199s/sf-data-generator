// Reads the rows of every Query step before the (pure, synchronous) executor runs — design
// 0006 "pre-fetch". Queries run one after the other, in reading order, through the jsforce
// connection of server/sf/client.js (`client.query`, REST `/query` only); nothing is ever
// written. Without an org each Query gets deterministic sample rows (shared/soql.js); the fields
// the workflow reads as numbers (loop counts, pick weights: shared/scope.js numericSampleFields,
// design 0013 F) are numbers in them.
//
// Rows are cached per (org identity, SOQL, maxFetch) for LIMITS.queryCacheTtlMs — the identity is
// instance URL + username when the client can tell (`client.identity`), so two aliases of one org
// share rows and an alias re-pointed to another org does not reuse them — so a preview and the
// insert right after it use the same rows. Each result has a fingerprint; an insert sends the
// fingerprints of its preview (`expectQueries`) and a mismatch stops the run with HTTP 409
// before anything is written.

import { createHash } from 'node:crypto';
import { LIMITS } from '../workflow/nodes.js';
import { WorkflowError, scopeCatalog } from '../workflow/schema.js';
import { numericSampleFields } from '../../shared/scope.js';
import { buildSoql, soqlSobject, maxFetchFor, normalizeRow, rekeyRow, sampleRows, selectFields, checkSoql, checkBuilder } from '../../shared/soql.js';

const CACHE_MAX_ENTRIES = 50;

export function createQueryCache({ ttlMs = LIMITS.queryCacheTtlMs, maxEntries = CACHE_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const entries = new Map(); // key → { org, at, value }
  const key = (org, soql, maxFetch) => `${org}\u0000${maxFetch}\u0000${soql}`;
  return {
    get(org, soql, maxFetch) {
      const k = key(org, soql, maxFetch);
      const e = entries.get(k);
      if (!e) return null;
      if (now() - e.at > ttlMs) {
        entries.delete(k);
        return null;
      }
      return e.value;
    },
    set(org, soql, maxFetch, value) {
      const k = key(org, soql, maxFetch);
      entries.delete(k);
      entries.set(k, { org, at: now(), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    /** After an insert: the next preview must see the records just created. */
    invalidateOrg(org) {
      for (const [k, e] of entries) if (e.org === org) entries.delete(k);
    },
    get size() {
      return entries.size;
    },
  };
}

/** Short, stable hash of the rows (8 hex characters). */
export function fingerprint(records) {
  return createHash('sha1').update(JSON.stringify(records)).digest('hex').slice(0, 8);
}

/** Enabled Query steps in reading order (a turned-off container turns its children off). */
export function queryStepsOf(workflow) {
  const out = [];
  const visit = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (!step || typeof step !== 'object' || step.disabled === true) continue;
      if (step.type === 'query') out.push(step);
      for (const children of Object.values(step.slots ?? {})) visit(children);
    }
  };
  visit(workflow?.steps);
  return out;
}

const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * @param client   server/sf/client.js client (needs `query`)
 * @param org      org to read, or '' / null → sample rows
 * @param workflow prepared (v2) workflow
 * @param refresh  bypass the cache
 * @param expect   { [stepId]: fingerprint | { fingerprint, count, fetchedAt } } from the preview
 * @param preview  true for a preview (adds the "no org" hint to connection errors)
 * @param budgetMs time for all Query steps together (LIMITS.queryTotalMs): each query gets at most
 *                 what is left, and a query that would start past it is reported on its step
 * → { results: { [stepId]: { records, sobject, … } }, queries: [summary], warnings }
 *   throws WorkflowError (422: the query is wrong), an error with status 409 (org data changed)
 *   or status 502/503 (Salesforce or sf CLI failure), always with `issues` carrying the step id.
 */
export async function prefetchQueries({
  client, org, workflow, cache, refresh = false, expect = null, preview = true, clock = () => new Date(), budgetMs = LIMITS.queryTotalMs,
}) {
  const results = {};
  const queries = [];
  const warnings = [];
  const changed = [];
  const started = clock().getTime();
  let identity = null; // cache key of the org, looked up once
  let numeric = null; // Query step id → fields read as numbers (sample rows only)
  for (const step of queryStepsOf(workflow)) {
    const c = step.config ?? {};
    const alias = c.alias;
    const soql = buildSoql(c);
    const sobject = soqlSobject(c);
    const maxFetch = maxFetchFor(c, LIMITS.maxQueryRows);
    const fields = selectFields(c).fields;
    // Defence in depth: validation already refuses these, the org must never see them.
    const unsafe = (c.mode ?? 'builder') === 'soql' ? checkSoql(c.soql).find((i) => i.level === 'error') : checkBuilder(c)[0];
    if (unsafe) throw new WorkflowError([{ message: unsafe.message, nodeId: step.id, field: unsafe.field ?? 'soql', code: unsafe.code }]);
    let entry;
    if (!org) {
      numeric ??= numericSampleFields(workflow, scopeCatalog());
      const records = sampleRows(c, alias, { numeric: numeric[step.id] });
      entry = { records, totalSize: records.length, done: true, source: 'sample', fetchedAt: null, org: null, fingerprint: fingerprint(records) };
      warnings.push({ message: `Chưa chọn org nên bước Query "${alias}" dùng ${records.length} bản ghi mẫu (Id giả). Chọn org ở thanh trên để đọc dữ liệu thật.`, nodeId: step.id, code: 'querySample' });
    } else {
      if (identity === null) {
        try {
          identity = client.identity ? await client.identity(org) : org;
        } catch (e) {
          throw queryError(e, step, { org, preview });
        }
      }
      const hit = refresh ? null : cache?.get(identity, soql, maxFetch);
      if (hit) entry = { ...hit, source: 'cache', org };
      else {
        let res;
        const left = budgetMs - (clock().getTime() - started);
        if (left <= 0) throw budgetError(step, budgetMs);
        if (maxFetch < 1) res = { records: [], totalSize: 0, done: true }; // LIMIT 0: nothing to ask for
        else {
          try {
            res = await client.query(org, soql, { maxFetch, timeoutMs: Math.min(LIMITS.queryTimeoutMs, left) });
          } catch (e) {
            const code = e?.cause?.errorCode ?? e?.errorCode;
            if (code === 'QUERY_TIMEOUT' && left < LIMITS.queryTimeoutMs) throw budgetError(step, budgetMs);
            throw queryError(e, step, { org, preview });
          }
        }
        // Salesforce answers with the API spelling (Name); the pool uses the SELECT's (name).
        const records = (res?.records ?? []).map((r) => rekeyRow(normalizeRow(r), fields));
        entry = { records, totalSize: res?.totalSize ?? records.length, done: res?.done !== false, source: 'org', fetchedAt: clock().toISOString(), org, fingerprint: fingerprint(records) };
        cache?.set(identity, soql, maxFetch, entry);
      }
      if (!entry.records.length) {
        warnings.push({ message: `Query "${alias}" không trả về bản ghi nào trong org "${org}". Kiểm tra "Điều kiện (WHERE)"; Lookup và bước Chọn bản ghi dùng pool này sẽ không có gì để chọn.`, nodeId: step.id, code: 'queryEmpty' });
      } else if (entry.totalSize > entry.records.length) {
        warnings.push({ message: `Query "${alias}" khớp ${thousands(entry.totalSize)} bản ghi nhưng chỉ lấy ${thousands(entry.records.length)} bản ghi đầu theo ORDER BY. Thu hẹp WHERE nếu cần đúng nhóm bản ghi.`, nodeId: step.id, code: 'queryTruncated' });
      }
    }
    const exp = expect?.[step.id];
    const expFp = typeof exp === 'string' ? exp : exp?.fingerprint;
    if (expFp && expFp !== entry.fingerprint) {
      const was = typeof exp === 'object' && Number.isInteger(exp.count)
        ? `lúc xem trước có ${thousands(exp.count)} bản ghi${exp.fetchedAt ? ` (đọc ${hhmm(exp.fetchedAt)})` : ''}`
        : 'lúc xem trước';
      changed.push({
        message: `Query "${alias}" ${was}, bây giờ đọc lại thì khác (${thousands(entry.records.length)} bản ghi). Chưa ghi gì vào org. Bấm Xem trước để xem dữ liệu mới rồi Insert lại.`,
        nodeId: step.id,
        code: 'queryChanged',
      });
    }
    results[step.id] = { records: entry.records, sobject };
    queries.push({
      nodeId: step.id, alias, sobject, soql, org: entry.org, source: entry.source, fetchedAt: entry.fetchedAt,
      count: entry.records.length, totalSize: entry.totalSize, truncated: entry.totalSize > entry.records.length,
      fingerprint: entry.fingerprint, fields, records: entry.records,
    });
  }
  if (changed.length) {
    throw Object.assign(
      new Error('Dữ liệu trong org đã thay đổi từ lần xem trước nên bản insert sẽ khác bản đã xem. Chưa ghi gì vào org. Bấm Xem trước để xem dữ liệu mới rồi Insert lại.'),
      { status: 409, issues: changed },
    );
  }
  return { results, queries, warnings };
}

function budgetError(step, budgetMs) {
  return new WorkflowError([{
    message: `Các bước Query đọc org quá ${Math.round(budgetMs / 1000)} giây nên đã dừng ở bước Query "${step.config?.alias}" (chưa ghi gì vào org). Bớt bước Query, thu hẹp "Điều kiện (WHERE)" hoặc giảm LIMIT rồi chạy lại.`,
    nodeId: step.id,
    code: 'queryBudget',
  }]);
}

const lastLine = (msg) => String(msg ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

/** Salesforce / connection failure of one Query → an issue on the right field, or a 502. */
export function queryError(e, step, { org, preview = true } = {}) {
  const c = step.config ?? {};
  const alias = c.alias;
  const soqlMode = (c.mode ?? 'builder') === 'soql';
  const sfError = e?.cause ?? (e?.errorCode ? e : null);
  const code = sfError?.errorCode;
  const msg = sfError?.message ?? e?.message ?? '';
  const issue = (field, message) => new WorkflowError([{ message, nodeId: step.id, field, code }]);
  if (!sfError) {
    // sf CLI / connection problem (e.g. org not logged in): not the query's fault.
    const hint = preview ? ' Hoặc chọn "— không kết nối —" để xem trước bằng bản ghi mẫu.' : '';
    return Object.assign(new Error(`${e?.message ?? 'Không kết nối được org.'}${hint}`), { status: e?.status ?? 502, issues: [{ message: `${e?.message ?? ''}${hint}`.trim(), nodeId: step.id }] });
  }
  switch (code) {
    case 'QUERY_TIMEOUT':
      return issue(undefined, `Query "${alias}" chạy quá ${Math.round(LIMITS.queryTimeoutMs / 1000)} giây nên đã dừng. Thêm điều kiện WHERE trên field có index (Id, Name, CreatedDate, RecordTypeId) hoặc giảm số bản ghi.`);
    case 'INVALID_TYPE': {
      const name = /sObject type '([^']+)'/i.exec(msg)?.[1] ?? soqlSobject(c);
      return issue(soqlMode ? 'soql' : 'sobject', `Org "${org}" không có sObject "${name}" hoặc bạn không có quyền đọc (INVALID_TYPE). Chọn sObject trong danh sách gợi ý.`);
    }
    case 'INVALID_FIELD': {
      const name = /No such column '([^']+)'/i.exec(msg)?.[1] ?? /relationship '([^']+)'/i.exec(msg)?.[1] ?? '?';
      let field = 'soql';
      if (!soqlMode) {
        const lower = name.toLowerCase();
        const has = (text) => new RegExp(`(^|[^A-Za-z0-9_])${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(String(text ?? ''));
        const fields = selectFields(c).fields;
        if (fields.some((f) => f.toLowerCase().split('.').includes(lower) || f.toLowerCase() === lower)) field = 'fields';
        else if (has(c.where)) field = 'where';
        else if (has(c.orderBy)) field = 'orderBy';
        else field = 'fields';
      }
      return issue(field, `Salesforce không có field "${name}" trên ${soqlSobject(c)} hoặc bạn không có quyền đọc (INVALID_FIELD). Sửa tên ở "Field cần lấy" hoặc bấm "Chọn field…".`);
    }
    case 'MALFORMED_QUERY':
      return issue(soqlMode ? 'soql' : 'where', `SOQL sai cú pháp (MALFORMED_QUERY): ${lastLine(msg)}. Kiểm tra ô ${soqlMode ? '"SOQL"' : '"Điều kiện (WHERE)"'}.`);
    case 'INVALID_QUERY_FILTER_OPERATOR':
      return issue(soqlMode ? 'soql' : 'where', `Phép so sánh trong WHERE không dùng được với field này (INVALID_QUERY_FILTER_OPERATOR): ${lastLine(msg)}. Sửa ô ${soqlMode ? '"SOQL"' : '"Điều kiện (WHERE)"'}.`);
    default: {
      const text = `Bước Query "${alias}": Salesforce: ${code ? `${code}: ` : ''}${msg}`;
      return Object.assign(new Error(text), { status: 502, issues: [{ message: text, nodeId: step.id }] });
    }
  }
}
