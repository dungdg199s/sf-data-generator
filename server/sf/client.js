// Salesforce API access through jsforce. The sf CLI is used only to obtain the access token
// and instance URL (server/sf/cli.js); every API call goes through a jsforce Connection.
//
// One Connection is kept per org target. When Salesforce rejects the token (INVALID_SESSION_ID),
// jsforce calls refreshFn, which asks the sf CLI for a fresh token (`sf org display` refreshes it
// from the CLI's stored auth) and retries the request.

import { Connection } from 'jsforce';

/** Bulk API 2.0 operations the app may run (design 0011): never hardDelete, update or upsert. */
export const BULK_OPERATIONS = Object.freeze(['insert', 'delete']);
/** sObject Collections limit for one create / destroy call. */
const MAX_COLLECTION = 200;

export function createSfClient({ cli, createConnection = (options) => new Connection(options) }) {
  // Connections are keyed by who the CLI says the target is (instance URL + username + org Id), so
  // an alias re-pointed at another org (re-login after a sandbox refresh) gets a new connection
  // instead of writing with the old one (review of 0011, S1).
  const connections = new Map(); // identity key -> Promise<Connection>
  const keyOf = (info) => `${info.instanceUrl}|${info.username ?? ''}|${info.orgId ?? ''}`;

  async function connectionFor(target, { refresh = false } = {}) {
    const info = refresh ? await cli.getConnection(target, { refresh: true }) : await cli.getConnection(target);
    const key = keyOf(info);
    if (!connections.has(key)) {
      const pending = Promise.resolve().then(() => createConnection({
        instanceUrl: info.instanceUrl,
        accessToken: info.accessToken,
        version: info.apiVersion,
        refreshFn: (_conn, callback) => {
          cli.getConnection(target, { refresh: true }).then(
            (fresh) => {
              // A fresh token for another org or user must never be used by this connection.
              if ((info.orgId && fresh.orgId && fresh.orgId !== info.orgId) || (info.username && fresh.username && fresh.username !== info.username)) {
                callback(Object.assign(new Error(`Org "${target}" bây giờ là org khác (${fresh.orgId ?? '?'}, ${fresh.username ?? '?'}) so với kết nối đang dùng (${info.orgId ?? '?'}, ${info.username ?? '?'}). Không gửi tiếp. Chạy lại thao tác này.`), { errorCode: 'ORG_CHANGED' }));
              } else callback(null, fresh.accessToken);
            },
            (err) => callback(err),
          );
        },
      }));
      pending.catch(() => connections.delete(key));
      connections.set(key, pending);
    }
    return { conn: await connections.get(key), info };
  }

  async function call(target, fn) {
    const { conn } = await connectionFor(target);
    try {
      return await fn(conn);
    } catch (e) {
      // Salesforce-side failures are not server bugs: surface them as 502 with the API error code.
      throw Object.assign(new Error(`Salesforce: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`), { status: 502, cause: e });
    }
  }

  return {
    /**
     * Who the org connection really is (review of 0011, S1): Salesforce's identity service through
     * the jsforce connection the writes use (`conn.identity()`), not what the CLI remembers.
     * `refresh`: read the CLI again first (a re-login since the last call is seen).
     * → { orgId, username, userId, instanceUrl, cli: { orgId, username } }
     */
    whoami: async (target, { refresh = false } = {}) => {
      const { conn, info } = await connectionFor(target, { refresh });
      let id;
      try {
        id = await conn.identity();
      } catch (e) {
        throw Object.assign(new Error(`Salesforce: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`), { status: 502, cause: e });
      }
      return {
        orgId: id?.organization_id ?? null,
        username: id?.username ?? null,
        userId: id?.user_id ?? null,
        instanceUrl: info.instanceUrl ?? null,
        cli: { orgId: info.orgId ?? null, username: info.username ?? null },
      };
    },
    describeGlobal: (target) => call(target, (conn) => conn.describeGlobal()),
    describe: (target, sobject) => call(target, (conn) => conn.describe(sobject)),
    /**
     * Create records of one sObject type. Uses sObject Collections (allOrNone=false), so the result
     * has one SaveResult per record: { id, success, errors: [{ statusCode, message, fields }] }.
     * Callers send at most 200 records per call (see server/sf/insert.js).
     */
    /** Cache identity of an org target (server/sf/query.js): instance URL + username from the sf CLI. */
    identity: async (target) => {
      const info = await cli.getConnection(target);
      return `${info.instanceUrl}|${info.username ?? target}`;
    },
    create: (target, sobject, records) => call(target, (conn) => conn.sobject(sobject).create(records, { allOrNone: false })),
    /**
     * Read-only SOQL (Query step, design 0006) through the REST `/query` endpoint: jsforce follows
     * nextRecordsUrl (queryMore) until `maxFetch` rows. Never `scanAll` (that would be queryAll,
     * which also returns deleted records). → { records, totalSize, done }.
     * A query running longer than `timeoutMs` rejects with errorCode QUERY_TIMEOUT; `call` wraps it
     * like every Salesforce error (status 502, `cause`), and server/sf/query.js turns it into a 422
     * issue on the Query step. The timeout does not abort jsforce: pages already requested may
     * still arrive and are dropped.
     */
    query: (target, soql, { maxFetch, timeoutMs } = {}) => call(target, (conn) => withTimeout(
      Promise.resolve(conn.query(soql, { autoFetch: true, maxFetch })),
      timeoutMs,
    )),
    /**
     * Delete records (design 0011, only server/sf/delete.js calls it): sObject Collections DELETE,
     * allOrNone false (Salesforce's default: jsforce only adds the parameter for `true`), at most
     * 200 Ids. Records go to the Recycle Bin. → one SaveResult per Id, in order.
     */
    destroy: (target, sobject, ids) => {
      if (!Array.isArray(ids) || ids.length > MAX_COLLECTION) throw new Error(`destroy: at most ${MAX_COLLECTION} Ids per call.`);
      return call(target, (conn) => conn.sobject(sobject).destroy(ids, { allOrNone: false }));
    },
    /** Org limits (`/limits`, read-only): { DailyApiRequests: { Max, Remaining }, DailyBulkApiBatches, … }. */
    limits: (target) => call(target, (conn) => conn.limits()),
    /**
     * A Bulk API 2.0 ingest job (design 0011). `operation` must be 'insert' or 'delete': anything
     * else (hardDelete, update, upsert…) throws here, before any request. `{ jobId }` instead
     * attaches to an existing job for reading only (check / results). Every method goes through
     * `call` (502 on Salesforce errors, token refresh).
     * → { id, open(), upload(csv), close(), check() → { state, numberRecordsProcessed,
     *     numberRecordsFailed, errorMessage }, abort(), successfulResults() → CSV text,
     *     failedResults() → CSV text }
     * Results are returned as raw CSV: jsforce's own parser splits cells on `;`, `|`, tab… too,
     * which would break values containing them; server/sf/bulk-csv.js parses them.
     */
    bulkJob: (target, { object, operation, jobId } = {}) => {
      const existing = typeof jobId === 'string' && jobId;
      if (!existing && !BULK_OPERATIONS.includes(operation)) {
        throw new Error(`bulkJob: operation "${operation}" is not allowed (only ${BULK_OPERATIONS.join(', ')}).`);
      }
      if (!existing && !(typeof object === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(object))) throw new Error('bulkJob: invalid sObject name.');
      let job = null;
      const withJob = (fn) => call(target, (conn) => {
        job ??= existing
          ? conn.bulk2.job('ingest', { id: jobId })
          : conn.bulk2.createJob({ object, operation, lineEnding: 'LF', columnDelimiter: 'COMMA', contentType: 'CSV' });
        return fn(job);
      });
      const writable = (fn) => (...args) => {
        if (existing) throw new Error('bulkJob: a job attached by id is read-only.');
        return fn(...args);
      };
      return {
        get id() {
          return existing || job?.id || null;
        },
        open: writable(() => withJob((j) => j.open())),
        upload: writable((csv) => withJob((j) => j.uploadData(String(csv)))),
        close: writable(() => withJob((j) => j.close())),
        abort: () => withJob((j) => j.abort()),
        check: () => withJob(async (j) => {
          const info = await j.check();
          return {
            state: info.state,
            numberRecordsProcessed: Number(info.numberRecordsProcessed ?? 0),
            numberRecordsFailed: Number(info.numberRecordsFailed ?? 0),
            errorMessage: info.errorMessage ?? null,
          };
        }),
        successfulResults: () => withJob(async (j) => String((await j.getSuccessfulResults(true)) ?? '')),
        failedResults: () => withJob(async (j) => String((await j.getFailedResults(true)) ?? '')),
      };
    },
  };
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`query took longer than ${ms} ms`), { errorCode: 'QUERY_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
