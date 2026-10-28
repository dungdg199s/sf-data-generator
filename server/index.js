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

export function createApp({ cli = createSfCli(), client, queryCache = createQueryCache(), runOptions = {} } = {}) {
  const sfClient = client ?? createSfClient({ cli });
  const runs = createRunRegistry();

  /** Checks shared by /api/run and /api/export, then the Query pre-fetch (0006): all before any header is sent. */
  async function prepareRun(body, { insert }) {
    if (body?.now !== undefined && !(typeof body.now === 'number' && Number.isFinite(body.now))) throw httpError(400, 'Tham số now không hợp lệ.');
    const { workflow, errors } = prepareWorkflow(body?.workflow);
    if (errors.length) throw new WorkflowError(errors);
    // Query steps are read first (design 0006): when inserting always from the target org
    // (never sample rows), when previewing from `org` if one is selected.
    const org = insert ? body.target.org : typeof body?.org === 'string' && body.org ? body.org : null;
    const pre = await prefetchQueries({
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
        const insert = body?.target?.kind === 'org';
        if (insert) {
          // A v1 workflow whose conversion copied or cut steps runs differently from what the
          // user built; preview is allowed (with warnings), inserting is not until it is saved as v2.
          const blocked = insertBlockedReason(body.workflow);
          if (blocked) throw httpError(422, blocked);
          if (!body.target.org) throw httpError(400, 'Chưa chọn org để insert.');
        }
        // Validation (422), the Query pre-fetch (409 / 502) and `now` (400) answer as plain JSON.
        const { run, pre } = await prepareRun(body, { insert });
        const target = insert ? body.target.org : null;
        const start = { queries: pre.queries, warnings: pre.warnings };

        if (!String(req.headers.accept ?? '').includes(NDJSON)) {
          // One JSON body with every record (scripts, tests); same sinks as the stream.
          const end = await executeRun({ run, target, sfClient, start, collect: true, ...runOptions }).finally(() => target && invalidateAfterInsert(target));
          if (end.type === 'error') throw end.issues ? new WorkflowError(end.issues) : httpError(500, end.error);
          return end.result;
        }

        // NDJSON: one event per line while the run goes on (design 0004).
        const handle = runs.open();
        res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders?.();
        // Closing the tab (or losing the connection) stops the run after the call in flight.
        const onClose = () => { if (!res.writableEnded) runs.cancel(handle.id); };
        res.on('close', onClose);
        try {
          await executeRun({
            run, target, sfClient, signal: handle.signal, start: { ...start, runId: handle.id }, ...runOptions,
            emit: (ev) => { if (!res.destroyed) res.write(`${JSON.stringify(ev)}\n`); },
          });
        } finally {
          handle.close();
          res.off('close', onClose);
          if (target) await invalidateAfterInsert(target);
          res.end();
        }
        return STREAMED;
      },
    ],
    [
      'POST',
      /^\/api\/runs\/([^/]+)\/cancel$/,
      ([, runId]) => {
        if (!runs.cancel(decodeURIComponent(runId))) throw httpError(404, 'Lần chạy này đã kết thúc.');
        return { ok: true };
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
        try {
          ({ run } = await prepareRun(body, { insert: false }));
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
      return sendJson(res, status, e.issues ? { error: e.message, issues: e.issues } : { error: e.message });
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
  http.createServer(createApp()).listen(port, host, () => {
    console.log(`sf-data-generator: http://${host}:${port}`);
  });
}
