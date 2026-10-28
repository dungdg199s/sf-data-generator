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
import { runWorkflow } from './workflow/executor.js';
import { createSfCli } from './sf/cli.js';
import { createSfClient } from './sf/client.js';
import { mapDescribe, mapQueryFields } from './sf/describe-map.js';
import { insertRecords } from './sf/insert.js';
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

export function createApp({ cli = createSfCli(), client, queryCache = createQueryCache() } = {}) {
  const sfClient = client ?? createSfClient({ cli });

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
      async (_m, body) => {
        const insert = body?.target?.kind === 'org';
        if (insert) {
          // A v1 workflow whose conversion copied or cut steps runs differently from what the
          // user built; preview is allowed (with warnings), inserting is not until it is saved as v2.
          const blocked = insertBlockedReason(body.workflow);
          if (blocked) throw httpError(422, blocked);
          if (!body.target.org) throw httpError(400, 'Chưa chọn org để insert.');
        }
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
          expect: insert && body?.expectQueries && typeof body.expectQueries === 'object' ? body.expectQueries : null,
          preview: !insert,
        });
        const result = runWorkflow(body.workflow, { seed: body?.seed, maxRecords: body?.maxRecords, queryResults: pre.results });
        const response = {
          seed: result.seed,
          stats: result.stats,
          warnings: [...result.warnings, ...pre.warnings],
          records: result.records,
          queries: pre.queries,
          samples: result.samples,
        };
        if (insert) {
          response.insert = await insertRecords(sfClient, body.target.org, result.records);
          queryCache.invalidateOrg(body.target.org); // the next preview sees the records just created
        }
        return response;
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
        const data = await route[2](url.pathname.match(route[1]), body, url.searchParams);
        return sendJson(res, 200, data);
      }
      return await serveStatic(url.pathname, res);
    } catch (e) {
      if (e instanceof WorkflowError) return sendJson(res, 422, { error: 'Workflow chưa hợp lệ.', issues: e.issues });
      const status = e.status ?? 500;
      if (!e.status) console.error(e); // unexpected errors only; known ones (sf missing, 4xx) go to the client
      // 409 (org data changed) and Salesforce errors of a Query step name the step in `issues`.
      return sendJson(res, status, e.issues ? { error: e.message, issues: e.issues } : { error: e.message });
    }
  };
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
