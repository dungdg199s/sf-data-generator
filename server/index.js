// HTTP entry point: JSON API under /api, static client from /client, and the pure modules
// shared by client and server from /shared (served at /shared/…). No framework on purpose.
// Binds to 127.0.0.1 by default — the server acts with the local sf CLI's org credentials,
// so it must not be reachable from the network unless HOST is set explicitly.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeGenerators, VALUE_TYPES } from './generators/index.js';
import { serializableNodeTypes, STEP_CATEGORIES, LIMITS, QUERY_PRESETS } from './workflow/nodes.js';
import { TEMPLATE_TOKEN } from './workflow/paths.js';
import { validateWorkflow, prepareWorkflow, insertBlockedReason, WorkflowError } from './workflow/schema.js';
import { createRun } from './workflow/executor.js';
import { executeRun, createRunRegistry, YIELD_EVERY } from './run.js';
import { createSfCli } from './sf/cli.js';
import { createSfClient } from './sf/client.js';
import { mapDescribe, mapQueryFields } from './sf/describe-map.js';
import { createQueryCache, prefetchQueries } from './sf/query.js';
import { createHistory } from './history.js';
import { deleteRun, pendingBulkJobs } from './sf/delete.js';
import { poolUsage } from '../shared/scope.js';
import { scopeCatalog } from './workflow/schema.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = path.join(ROOT_DIR, 'client');
const SHARED_DIR = path.join(ROOT_DIR, 'shared');
const MAX_BODY = 10 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STREAMED = Symbol('streamed'); // a route that wrote the response itself
const NDJSON = 'application/x-ndjson';
const RUN_SNAPSHOTS = 10;
const LIMITS_TTL_MS = 60000; // GET /api/orgs/:org/limits cache (design 0011)
const LIMITS_TIMEOUT_MS = 3000;
const NOT_IN_HISTORY = 'Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).';

/** Type of an org of `sf org list` (design 0011): production unless the CLI says otherwise. */
const kindOf = (o) => (!o ? 'unknown' : o.isScratch ? 'scratch' : o.isSandbox ? 'sandbox' : 'production');
const findOrg = (orgs, target) => (orgs ?? []).find((o) => o.alias === target || o.username === target) ?? null;

/** Host names the API answers to (DNS-rebinding guard); `HOST` adds its own. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Why a request to /api/* must be refused, or null. The server acts with the local sf CLI's org
 * access, so a web page the user happens to visit must not be able to drive it:
 * - the Host header must name this machine (a DNS-rebinding page sends its own host name);
 * - a browser's `Sec-Fetch-Site` must be `same-origin` or `none` (typed URL, curl has none);
 * - an `Origin` header, when present, must be this server's own origin;
 * - a POST must be `Content-Type: application/json` (an HTML form or a "simple" cross-site fetch
 *   can only send text/plain, form-urlencoded or multipart without a CORS preflight).
 * → { status, message } | null
 */
export function requestGuard(req, { allowedHosts = null } = {}) {
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (allowedHosts && !allowedHosts.has(hostname)) {
    return { status: 403, message: `Từ chối yêu cầu tới địa chỉ "${host}". Mở app bằng http://127.0.0.1:<cổng> hoặc http://localhost:<cổng>.` };
  }
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  if ((site && site !== 'same-origin' && site !== 'none') || (origin !== undefined && origin !== `http://${host}`)) {
    return { status: 403, message: 'Từ chối yêu cầu từ trang web khác. Chỉ giao diện của app (cùng địa chỉ) mới được gọi API này.' };
  }
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    return { status: 415, message: 'Body phải là JSON (Content-Type: application/json).' };
  }
  return null;
}

/** Hosts for requestGuard from the HOST the server listens on (a wildcard bind accepts any name). */
export function allowedHostsFor(bindHost) {
  if (bindHost && WILDCARD_HOSTS.has(bindHost)) return null;
  return new Set([...LOCAL_HOSTS, ...(bindHost ? [String(bindHost).toLowerCase()] : [])]);
}

export function createApp({
  cli = createSfCli(), client, queryCache = createQueryCache(), runOptions = {}, allowedHosts = allowedHostsFor(null),
  history = createHistory(), deleteOptions = {},
} = {}) {
  const sfClient = client ?? createSfClient({ cli });
  const runs = createRunRegistry();
  const limitsCache = new Map(); // org → { at, value }

  /**
   * Design 0011 review B2: reads the org again from the sf CLI and rebuilds the jsforce Connection
   * from that very lookup (client.refreshOrg), so the writes that follow go to the org the history
   * records. → { username, orgId, instanceUrl } (never a token). Injected test clients without
   * refreshOrg fall back to the CLI lookup.
   */
  async function freshOrg(target) {
    if (sfClient.refreshOrg) return sfClient.refreshOrg(target);
    const info = await cli.getConnection(target, { refresh: true });
    return { username: info?.username ?? null, orgId: info?.orgId ?? null, instanceUrl: info?.instanceUrl ?? null };
  }

  /**
   * The org of an insert, fixed before the first write: identity from `freshOrg` (refusing when
   * the sf CLI does not say which org it is) and the type from `sf org list` ('unknown' on error).
   */
  async function insertOrg(target) {
    const [org, orgs] = await Promise.all([
      freshOrg(target).catch((e) => { throw httpError(502, `${e.message} Đăng nhập lại: sf org login web --alias ${target}`); }),
      Promise.resolve().then(() => cli.listOrgs()).catch(() => null),
    ]);
    if (!org.orgId || !org.username) {
      throw httpError(502, `sf CLI không cho biết org "${target}" là org nào (thiếu orgId hoặc username), nên chưa ghi gì vào org. Chạy sf org display --target-org ${target} để kiểm tra, đăng nhập lại bằng sf org login web --alias ${target} rồi thử lại.`);
    }
    return { alias: target, ...org, kind: orgs ? kindOf(findOrg(orgs, target)) : 'unknown' };
  }

  /** History route parameter → the hid, or a 404 (malformed ids never reach the file system). */
  function hidOf(raw) {
    let hid;
    try {
      hid = decodeURIComponent(raw);
    } catch {
      hid = '';
    }
    if (!history.isValidId(hid)) throw httpError(404, NOT_IN_HISTORY);
    return hid;
  }

  /** Ids to delete come from the history files only; this is the one gate in front of them. */
  async function checkDelete(hid, body) {
    await history.ready;
    const run = await history.read(hid);
    if (!run) throw httpError(404, NOT_IN_HISTORY);
    if (history.inserting.has(hid)) throw httpError(409, 'Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.');
    const confirm = body?.confirm;
    if (!confirm || typeof confirm !== 'object' || typeof confirm.username !== 'string' || !Number.isInteger(confirm.count)) {
      throw httpError(400, 'Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.');
    }
    const bulk = body.bulk ?? 'auto';
    if (bulk !== 'auto' && bulk !== 'off') throw httpError(400, 'bulk phải là "auto" hoặc "off".');
    const org = run.org ?? {};
    if (confirm.username !== org.username) {
      throw httpError(409, `Xác nhận ghi org "${confirm.username}" nhưng lần insert này thuộc org "${org.username ?? org.alias}". Mở lại hộp xác nhận.`);
    }
    const remaining = await history.remaining(hid);
    if (!remaining.total && !pendingBulkJobs(run).length) throw httpError(409, 'Lần insert này không còn bản ghi nào để xóa.');
    if (confirm.count !== remaining.total) {
      throw httpError(409, `Số bản ghi còn phải xóa đã đổi (còn ${fmtNum(remaining.total)}, hộp xác nhận ghi ${fmtNum(confirm.count)}). Mở lại hộp xác nhận để xem số mới.`);
    }
    const target = org.alias ?? org.username;
    // Type of the org now (not at insert time); unknown (CLI error, not listed) counts as production.
    const orgs = await Promise.resolve().then(() => cli.listOrgs()).catch(() => null);
    const listed = findOrg(orgs, target);
    const kind = kindOf(listed);
    if (kind !== 'sandbox' && kind !== 'scratch') {
      const typed = String(confirm.typedOrg ?? '').trim().toLowerCase();
      const names = [target, org.username, listed?.alias, listed?.username].filter(Boolean).map((x) => String(x).toLowerCase());
      if (!typed || !names.includes(typed)) {
        // `typedOrgRequired`: the dialog may have shown no name field (the org type it saw was not production).
        throw Object.assign(httpError(400, `Org "${target}" là production: gõ đúng tên org trong hộp xác nhận để xóa.`), { code: 'typedOrgRequired' });
      }
    }
    // The alias must still name the org of the insert (a sandbox refresh, a re-login elsewhere…);
    // the Connection the delete uses is rebuilt from this very lookup.
    let now;
    try {
      now = await freshOrg(target);
    } catch (e) {
      throw httpError(502, `${e.message} Đăng nhập lại: sf org login web --alias ${target}`);
    }
    const same = org.orgId && now?.orgId
      ? org.orgId === now.orgId
      : Boolean(org.instanceUrl) && org.instanceUrl === now?.instanceUrl && org.username === now?.username;
    if (!same) {
      throw httpError(409, `Org "${target}" bây giờ là org khác (${now?.orgId ?? now?.instanceUrl ?? '?'}, ${now?.username ?? '?'}) so với lúc insert (${org.orgId ?? org.instanceUrl ?? '?'}, ${org.username ?? '?'}). Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias ${target} rồi thử lại.`);
    }
    return { run, target, bulk, remaining };
  }

  /** Checks shared by /api/run and /api/export, then the Query pre-fetch (0006): all before any header is sent. */
  async function prepareRun(body, { insert, pinned = null }) {
    if (body?.now !== undefined && !(typeof body.now === 'number' && Number.isFinite(body.now))) throw httpError(400, 'Tham số now không hợp lệ.');
    const { workflow, errors } = prepareWorkflow(body?.workflow);
    if (errors.length) throw new WorkflowError(errors);
    // Query steps are read first (design 0006): when inserting always from the target org
    // (never sample rows), when previewing from `org` if one is selected.
    const org = insert ? body.target.org : typeof body?.org === 'string' && body.org ? body.org : null;
    const pre = pinned ? { results: pinned, queries: [], warnings: [] } : await prefetchQueries({
      client: sfClient,
      org,
      workflow,
      cache: queryCache,
      refresh: !insert && body?.refreshQueries === true,
      expect: body?.expectQueries && typeof body.expectQueries === 'object' ? body.expectQueries : null,
      preview: !insert,
    });
    const run = createRun(body.workflow, { seed: body?.seed, now: body?.now, maxRecords: body?.maxRecords, queryResults: pre.results });
    return { run, pre, workflow };
  }

  // Query rows of recent runs (runId → queryResults), for /api/export of that run. Small LRU:
  // a run reads at most LIMITS.maxQueryNodes × maxQueryRows rows.
  const runSnapshots = new Map();
  function rememberRun(id, results) {
    runSnapshots.set(id, results);
    while (runSnapshots.size > RUN_SNAPSHOTS) runSnapshots.delete(runSnapshots.keys().next().value);
  }

  /** The next preview sees the records just created (also after a stopped insert). */
  async function invalidateAfterInsert(org) {
    queryCache.invalidateOrg(sfClient.identity ? await sfClient.identity(org).catch(() => org) : org);
  }

  const routes = [
    [
      'GET',
      /^\/api\/meta$/,
      () => ({
        fieldTypes: describeGenerators(),
        nodeTypes: serializableNodeTypes(),
        stepCategories: STEP_CATEGORIES,
        limits: LIMITS,
        queryPresets: QUERY_PRESETS,
        syntax: { templateToken: TEMPLATE_TOKEN, valueTypes: VALUE_TYPES },
      }),
    ],
    ['POST', /^\/api\/validate$/, (_m, body) => validateWorkflow(body?.workflow, { derived: true })],
    [
      'POST',
      /^\/api\/run$/,
      async (_m, body, _params, { req, res }) => {
        // A client that left while the Query steps were read (Dừng before the run started, tab
        // closed) must not get a run — above all not an insert nobody watches.
        let gone = false;
        const onEarlyClose = () => { gone = true; };
        res.on('close', onEarlyClose);
        const insert = body?.target?.kind === 'org';
        if (insert) {
          // A v1 workflow whose conversion copied or cut steps runs differently from what the
          // user built; preview is allowed (with warnings), inserting is not until it is saved as v2.
          const blocked = insertBlockedReason(body.workflow);
          if (blocked) throw httpError(422, blocked);
          if (!body.target.org) throw httpError(400, 'Chưa chọn org để insert.');
          if (body.target.bulk !== undefined && body.target.bulk !== 'auto' && body.target.bulk !== 'off') throw httpError(400, 'target.bulk phải là "auto" hoặc "off".');
        }
        // Design 0011 (review B2): an insert first fixes its org — a fresh sf CLI lookup that also
        // rebuilds the Connection, so the Query pre-fetch, the writes and the history entry all name
        // the same org. No orgId / username ⇒ 502, nothing written.
        const insertTarget = insert ? body.target.org : null;
        const org = insertTarget ? await insertOrg(insertTarget) : null;
        // Validation (422), the Query pre-fetch (409 / 502) and `now` (400) answer as plain JSON.
        const { run, pre, workflow } = await prepareRun(body, { insert });
        const target = insertTarget;
        const record = target ? { history, org, workflow } : null;
        const bulk = target ? body.target.bulk ?? 'auto' : 'auto';
        const start = { queries: pre.queries, warnings: pre.warnings };
        res.off('close', onEarlyClose);
        if (gone || res.destroyed) return STREAMED;

        // Every run gets an id: Dừng (cancel), and the export of this very run (Query rows kept).
        const handle = runs.open();
        if (pre.queries.length) rememberRun(handle.id, pre.results);
        // Closing the tab (or losing the connection) stops the run after the call in flight.
        const onClose = () => { if (!res.writableEnded) runs.cancel(handle.id); };
        res.on('close', onClose);
        const finish = async () => {
          handle.close();
          res.off('close', onClose);
          // The next preview sees the records just created; answer first, then clear the cache.
          if (target) await invalidateAfterInsert(target);
        };

        if (!String(req.headers.accept ?? '').includes(NDJSON)) {
          // One JSON body with every record (scripts, tests); same sinks as the stream.
          let end;
          try {
            end = await executeRun({ run, target, sfClient, signal: handle.signal, forceSignal: handle.forceSignal, start: { ...start, runId: handle.id }, collect: true, bulk, record, ...runOptions });
          } catch (e) {
            await finish();
            throw e;
          }
          if (end.type === 'error') {
            await finish();
            throw end.issues ? new WorkflowError(end.issues) : httpError(500, end.error);
          }
          sendJson(res, 200, end.result);
          await finish();
          return STREAMED;
        }

        // NDJSON: one event per line while the run goes on (design 0004).
        res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders?.();
        try {
          await executeRun({
            run, target, sfClient, signal: handle.signal, forceSignal: handle.forceSignal, start: { ...start, runId: handle.id }, bulk, record, ...runOptions,
            emit: (ev) => { if (!res.destroyed) res.write(`${JSON.stringify(ev)}\n`); },
          });
        } finally {
          res.end();
          await finish();
        }
        return STREAMED;
      },
    ],
    [
      'POST',
      /^\/api\/runs\/([^/]+)\/cancel$/,
      ([, runId], body) => {
        let id;
        try {
          id = decodeURIComponent(runId);
        } catch {
          id = null; // malformed escape: no such run
        }
        // { force: true } (Dừng ngay, design 0011) also aborts the Bulk job being processed.
        if (!id || !runs.cancel(id, { force: body?.force === true })) throw httpError(404, 'Lần chạy này đã kết thúc.');
        return { ok: true };
      },
    ],
    // ---------- history and delete (design 0011) ----------
    [
      'GET',
      /^\/api\/history$/,
      async () => {
        await history.ready;
        return {
          enabled: history.enabled,
          ...(history.enabled ? {} : { reason: history.reason }),
          dir: history.dir,
          maxRuns: history.maxRuns,
          runs: history.enabled ? await history.list() : [],
        };
      },
    ],
    [
      'GET',
      /^\/api\/history\/status$/,
      // Review nit: what the Insert confirmation needs, without reading the whole list.
      () => history.status(),
    ],
    [
      'GET',
      /^\/api\/history\/([^/]+)\/ids\.csv$/,
      async ([, raw], _body, params, { res }) => {
        const hid = hidOf(raw);
        const run = await history.read(hid);
        if (!run) throw httpError(404, NOT_IN_HISTORY);
        const sobject = params.get('sobject') || undefined;
        const d = new Date(run.startedAt);
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
        const name = `${String(run.workflow?.name || 'workflow').replace(/[^\w.-]+/g, '_')}${sobject ? `-${sobject.replace(/[^\w.-]+/g, '_')}` : ''}-${stamp}-ids.csv`;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-cache' });
        for await (const chunk of history.idRows(hid, { sobject })) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        }
        res.end();
        return STREAMED;
      },
    ],
    [
      'GET',
      /^\/api\/history\/([^/]+)$/,
      async ([, raw]) => {
        const hid = hidOf(raw);
        const run = await history.read(hid);
        if (!run) throw httpError(404, NOT_IN_HISTORY);
        const remaining = await history.remaining(hid);
        const { workflow, ...rest } = run;
        // Parent / child steps: deleting a parent can cascade to its children in Salesforce.
        const referenced = workflow ? poolUsage(workflow, scopeCatalog()).referenced : new Set();
        const hasParents = (run.steps ?? []).some((st) => referenced.has(st.alias));
        return { ...rest, workflowName: workflow?.name ?? '', remaining, pendingBulkJobs: pendingBulkJobs(run), hasParents };
      },
    ],
    [
      'POST',
      /^\/api\/history\/([^/]+)\/forget$/,
      async ([, raw]) => {
        const hid = hidOf(raw);
        await history.ready;
        if (!(await history.read(hid))) throw httpError(404, NOT_IN_HISTORY);
        if (history.inserting.has(hid) || history.deleting.has(hid)) throw httpError(409, 'Lần insert này đang chạy. Chờ nó xong rồi mới quên được.');
        await history.forget(hid);
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/history\/([^/]+)\/delete$/,
      async ([, raw], body, _params, { req, res }) => {
        const hid = hidOf(raw);
        // Review B1: Dừng / a closed tab while the checks run (sf org display takes seconds) must
        // mean nothing is deleted: listen before the first await, look before the first write.
        let gone = false;
        const onEarlyClose = () => { gone = true; };
        res.on('close', onEarlyClose);
        // Review S1: one delete per run at a time, claimed before any await.
        if (history.deleting.has(hid)) throw httpError(409, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
        history.deleting.add(hid);
        let claimed = true;
        const release = () => {
          if (claimed) history.deleting.delete(hid);
          claimed = false;
        };
        let run;
        let target;
        let bulk;
        let remaining;
        let entry;
        let prevDeletion;
        try {
          // Every check runs before a header is sent and before the first write to the org.
          ({ run, target, bulk, remaining } = await checkDelete(hid, body));
          entry = await history.open(hid);
          if (!entry) throw httpError(404, NOT_IN_HISTORY);
          // Review nit: the first save fails ⇒ no delete, and the previous status stays. (The
          // file's deletion, not run.deletion: read() shows "running" while this request holds the claim.)
          prevDeletion = entry.data.deletion ?? { status: 'none' };
          await entry.save({ deletion: { ...prevDeletion, status: 'running' } });
        } catch (e) {
          release();
          res.off('close', onEarlyClose);
          throw e;
        }
        res.off('close', onEarlyClose);
        if (gone || res.destroyed) {
          await entry.save({ deletion: prevDeletion }).catch(() => {});
          release();
          return STREAMED;
        }
        const handle = runs.open();
        const onClose = () => { if (!res.writableEnded) runs.cancel(handle.id); };
        res.on('close', onClose);
        const ndjson = String(req.headers.accept ?? '').includes(NDJSON);
        const emit = (ev) => { if (ndjson && !res.destroyed) res.write(`${JSON.stringify(ev)}\n`); };
        if (ndjson) {
          res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.flushHeaders?.();
        }
        emit({ type: 'start', runId: handle.id, historyId: hid, total: remaining.total, bySobject: remaining.bySobject });
        let last = 0;
        let result;
        try {
          result = await deleteRun({
            client: sfClient, target, entry, history, bulk, signal: handle.signal, forceSignal: handle.forceSignal,
            limits: LIMITS, options: deleteOptions,
            onProgress: (p) => {
              if (p.waitingBulk) return emit({ type: 'progress', phase: 'stopping', waitingBulk: p.waitingBulk, deleted: p.deleted, gone: p.gone, failed: p.failed, total: p.total });
              const t = Date.now();
              if (t - last < 250) return undefined;
              last = t;
              return emit({ type: 'progress', phase: 'delete', deleted: p.deleted, gone: p.gone, failed: p.failed, total: p.total, bySobject: p.bySobject, ...(p.bulk ? { bulk: p.bulk } : {}) });
            },
          });
          const prev = entry.data.deletion ?? {};
          await entry.save({
            deletion: {
              status: result.remaining === 0 && !result.pendingJobs?.length ? 'done' : 'partial',
              deleted: (prev.deleted ?? 0) + result.deleted,
              gone: (prev.gone ?? 0) + result.gone,
              failed: result.failed,
              lastAt: new Date().toISOString(),
              errorGroups: result.errorGroups,
              stopped: result.stopped,
              cancelled: result.cancelled,
            },
          }).catch((e) => console.error(e));
        } catch (e) {
          await entry.save({ deletion: { ...(entry.data.deletion ?? {}), status: 'partial', lastAt: new Date().toISOString() } }).catch(() => {});
          release();
          handle.close();
          res.off('close', onClose);
          if (!ndjson) throw e;
          emit({ type: 'error', error: e.message || String(e) });
          res.end();
          return STREAMED;
        }
        release();
        handle.close();
        res.off('close', onClose);
        const out = { ...result, historyId: hid, runId: handle.id };
        if (ndjson) {
          emit({ type: 'done', result: out });
          res.end();
        } else sendJson(res, 200, out);
        await invalidateAfterInsert(target);
        return STREAMED;
      },
    ],
    [
      'POST',
      /^\/api\/export$/,
      async (_m, body, _params, { res }) => {
        const format = body?.format;
        if (format !== 'csv' && format !== 'json') throw httpError(400, 'format phải là "csv" hoặc "json".');
        if (format === 'csv' && !(typeof body.sobject === 'string' && body.sobject)) throw httpError(400, 'Chọn sObject cần tải CSV.');
        if (body?.seed === undefined || body?.seed === null || body?.now === undefined) {
          throw httpError(400, 'Thiếu seed hoặc now của lần chạy. Bấm Xem trước rồi tải lại.');
        }
        let run;
        // The export of a finished run (preview or insert) uses the Query rows that run used, even
        // when the org changed since (an insert clears the query cache): the file is exactly the data
        // that was shown / inserted.
        const pinned = typeof body.runId === 'string' ? runSnapshots.get(body.runId) : null;
        try {
          ({ run } = await prepareRun(body, { insert: false, pinned }));
        } catch (e) {
          if (e.status === 409) e.message = 'Dữ liệu đọc từ org đã đổi so với lần chạy này. Bấm Xem trước lại rồi tải.';
          throw e;
        }
        await streamExport(res, run, { format, sobject: body.sobject, name: body.workflow?.name });
        return STREAMED;
      },
    ],
    ['GET', /^\/api\/orgs$/, () => cli.listOrgs()],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/limits$/,
      async ([, raw]) => {
        // Read only (GET /limits), for the Insert / delete confirmations: cached 60 s, 3 s at most.
        let org;
        try {
          org = decodeURIComponent(raw);
        } catch {
          throw httpError(404, 'Không có org này.'); // malformed escape (review nit: was a 500)
        }
        const hit = limitsCache.get(org);
        if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.value;
        let timer;
        const l = await Promise.race([
          sfClient.limits(org),
          new Promise((_, reject) => { timer = setTimeout(() => reject(httpError(504, 'Org trả hạn mức API quá chậm.')), LIMITS_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        const pick = (x) => (x ? { max: x.Max, remaining: x.Remaining } : null);
        const value = { api: pick(l?.DailyApiRequests), bulkBatches: pick(l?.DailyBulkApiBatches) };
        limitsCache.set(org, { at: Date.now(), value });
        return value;
      },
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/sobjects$/,
      async ([, org], _body, params) => {
        // ?for=query: objects a Query step can read; default: objects a Record step can create.
        const forQuery = params.get('for') === 'query';
        const r = await sfClient.describeGlobal(decodeURIComponent(org));
        return r.sobjects
          .filter((s) => (forQuery ? s.queryable : s.createable) && !s.deprecatedAndHidden)
          .map((s) => ({ name: s.name, label: s.label, custom: s.custom }))
          .sort((a, b) => a.label.localeCompare(b.label));
      },
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/sobjects\/([A-Za-z0-9_]+)\/fields$/,
      async ([, org, name]) => mapQueryFields(await sfClient.describe(decodeURIComponent(org), name)),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/sobjects\/([A-Za-z0-9_]+)$/,
      async ([, org, name]) => mapDescribe(await sfClient.describe(decodeURIComponent(org), name)),
    ],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const refused = requestGuard(req, { allowedHosts });
        if (refused) throw httpError(refused.status, refused.message);
        const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
        if (!route) throw httpError(404, 'Không có API này.');
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const data = await route[2](url.pathname.match(route[1]), body, url.searchParams, { req, res });
        if (data === STREAMED) return undefined;
        return sendJson(res, 200, data);
      }
      return await serveStatic(url.pathname, res);
    } catch (e) {
      if (res.headersSent) {
        // A streamed response cannot change its status any more: cut it so the client sees it failed.
        console.error(e);
        res.destroy(e);
        return undefined;
      }
      if (e instanceof WorkflowError) return sendJson(res, 422, { error: 'Workflow chưa hợp lệ.', issues: e.issues });
      const status = e.status ?? 500;
      if (!e.status) console.error(e); // unexpected errors only; known ones (sf missing, 4xx) go to the client
      // 409 (org data changed) and Salesforce errors of a Query step name the step in `issues`.
      return sendJson(res, status, { error: e.message, ...(e.issues ? { issues: e.issues } : {}), ...(e.code && typeof e.code === 'string' && e.status ? { code: e.code } : {}) });
    }
  };
}

/** CSV value as in the results table: `{ $ref }` → its ref, objects as JSON, null → empty. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? (v.$ref ?? JSON.stringify(v)) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Regenerates the run (same seed, now, queryResults ⇒ the very records of the preview) straight
 * into the response: JSON = an array with one record per line; CSV = one sObject, columns in
 * workflow order. Honours `drain`, yields the event loop and stops when the client goes away.
 */
async function streamExport(res, run, { format, sobject, name }) {
  const it = run.records();
  let first = it.next(); // a generation error before any byte is sent is still a 422
  const base = String(name || 'workflow').replace(/[^\w.-]+/g, '_');
  const file = format === 'csv' ? `${base}-${String(sobject).replace(/[^\w.-]+/g, '_')}.csv` : `${base}.json`;
  res.writeHead(200, {
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file}"`,
    'Cache-Control': 'no-cache',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = async (chunk) => {
    if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
  };
  const cols = run.columnsBySobject[sobject] ?? [];
  if (format === 'csv') await write(`${['ref', ...cols].join(',')}\r\n`);
  else await write('[');
  let n = 0;
  for (let step = first; !step.done && !closed; step = it.next()) {
    const r = step.value;
    if (format === 'csv') {
      if (r.sobject === sobject) await write(`${[r.ref, ...cols.map((c) => csvCell(r.fields[c]))].join(',')}\r\n`);
    } else await write(`${n ? ',' : ''}\n${JSON.stringify(r)}`);
    if (++n % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  first = null;
  if (closed) {
    it.return();
    return;
  }
  if (format === 'json') await write(n ? '\n]\n' : ']\n');
  res.end();
}

const fmtNum = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Workflow quá lớn.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Body không phải JSON hợp lệ.');
  }
}

async function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw httpError(400, 'Đường dẫn không hợp lệ.');
  }
  const shared = decoded.startsWith('/shared/');
  const dir = shared ? SHARED_DIR : CLIENT_DIR;
  const rel = pathname === '/' ? 'index.html' : decoded.slice(shared ? '/shared/'.length : 0).replace(/^\/+/, '');
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) throw httpError(403, 'Forbidden');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    throw httpError(404, 'Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(await readFile(file));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  http.createServer(createApp({ allowedHosts: allowedHostsFor(host) })).listen(port, host, () => {
    console.log(`sf-data-generator: http://${host}:${port}`);
  });
}
