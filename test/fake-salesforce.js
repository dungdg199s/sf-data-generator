// A fake Salesforce REST + Bulk API 2.0 server on localhost (design 0011, step 0), shared by the
// tests that drive real jsforce (test/jsforce.test.js) and the server tests. It must NOT import
// jsforce: jsforce reads the proxy variables once at load time, and test/jsforce.test.js clears
// them before its own dynamic import.
//
// It keeps the records it "created" (Id → { sobject, fields, deleted }), logs every request, and
// counts write requests (POST / PUT / PATCH / DELETE) so a test can assert that a refused delete
// sent nothing. Endpoints (under /services/data/v<version>):
//   POST   /composite/sobjects                       create (one SaveResult per record, in order)
//   DELETE /composite/sobjects?ids=…                  destroy (ENTITY_IS_DELETED for unknown/deleted Ids)
//   POST   /jobs/ingest                               open a Bulk 2.0 job (insert | delete)
//   PUT    /jobs/ingest/:id/batches                   upload the CSV
//   PATCH  /jobs/ingest/:id                           { state: UploadComplete | Aborted }
//   GET    /jobs/ingest/:id                           InProgress for `checksBeforeComplete` checks, then JobComplete / Failed
//   GET    /jobs/ingest/:id/successfulResults         CSV, rows deliberately in REVERSE order
//   GET    /jobs/ingest/:id/failedResults             CSV with sf__Error
//   GET    /limits                                    DailyApiRequests, DailyBulkApiBatches
//   GET    /sobjects/:name/describe                   { name, keyPrefix } (001 Account, 003 Contact, …)
//   GET    /services/data/v62.0                       REST root with the `identity` URL (fake.identity: orgId, userId, username)
//   GET    /query?q=SELECT Username FROM User WHERE Id = '…'   the whoami query (nothing else)
//
// Behaviour hooks (all optional, set on `options` or later on `fake.options`):
//   createError(fields, sobject)  → null | { statusCode, message, fields }   (Collections create and Bulk insert rows)
//   deleteError(id, record)       → null | { statusCode, message, fields }
//   openJobError(body)            → null | { status, errorCode, message }    (POST /jobs/ingest)
//   jobFinal(job)                 → 'JobComplete' | 'Failed'  (default JobComplete; Failed sets errorMessage)
//   abortedResults                → true: an aborted job still returns its results (default false: 404)
//   abortKeep                     → rows of a job aborted while InProgress that Salesforce had processed (default 0)
//   checksBeforeComplete          → number of InProgress answers before the final state (default 1)
//   expireOnce                    → Set of 'METHOD path-suffix' answered once with 401 INVALID_SESSION_ID
//   beforeCheck(job)              → async; lets a test pause while a job is "running"
//   limits                        → body of GET /limits

import http from 'node:http';

const PREFIX = { Account: '001', Contact: '003', Lead: '00Q', Opportunity: '006', Case: '500' };

export async function startFakeSalesforce(options = {}) {
  const fake = {
    options: { checksBeforeComplete: 1, abortedResults: false, abortKeep: 0, ...options },
    requests: [], // { method, path, query, body, auth }
    records: new Map(), // id → { sobject, fields, deleted }
    jobs: new Map(),
    url: null,
    version: '62.0',
    /** Who every token of this fake is (identity service); change it to "re-point" the org. */
    identity: { orgId: '00D000000000001AAA', userId: '005000000000001AAA', username: 'me@example.com', ...(options.identity ?? {}) },
    /** Write requests (POST / PUT / PATCH / DELETE) seen so far. */
    writes() {
      return this.requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
    },
    /** Ids alive (created, not deleted). */
    alive(sobject) {
      return [...this.records].filter(([, r]) => !r.deleted && (!sobject || r.sobject === sobject)).map(([id]) => id);
    },
    close: null,
  };
  let seq = 0;
  let jobSeq = 0;
  const newId = (sobject) => `${PREFIX[sobject] ?? 'a00'}${String(++seq).padStart(12, '0')}AAA`;

  function createOne(sobject, fields) {
    const err = fake.options.createError?.(fields, sobject);
    if (err) return { success: false, errors: [{ statusCode: err.statusCode, message: err.message, fields: err.fields ?? [] }] };
    const id = newId(sobject);
    fake.records.set(id, { sobject, fields, deleted: false });
    return { id, success: true, errors: [] };
  }

  function deleteOne(id) {
    const rec = fake.records.get(id);
    if (!rec || rec.deleted) return { id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }] };
    const err = fake.options.deleteError?.(id, rec);
    if (err) return { id, success: false, errors: [{ statusCode: err.statusCode, message: err.message, fields: err.fields ?? [] }] };
    rec.deleted = true;
    return { id, success: true, errors: [] };
  }

  /** Runs the job's rows (on UploadComplete): results kept in upload order. */
  function processJob(job) {
    const rows = parseCsv(job.csv);
    const header = rows.shift() ?? [];
    job.header = header;
    job.results = rows.filter((r) => r.length > 1 || r[0] !== '').map((cells) => {
      const fields = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
      if (job.operation === 'insert') {
        const res = createOne(job.object, fields);
        return res.success ? { ok: true, id: res.id, cells } : { ok: false, error: res.errors[0], cells };
      }
      const res = deleteOne(fields.Id);
      return res.success ? { ok: true, id: fields.Id, cells } : { ok: false, id: fields.Id, error: res.errors[0], cells };
    });
  }

  function jobInfo(job) {
    const processed = job.results ? (job.state === 'Aborted' ? job.kept : job.results.length) : 0;
    const failed = job.results ? job.results.slice(0, processed).filter((r) => !r.ok).length : 0;
    return {
      id: job.id, operation: job.operation, object: job.object, state: job.state,
      numberRecordsProcessed: processed, numberRecordsFailed: failed,
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      const base = `/services/data/v${fake.version}`;
      const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
      const isJson = /json/.test(req.headers['content-type'] ?? '');
      let body = raw;
      if (isJson && raw) {
        try { body = JSON.parse(raw); } catch { /* keep text */ }
      }
      fake.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const json = (status, data) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };
      const csv = (text) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv');
        res.end(text);
      };
      const key = `${req.method} ${path}`;
      for (const k of fake.options.expireOnce ?? []) {
        if (key.endsWith(k)) {
          fake.options.expireOnce.delete(k);
          return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
        }
      }
      try {
        if (req.method === 'POST' && path === '/composite/sobjects') {
          return json(200, body.records.map(({ attributes, ...fields }) => createOne(attributes.type, fields)));
        }
        if (req.method === 'DELETE' && path === '/composite/sobjects') {
          return json(200, String(url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(deleteOne));
        }
        // REST root: its `identity` URL names the org and user (the app parses it, never fetches it:
        // on a real org it points at login.salesforce.com).
        if (req.method === 'GET' && path === '') {
          return json(200, { identity: `https://login.salesforce.com/id/${fake.identity.orgId}/${fake.identity.userId}`, sobjects: `${base}/sobjects` });
        }
        if (req.method === 'GET' && path === '/query') {
          const m = String(url.searchParams.get('q') ?? '').match(/^SELECT Username FROM User WHERE Id = '(\w+)'$/);
          if (!m) return json(400, [{ errorCode: 'MALFORMED_QUERY', message: 'fake: only the whoami query' }]);
          const rec = m[1] === fake.identity.userId ? [{ attributes: { type: 'User' }, Username: fake.identity.username }] : [];
          return json(200, { totalSize: rec.length, done: true, records: rec });
        }
        const desc = req.method === 'GET' && path.match(/^\/sobjects\/([A-Za-z0-9_]+)\/describe$/);
        if (desc) return json(200, { name: desc[1], label: desc[1], keyPrefix: PREFIX[desc[1]] ?? 'a00', fields: [] });
        if (req.method === 'GET' && path === '/limits') {
          return json(200, fake.options.limits ?? { DailyApiRequests: { Max: 15000, Remaining: 14200 }, DailyBulkApiBatches: { Max: 15000, Remaining: 14980 } });
        }
        if (req.method === 'POST' && path === '/jobs/ingest') {
          const err = fake.options.openJobError?.(body);
          if (err) return json(err.status ?? 400, [{ errorCode: err.errorCode, message: err.message }]);
          if (!['insert', 'delete'].includes(body.operation)) return json(400, [{ errorCode: 'INVALIDJOB', message: `fake: operation ${body.operation} refused` }]);
          const job = { id: `7504x${String(++jobSeq).padStart(10, '0')}AAA`, object: body.object, operation: body.operation, state: 'Open', csv: '', checks: 0 };
          fake.jobs.set(job.id, job);
          return json(200, jobInfo(job));
        }
        const m = path.match(/^\/jobs\/ingest\/([^/]+)(\/[A-Za-z]+)?$/);
        const job = m && fake.jobs.get(m[1]);
        if (m && !job) return json(404, [{ errorCode: 'NOT_FOUND', message: 'job not found' }]);
        if (job && req.method === 'PUT' && m[2] === '/batches') {
          if (job.state !== 'Open') return json(400, [{ errorCode: 'INVALIDJOBSTATE', message: 'job not open' }]);
          job.csv += raw;
          res.statusCode = 201;
          return res.end();
        }
        if (job && req.method === 'PATCH' && !m[2]) {
          if (body.state === 'UploadComplete') {
            processJob(job);
            job.state = 'UploadComplete';
          } else if (body.state === 'Aborted') {
            if (job.results && job.state !== 'JobComplete' && job.state !== 'Failed') {
              // Rows past what Salesforce had processed are rolled back in this fake.
              job.kept = Math.min(fake.options.abortKeep, job.results.length);
              for (const r of job.results.slice(job.kept)) if (r.ok && job.operation === 'insert') fake.records.delete(r.id);
            } else job.kept = 0;
            job.state = 'Aborted';
          }
          return json(200, jobInfo(job));
        }
        if (job && req.method === 'GET' && !m[2]) {
          await fake.options.beforeCheck?.(job);
          if (job.state === 'UploadComplete' || job.state === 'InProgress') {
            if (job.checks++ < fake.options.checksBeforeComplete) job.state = 'InProgress';
            else {
              job.state = fake.options.jobFinal?.(job) ?? 'JobComplete';
              if (job.state === 'Failed') job.errorMessage ??= 'InvalidBatch : fake failure';
            }
          }
          return json(200, jobInfo(job));
        }
        if (job && req.method === 'GET' && (m[2] === '/successfulResults' || m[2] === '/failedResults')) {
          if (job.state === 'Aborted' && !fake.options.abortedResults) return json(404, [{ errorCode: 'NOT_FOUND', message: 'no results for an aborted job' }]);
          const done = (job.results ?? []).slice(0, job.state === 'Aborted' ? job.kept : undefined);
          if (m[2] === '/successfulResults') {
            const rows = done.filter((r) => r.ok).reverse(); // order is NOT guaranteed by Salesforce
            return csv(toCsv(['sf__Id', 'sf__Created', ...job.header], rows.map((r) => [r.id, 'true', ...r.cells])));
          }
          const rows = done.filter((r) => !r.ok);
          return csv(toCsv(['sf__Id', 'sf__Error', ...job.header], rows.map((r) => [r.id ?? '', `${r.error.statusCode}:${r.error.message}:${(r.error.fields ?? []).join(',')} --`, ...r.cells])));
        }
        return json(404, [{ errorCode: 'NOT_FOUND', message: `fake: no route ${key}` }]);
      } catch (e) {
        return json(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: e.message }]);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => server.close(r));
  return fake;
}

/** CLI stand-in for createSfClient: a token that must never reach history files. */
export function fakeCli(fake, { token = 'SECRET-TOKEN-123', username = 'me@example.com', orgId = '00D000000000001AAA', alias = 'dev', isSandbox = true } = {}) {
  return {
    username, orgId, alias,
    async listOrgs() {
      return [{ alias, username: this.username, instanceUrl: fake.url, isDefault: true, isScratch: false, isSandbox }];
    },
    async getConnection(_target, { refresh = false } = {}) {
      return { accessToken: refresh ? `${token}-fresh` : token, instanceUrl: fake.url, apiVersion: fake.version, username: this.username, orgId: this.orgId };
    },
  };
}

function cell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes) → rows of cells. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
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
