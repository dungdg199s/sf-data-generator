// A fake Salesforce on localhost for tests that run the real jsforce (design 0011, step 0).
// It does not import jsforce, so test/jsforce.test.js can still clear the proxy variables before
// importing it. Every request is recorded; `writes()` lists the ones that change data or job state
// (POST / PUT / PATCH / DELETE).
//
// Endpoints (under /services/data/v<version>):
//   POST   /composite/sobjects                     create (sObject Collections), one SaveResult per record
//   DELETE /composite/sobjects?ids=…[&allOrNone=…]  delete; an unknown / already deleted Id → ENTITY_IS_DELETED
//   POST   /jobs/ingest                            create a Bulk 2.0 ingest job (state Open)
//   PUT    /jobs/ingest/:id/batches                upload the CSV
//   PATCH  /jobs/ingest/:id                        { state: UploadComplete | Aborted }
//   GET    /jobs/ingest/:id                        InProgress for `progressChecks` checks, then JobComplete (or `jobState`)
//   GET    /jobs/ingest/:id/successfulResults      CSV, lines in REVERSED order (Salesforce gives no order)
//   GET    /jobs/ingest/:id/failedResults          CSV
//   GET    /limits
// A token other than `token` (when set) gets 401 INVALID_SESSION_ID, like an expired session.

import http from 'node:http';

const PREFIX = { Account: '001', Contact: '003', Lead: '00Q', Opportunity: '006' };

/** Minimal CSV parser (quoted cells, "" escapes, LF / CRLF). → array of rows (arrays of strings). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const toCsv = (cols, rows) => `${[cols.map(q).join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n')}\n`;

/**
 * @param opts.version      API version in URLs ('62.0')
 * @param opts.token        accepted bearer token (null: any)
 * @param opts.fail         (record, sobject) → null | { statusCode, message, fields } (create and Bulk insert)
 * @param opts.failDelete   (id, sobject) → null | { statusCode, message, fields }
 * @param opts.progressChecks  GET checks answered InProgress before JobComplete (default 1)
 * @param opts.jobState     (job) → final state ('JobComplete' default; 'Failed' to fail a job)
 * @param opts.createJob    (body) → null | { status, errorCode, message } to refuse a job
 * @param opts.limits       body of GET /limits
 * → { url, requests, writes(), records (Map id → { sobject, fields }), deleted (Set), jobs (Map), close() }
 */
export async function startFakeSalesforce(opts = {}) {
  const version = opts.version ?? '62.0';
  const base = `/services/data/v${version}`;
  const requests = [];
  const records = new Map();
  const deleted = new Set();
  const jobs = new Map();
  let seq = 0;
  let jobSeq = 0;
  const newId = (sobject) => `${PREFIX[sobject] ?? 'a00'}${String(++seq).padStart(12, '0')}AAA`;

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: url.search, url: req.url, body, auth: req.headers.authorization });
      const json = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const csv = (text) => {
        res.writeHead(200, { 'Content-Type': 'text/csv' });
        res.end(text);
      };
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
      }
      const p = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
      if (p === null) return json(404, [{ errorCode: 'NOT_FOUND', message: url.pathname }]);

      if (p === '/composite/sobjects' && req.method === 'POST') {
        const { records: recs } = JSON.parse(body);
        return json(200, recs.map(({ attributes, ...fields }) => {
          const err = opts.fail?.(fields, attributes.type);
          if (err) return { success: false, errors: [{ fields: [], ...err }] };
          const id = newId(attributes.type);
          records.set(id, { sobject: attributes.type, fields });
          return { id, success: true, errors: [] };
        }));
      }
      if (p === '/composite/sobjects' && req.method === 'DELETE') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        return json(200, ids.map((id) => deleteOne(id)));
      }
      if (p === '/limits' && req.method === 'GET') {
        return json(200, opts.limits ?? { DailyApiRequests: { Max: 15000, Remaining: 14200 }, DailyBulkApiBatches: { Max: 15000, Remaining: 14980 } });
      }
      let m;
      if (p === '/jobs/ingest' && req.method === 'POST') {
        const b = JSON.parse(body);
        const refused = opts.createJob?.(b);
        if (refused) return json(refused.status ?? 400, [{ errorCode: refused.errorCode, message: refused.message }]);
        const id = `7504x${String(++jobSeq).padStart(10, '0')}`;
        const job = { id, object: b.object, operation: b.operation, state: 'Open', csv: '', checks: 0, lineEnding: b.lineEnding, columnDelimiter: b.columnDelimiter, numberRecordsProcessed: 0, numberRecordsFailed: 0 };
        jobs.set(id, job);
        return json(200, info(job));
      }
      if ((m = /^\/jobs\/ingest\/([^/]+)\/batches$/.exec(p)) && req.method === 'PUT') {
        const job = jobs.get(m[1]);
        if (!job || job.state !== 'Open') return json(400, [{ errorCode: 'INVALIDJOBSTATE', message: 'not open' }]);
        job.csv += body;
        res.writeHead(201);
        return res.end();
      }
      if ((m = /^\/jobs\/ingest\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
        const job = jobs.get(m[1]);
        if (!job) return json(404, [{ errorCode: 'NOT_FOUND', message: 'job' }]);
        const { state } = JSON.parse(body);
        if (state === 'UploadComplete') job.state = 'UploadComplete';
        else if (state === 'Aborted') {
          job.state = 'Aborted';
          job.aborted = true;
        }
        return json(200, info(job));
      }
      if ((m = /^\/jobs\/ingest\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        const job = jobs.get(m[1]);
        if (!job) return json(404, [{ errorCode: 'NOT_FOUND', message: 'job' }]);
        if (job.state === 'UploadComplete' || job.state === 'InProgress') {
          job.checks++;
          if (job.checks > (opts.progressChecks ?? 1)) runJob(job);
          else job.state = 'InProgress';
        }
        return json(200, info(job));
      }
      if ((m = /^\/jobs\/ingest\/([^/]+)\/(successfulResults|failedResults)$/.exec(p)) && req.method === 'GET') {
        const job = jobs.get(m[1]);
        if (!job) return json(404, [{ errorCode: 'NOT_FOUND', message: 'job' }]);
        if (m[2] === 'successfulResults') return csv(toCsv(['sf__Id', 'sf__Created', ...(job.cols ?? [])], [...(job.ok ?? [])].reverse()));
        return csv(toCsv(['sf__Id', 'sf__Error', ...(job.cols ?? [])], job.ko ?? []));
      }
      return json(404, [{ errorCode: 'NOT_FOUND', message: `${req.method} ${p}` }]);
    });
  });

  function deleteOne(id) {
    const rec = records.get(id);
    if (!rec || deleted.has(id)) return { id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }] };
    const err = opts.failDelete?.(id, rec.sobject);
    if (err) return { id, success: false, errors: [{ fields: [], ...err }] };
    deleted.add(id);
    return { id, success: true, errors: [] };
  }

  /** Runs an uploaded job: each line becomes a success (with a new Id / the deleted Id) or a failure. */
  function runJob(job) {
    const [cols = [], ...lines] = parseCsv(job.csv);
    job.cols = cols;
    job.ok = [];
    job.ko = [];
    const finalState = opts.jobState?.(job) ?? 'JobComplete';
    if (finalState === 'Failed') {
      job.state = 'Failed';
      job.errorMessage = 'InvalidBatch : Failed to process query';
      return;
    }
    for (const line of lines) {
      const row = Object.fromEntries(cols.map((c, i) => [c, line[i] ?? '']));
      if (job.operation === 'insert') {
        const fields = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== ''));
        const err = opts.fail?.(fields, job.object);
        if (err) job.ko.push({ sf__Id: '', sf__Error: `${err.statusCode}:${err.message}:${(err.fields ?? []).join(',')} --`, ...row });
        else {
          const id = newId(job.object);
          records.set(id, { sobject: job.object, fields });
          job.ok.push({ sf__Id: id, sf__Created: 'true', ...row });
        }
      } else if (job.operation === 'delete') {
        const r = deleteOne(row.Id);
        if (r.success) job.ok.push({ sf__Id: row.Id, sf__Created: 'false', ...row });
        else {
          const e = r.errors[0];
          job.ko.push({ sf__Id: row.Id, sf__Error: `${e.statusCode}:${e.message}:${(e.fields ?? []).join(',')} --`, ...row });
        }
      }
    }
    job.numberRecordsProcessed = lines.length;
    job.numberRecordsFailed = job.ko.length;
    job.state = 'JobComplete';
  }

  const info = (job) => ({
    id: job.id, object: job.object, operation: job.operation, state: job.state, lineEnding: job.lineEnding, columnDelimiter: job.columnDelimiter,
    numberRecordsProcessed: job.numberRecordsProcessed, numberRecordsFailed: job.numberRecordsFailed, ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    version,
    requests,
    records,
    deleted,
    jobs,
    writes: () => requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
