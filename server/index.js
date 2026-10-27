// HTTP entry point: JSON API under /api, static client from /client. No framework on purpose.
// Binds to 127.0.0.1 by default — the server acts with the local sf CLI's org credentials,
// so it must not be reachable from the network unless HOST is set explicitly.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeGenerators } from './generators/index.js';
import { NODE_TYPES, LIMITS } from './workflow/nodes.js';
import { validateWorkflow, WorkflowError } from './workflow/schema.js';
import { runWorkflow } from './workflow/executor.js';
import { createSfCli } from './sf/cli.js';
import { createSfClient } from './sf/client.js';
import { mapDescribe } from './sf/describe-map.js';
import { insertRecords } from './sf/insert.js';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
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

export function createApp({ cli = createSfCli(), client } = {}) {
  const sfClient = client ?? createSfClient({ cli });

  const routes = [
    ['GET', /^\/api\/meta$/, () => ({ fieldTypes: describeGenerators(), nodeTypes: NODE_TYPES, limits: LIMITS })],
    ['POST', /^\/api\/validate$/, (_m, body) => validateWorkflow(body?.workflow)],
    [
      'POST',
      /^\/api\/run$/,
      async (_m, body) => {
        const result = runWorkflow(body?.workflow, { seed: body?.seed, maxRecords: body?.maxRecords });
        const response = { seed: result.seed, stats: result.stats, warnings: result.warnings, records: result.records };
        if (body?.target?.kind === 'org') {
          if (!body.target.org) throw httpError(400, 'Chưa chọn org để insert.');
          response.insert = await insertRecords(sfClient, body.target.org, result.records);
        }
        return response;
      },
    ],
    ['GET', /^\/api\/orgs$/, () => cli.listOrgs()],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/sobjects$/,
      async ([, org]) => {
        const r = await sfClient.describeGlobal(decodeURIComponent(org));
        return r.sobjects
          .filter((s) => s.createable && !s.deprecatedAndHidden)
          .map((s) => ({ name: s.name, label: s.label, custom: s.custom }))
          .sort((a, b) => a.label.localeCompare(b.label));
      },
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
        const data = await route[2](url.pathname.match(route[1]), body);
        return sendJson(res, 200, data);
      }
      return await serveStatic(url.pathname, res);
    } catch (e) {
      if (e instanceof WorkflowError) return sendJson(res, 422, { error: 'Workflow chưa hợp lệ.', issues: e.issues });
      const status = e.status ?? 500;
      if (!e.status) console.error(e); // unexpected errors only; known ones (sf missing, 4xx) go to the client
      return sendJson(res, status, { error: e.message });
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
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR + path.sep)) throw httpError(403, 'Forbidden');
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
