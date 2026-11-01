// HTTP entry point: JSON API under /api, static client from /client, and the pure modules
// shared by client and server from /shared (served at /shared/…). No framework on purpose.
// Binds to 127.0.0.1 by default — the server acts with the local sf CLI's org credentials,
// so it must not be reachable from the network unless HOST is set explicitly.

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeGenerators, VALUE_TYPES } from './generators/index.js';
import { serializableNodeTypes, STEP_CATEGORIES, LIMITS, QUERY_PRESETS, RECORD_PRESETS, RECORD_DEFAULT_FIELDS, WORKFLOW_GLOBALS } from './workflow/nodes.js';
import { TEMPLATE_TOKEN } from './workflow/paths.js';
import { validateWorkflow, prepareWorkflow, insertBlockedReason, WorkflowError } from './workflow/schema.js';
import { createRun, isValidNow } from './workflow/executor.js';
import { fieldSamples } from './workflow/samples.js';
import { executeRun, createRunRegistry, YIELD_EVERY } from './run.js';
import { createSfCli } from './sf/cli.js';
import { createSfClient } from './sf/client.js';
import { mapDescribe, mapQueryFields } from './sf/describe-map.js';
import { createQueryCache, prefetchQueries } from './sf/query.js';
import { createHistory, defaultDataDir, isValidHid } from './history.js';
import { deleteRun, collectPendingJobs } from './sf/delete.js';

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

/**
 * Requests that write to or delete from an org, or abort a Bulk job (review of 0011, S6): an insert
 * (`/api/run` with an org target), a delete or forget of a history entry, a forced cancel.
 */
export function isOrgWrite(method, pathname, body) {
  if (method !== 'POST') return false;
  if (pathname === '/api/run') return body?.target?.kind === 'org';
  if (/^\/api\/history\/[^/]+\/(delete|forget)$/.test(pathname)) return true;
  if (/^\/api\/runs\/[^/]+\/cancel$/.test(pathname)) return body?.force === true;
  return false;
}

/**
 * On a wildcard bind (HOST=0.0.0.0 / ::) requestGuard cannot check Host against a list, so the
 * requests of isOrgWrite still need a Host that cannot be a DNS-rebinding name: an IP literal,
 * localhost, or this machine's own host name. → { status, message } | null
 */
export function writeHostGuard(req, { hostname: machine = os.hostname() } = {}) {
  const host = String(req.headers.host ?? '');
  let name = host.toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']') > 0 ? name.indexOf(']') : undefined);
  else name = name.replace(/:\d+$/, '');
  if (net.isIP(name) || name === 'localhost' || name === String(machine).toLowerCase()) return null;
  return {
    status: 403,
    message: `Từ chối ghi hoặc xóa dữ liệu org qua địa chỉ "${host}". Server đang nghe mọi địa chỉ mạng, nên thao tác này chỉ nhận qua địa chỉ IP, localhost hoặc tên máy "${machine}". Mở app bằng http://127.0.0.1:<cổng>.`,
  };
}

/** Hosts for requestGuard from the HOST the server listens on (a wildcard bind accepts any name). */
export function allowedHostsFor(bindHost) {
  if (bindHost && WILDCARD_HOSTS.has(bindHost)) return null;
  return new Set([...LOCAL_HOSTS, ...(bindHost ? [String(bindHost).toLowerCase()] : [])]);
}

const HISTORY_MISSING = 'Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).';
const LIMITS_CACHE_MS = 60000;
const LIMITS_TIMEOUT_MS = 3000;

/** Kind of an org from `sf org list` (design 0011): sandbox, scratch, production; unknown when not listed. */
export function orgKind(orgs, { alias, username }) {
  const o = (orgs ?? []).find((x) => (username && x.username === username) || (alias && x.alias === alias));
  if (!o) return 'unknown';
  return o.isScratch ? 'scratch' : o.isSandbox ? 'sandbox' : 'production';
}

export function createApp({
  cli = createSfCli(), client, queryCache = createQueryCache(), runOptions = {}, allowedHosts = allowedHostsFor(null),
  history = createHistory({ dir: defaultDataDir(), maxRuns: LIMITS.historyMaxRuns, maxBytes: LIMITS.historyMaxBytes }),
  deleteOptions = {},
} = {}) {
  const sfClient = client ?? createSfClient({ cli });
  const runs = createRunRegistry();
  const limitsCache = new Map(); // org → { at, value }

  /**
   * Who an org target is right now: org Id and username from Salesforce's identity service through
   * the very connection that writes (`client.whoami`, review of 0011 S1), kind from `sf org list`.
   * Kept in history and checked before a delete. Never the token. Throws when Salesforce does not
   * say, or says something else than the sf CLI. kind: 'unknown' when `sf org list` fails or does
   * not list it.
   */
  async function orgInfo(target, { refresh = false } = {}) {
    const [who, orgs] = await Promise.all([sfClient.whoami(target, { refresh }), Promise.resolve().then(() => cli.listOrgs()).catch(() => null)]);
    if (!who?.orgId || !who?.username) throw new Error('Salesforce không trả org Id và username của kết nối.');
    if ((who.cli?.orgId && who.cli.orgId !== who.orgId) || (who.cli?.username && who.cli.username !== who.username)) {
      throw Object.assign(new Error(`sf CLI ghi org ${who.cli.orgId ?? '?'} (${who.cli.username ?? '?'}) nhưng token thuộc org ${who.orgId} (${who.username}).`), { code: 'ORG_MISMATCH' });
    }
    const listed = orgs?.find((o) => o.username === who.username || o.alias === target);
    return {
      alias: listed?.alias ?? (target !== who.username ? target : null),
      username: who.username,
      orgId: who.orgId,
      instanceUrl: who.instanceUrl ?? null,
      kind: orgs ? orgKind(orgs, { alias: target, username: who.username }) : 'unknown',
    };
  }

  /**
   * Every check of a delete (design 0011 §8), before any header is sent and before any write call.
   * Throws the HTTP error of the first one that fails. → { target, rem }
   */
  async function checkDelete(hid, data, body) {
    const kind = history.activeKind(hid);
    if (kind === 'insert' || data.status === 'running') throw httpError(409, 'Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới xóa.');
    if (kind === 'delete') throw httpError(409, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
    const confirm = body?.confirm;
    if (!confirm || typeof confirm !== 'object' || typeof confirm.username !== 'string' || !Number.isInteger(confirm.count)) {
      throw httpError(400, 'Thiếu xác nhận (org và số bản ghi). Chỉ xóa được từ hộp xác nhận của app.');
    }
    if (body.bulk !== undefined && body.bulk !== 'auto' && body.bulk !== 'off') throw httpError(400, 'bulk phải là "auto" hoặc "off".');
    const was = data.org ?? {};
    if (!was.username || confirm.username !== was.username) {
      throw httpError(409, `Xác nhận ghi org "${confirm.username}" nhưng lần insert này thuộc org "${was.username ?? '?'}". Mở lại hộp xác nhận.`);
    }
    // Known Ids only here; Bulk jobs not collected yet are read after the org checks (S2).
    const rem = await history.remaining(hid);
    const pending = (data.bulkJobs ?? []).some((j) => !j.idsCollected);
    if (!pending) countCheck(rem, confirm.count);
    const target = was.alias ?? was.username;
    const name = was.alias ?? was.username;
    let now;
    try {
      now = await orgInfo(target, { refresh: true });
    } catch (e) {
      if (e.code === 'ORG_MISMATCH') throw httpError(409, `${e.message} Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias ${name} rồi thử lại.`);
      throw httpError(502, `${e.message} Đăng nhập lại: sf org login web --alias ${name}`);
    }
    // The alias must still be the very org (and user) of the insert: a re-login into a refreshed
    // sandbox keeps the alias but is another org.
    const sameOrg = was.orgId && now.orgId ? was.orgId === now.orgId : Boolean(was.instanceUrl) && was.instanceUrl === now.instanceUrl;
    if (!sameOrg || now.username !== was.username) {
      throw httpError(409, `Org "${name}" bây giờ là org khác (${now.orgId ?? now.instanceUrl ?? '?'}, ${now.username ?? '?'}) so với lúc insert (${was.orgId ?? was.instanceUrl ?? '?'}, ${was.username}). Không xóa gì. Đăng nhập lại đúng org bằng sf org login web --alias ${name} rồi thử lại.`);
    }
    // Production (or a kind the CLI could not tell): the org name typed by hand.
    if (now.kind !== 'sandbox' && now.kind !== 'scratch') {
      const typed = typeof confirm.typedOrg === 'string' ? confirm.typedOrg.trim().toLowerCase() : '';
      const names = [was.alias, was.username].filter(Boolean).map((x) => x.toLowerCase());
      if (!typed || !names.includes(typed)) throw httpError(400, `Org "${name}" là production: gõ đúng tên org trong hộp xác nhận để xóa.`);
    }
    return { target, rem, pending };
  }

  /** confirm.count must be exactly what this delete may remove (review of 0011, S2). */
  function countCheck(rem, count, { added = 0, stillPending = [] } = {}) {
    if (rem.total === 0) {
      const waiting = stillPending.length ? ` Job Bulk ${stillPending.map((j) => j.jobId).join(', ')} chưa trả Id (đang chạy hoặc chưa có kết quả); thử lại sau.` : '';
      throw httpError(409, `Lần insert này không còn bản ghi nào để xóa.${waiting}`);
    }
    if (count === rem.total) return;
    if (added) throw Object.assign(httpError(409, `Số bản ghi cần xóa đã đổi thành ${rem.total} vì vừa lấy được Id từ job Bulk. Xác nhận lại.`), { body: { count: rem.total, collected: added } });
    throw Object.assign(httpError(409, `Số bản ghi còn phải xóa đã đổi (còn ${rem.total}, hộp xác nhận ghi ${count}). Mở lại hộp xác nhận để xem số mới.`), { body: { count: rem.total } });
  }

  /** The history entry of a URL segment, or 404 (also for a malformed hid: no path traversal). */
  async function historyEntry(raw) {
    let hid;
    try {
      hid = decodeURIComponent(raw);
    } catch {
      hid = null;
    }
    if (!isValidHid(hid)) throw httpError(404, HISTORY_MISSING);
    const data = await history.read(hid);
    if (!data) throw httpError(404, HISTORY_MISSING);
    return { hid, data };
  }

  /** Checks shared by /api/run and /api/export, then the Query pre-fetch (0006): all before any header is sent. */
  async function prepareRun(body, { insert, pinned = null }) {
    // A Date holds ±8.64e15 ms: a larger `now` would fail inside the run (review of 0013).
    if (body?.now !== undefined && !isValidNow(body.now)) throw httpError(400, 'Tham số now không hợp lệ.');
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
        recordPresets: RECORD_PRESETS,
        recordDefaultFields: RECORD_DEFAULT_FIELDS,
        globals: WORKFLOW_GLOBALS,
        syntax: { templateToken: TEMPLATE_TOKEN, valueTypes: VALUE_TYPES },
      }),
    ],
    ['POST', /^\/api\/validate$/, (_m, body) => validateWorkflow(body?.workflow, { derived: true })],
    // Design 0012 E: a few values of one field for the inspector (no I/O, no org).
    ['POST', /^\/api\/field-samples$/, (_m, body) => fieldSamples(body)],
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
          if (body.target.bulk !== undefined && body.target.bulk !== 'auto' && body.target.bulk !== 'off') {
            throw httpError(400, 'target.bulk phải là "auto" hoặc "off".');
          }
        }
        // Validation (422), the Query pre-fetch (409 / 502) and `now` (400) answer as plain JSON.
        const { run, pre, workflow } = await prepareRun(body, { insert });
        const target = insert ? body.target.org : null;
        // Org identity for the history entry, read while the dry pass runs (design 0011 §5).
        const org = target ? orgInfo(target) : null;
        org?.catch(() => {});
        const orgRun = target ? { history, org, workflow, bulk: body.target.bulk ?? 'auto' } : {};
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
            end = await executeRun({ run, target, sfClient, signal: handle.signal, forceSignal: handle.forceSignal, start: { ...start, runId: handle.id }, collect: true, ...orgRun, ...runOptions });
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
            run, target, sfClient, signal: handle.signal, forceSignal: handle.forceSignal, start: { ...start, runId: handle.id }, ...orgRun, ...runOptions,
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
        // { force: true } = Dừng ngay: also abort the Bulk job being processed (design 0011 §3).
        if (!id || !runs.cancel(id, { force: body?.force === true })) throw httpError(404, 'Lần chạy này đã kết thúc.');
        return { ok: true };
      },
    ],
    // ---------- insert history (design 0011 §5): files on this machine, never the org ----------
    [
      'GET',
      /^\/api\/history$/,
      async () => {
        const st = await history.status();
        return { enabled: st.enabled, ...(st.reason ? { reason: st.reason } : {}), dir: st.dir, maxRuns: st.maxRuns, runs: st.enabled ? await history.list() : [] };
      },
    ],
    [
      'GET',
      /^\/api\/history\/([^/]+)$/,
      async ([, raw]) => {
        const { hid, data } = await historyEntry(raw);
        const rem = await history.remaining(hid);
        const { workflow, ...rest } = data;
        return {
          ...rest,
          workflowName: workflow?.name ?? '',
          ...(history.activeKind(hid) ? { active: history.activeKind(hid) } : {}),
          remaining: { total: rem.total, bySobject: rem.bySobject, steps: rem.steps.map((s) => ({ nodeId: s.nodeId, sobject: s.sobject, remaining: s.ids.length })) },
          // Bulk jobs whose Ids are not in the file yet: a delete reads them first and asks to confirm the new count.
          pendingBulkJobs: (data.bulkJobs ?? []).filter((j) => !j.idsCollected).map((j) => ({ jobId: j.jobId, sobject: j.sobject, nodeId: j.nodeId, records: j.records, state: j.state })),
        };
      },
    ],
    [
      'GET',
      /^\/api\/history\/([^/]+)\/ids\.csv$/,
      async ([, raw], _body, params, { res }) => {
        const { hid, data } = await historyEntry(raw);
        await streamIdsCsv(res, history, hid, data, params.get('sobject'));
        return STREAMED;
      },
    ],
    [
      'POST',
      /^\/api\/history\/([^/]+)\/forget$/,
      async ([, raw]) => {
        const { hid, data } = await historyEntry(raw);
        if (history.activeKind(hid) || data.status === 'running') throw httpError(409, 'Lần insert này đang chạy. Bấm "Dừng", chờ nó dừng rồi mới quên.');
        await history.forget(hid);
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/history\/([^/]+)\/delete$/,
      async ([, raw], body, _params, { req, res }) => {
        const { hid, data } = await historyEntry(raw);
        const checked = await checkDelete(hid, data, body);
        const { target } = checked;
        let { rem } = checked;
        // Checked again right before marking: another request may have started meanwhile.
        if (history.activeKind(hid)) throw httpError(409, 'Đang xóa dữ liệu của lần insert này ở một tab khác. Chờ lần đó xong.');
        const release = history.markActive(hid, 'delete');
        // S2: Bulk jobs whose Ids were never read are collected FIRST (read-only), then the count the
        // user confirmed is compared with the new total; a difference ⇒ 409 and nothing deleted.
        let collected = { added: 0, pending: [] };
        try {
          if (checked.pending) {
            collected = await collectPendingJobs({ client: sfClient, history, hid, target });
            rem = await history.remaining(hid);
            if (!rem) throw httpError(404, HISTORY_MISSING);
            countCheck(rem, body.confirm.count, { added: collected.added, stillPending: collected.pending });
          }
        } catch (e) {
          release();
          throw e;
        }
        const handle = runs.open();
        const onClose = () => { if (!res.writableEnded) runs.cancel(handle.id); };
        res.on('close', onClose);
        const ndjson = String(req.headers.accept ?? '').includes(NDJSON);
        const emit = (ev) => { if (ndjson && !res.destroyed) res.write(`${JSON.stringify(ev)}\n`); };
        const bySobject = rem.bySobject;
        if (ndjson) {
          res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.flushHeaders?.();
        }
        emit({ type: 'start', runId: handle.id, historyId: hid, total: rem.total, bySobject });
        let result;
        let failure = null;
        let last = 0;
        try {
          result = await deleteRun({
            client: sfClient, history, hid, target, bulk: body.bulk ?? 'auto', signal: handle.signal, forceSignal: handle.forceSignal, ...deleteOptions,
            collected: collected.added, pendingBulkJobs: collected.pending,
            onProgress: (p) => {
              const t = Date.now();
              if (t - last < (runOptions.progressIntervalMs ?? 250)) return;
              last = t;
              emit({ type: 'progress', phase: 'delete', ...p });
            },
          });
        } catch (e) {
          failure = e;
        } finally {
          release();
          handle.close();
          res.off('close', onClose);
        }
        if (failure) {
          if (!failure.status) console.error(failure);
          if (!ndjson) throw failure;
          emit({ type: 'error', error: failure.message });
          res.end();
        } else if (ndjson) {
          emit({ type: 'done', result });
          res.end();
        } else sendJson(res, 200, result);
        await invalidateAfterInsert(target);
        return STREAMED;
      },
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/limits$/,
      async ([, raw]) => {
        const org = decodeURIComponent(raw);
        const hit = limitsCache.get(org);
        if (hit && Date.now() - hit.at < LIMITS_CACHE_MS) return hit.value;
        let timer;
        const l = await Promise.race([
          sfClient.limits(org),
          new Promise((_, reject) => { timer = setTimeout(() => reject(httpError(504, 'Org trả hạn mức API quá chậm.')), LIMITS_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        const pair = (x) => (x && Number.isFinite(x.Max) ? { max: x.Max, remaining: x.Remaining } : null);
        const value = { api: pair(l?.DailyApiRequests), bulkBatches: pair(l?.DailyBulkApiBatches) };
        limitsCache.set(org, { at: Date.now(), value });
        return value;
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
        if (allowedHosts === null && isOrgWrite(req.method, url.pathname, body)) {
          const refusedWrite = writeHostGuard(req);
          if (refusedWrite) throw httpError(refusedWrite.status, refusedWrite.message);
        }
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
      return sendJson(res, status, { error: e.message, ...(e.issues ? { issues: e.issues } : {}), ...(e.body ?? {}) });
    }
  };
}

/**
 * Ids of a history entry as CSV: sobject,id,ref,step,status (status = inserted | deleted | gone),
 * optionally one sObject. File name: <workflow>-<yyyyMMdd-HHmm>-ids.csv (time of the insert).
 */
async function streamIdsCsv(res, history, hid, data, sobject) {
  const outcome = await history.deletedMap(hid);
  const t = new Date(data.startedAt ?? Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const when = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}`;
  const base = String(data.workflow?.name || 'workflow').replace(/[^\w.-]+/g, '_');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${base}-${when}-ids.csv"`,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = async (chunk) => {
    if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
  };
  await write('sobject,id,ref,step,status\r\n');
  let lines = [];
  for await (const r of history.ids(hid)) {
    if (closed) break;
    if (sobject && r.sobject !== sobject) continue;
    lines.push([r.sobject, r.id, r.ref, r.nodeId, outcome.get(r.id) ?? 'inserted'].map(csvCell).join(','));
    if (lines.length >= 1000) {
      await write(`${lines.join('\r\n')}\r\n`);
      lines = [];
    }
  }
  if (lines.length && !closed) await write(`${lines.join('\r\n')}\r\n`);
  res.end();
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
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error();
  } catch {
    throw httpError(404, 'Not found');
  }
  // no-cache + a validator: the browser always asks, an unchanged file answers 304 (no body), and the
  // cached copy keeps its compiled-code cache, so a reload does not parse every module again.
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (res.req?.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(await readFile(file));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  http.createServer(createApp({ allowedHosts: allowedHostsFor(host) })).listen(port, host, () => {
    console.log(`sf-data-generator: http://${host}:${port}`);
  });
}
