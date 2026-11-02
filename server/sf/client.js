// Salesforce API access through jsforce. The sf CLI is used only to obtain the access token
// and instance URL (server/sf/cli.js); every API call goes through a jsforce Connection.
//
// One Connection is kept per org target. When Salesforce rejects the token (INVALID_SESSION_ID),
// jsforce calls refreshFn, which asks the sf CLI for a fresh token (`sf org display` refreshes it
// from the CLI's stored auth) and retries the request.
//
// Writes (design 0011): this is the only file that calls jsforce's `create`, `destroy` and `bulk2`;
// server/sf/insert.js and server/sf/delete.js are the only callers of `create`, `destroy` and
// `bulkJob` (test/safety.test.js scans the sources). Bulk jobs only ever `insert` or `delete`:
// never hardDelete (bypasses the Recycle Bin), update or upsert.

import { Connection } from 'jsforce';

/** Bulk API 2.0 operations this app may run. */
export const BULK_OPERATIONS = Object.freeze(['insert', 'delete']);

/** The identity of an org from an `sf org display` result: never the token. */
export const orgIdentity = (info) => ({ username: info?.username ?? null, orgId: info?.orgId ?? null, instanceUrl: info?.instanceUrl ?? null });

export function createSfClient({ cli, createConnection = (options) => new Connection(options) }) {
  // target -> Promise<{ conn, info }>: the Connection and the sf CLI lookup it was built from, so
  // the org a write goes to is always the org the history records (design 0011 review B2).
  const connections = new Map();

  function build(target, info) {
    const conn = createConnection({
      instanceUrl: info.instanceUrl,
      accessToken: info.accessToken,
      version: info.apiVersion,
      refreshFn: (_conn, callback) => {
        cli.getConnection(target, { refresh: true }).then(
          (fresh) => {
            // The alias now names another org (re-login, sandbox refresh): never retry a call
            // built for one org with a token of another.
            const moved = (info.orgId && fresh.orgId && fresh.orgId !== info.orgId)
              || (info.instanceUrl && fresh.instanceUrl && fresh.instanceUrl !== info.instanceUrl);
            if (moved) {
              callback(Object.assign(new Error(`Org "${target}" bây giờ là org khác (${fresh.orgId ?? fresh.instanceUrl}) so với lúc kết nối (${info.orgId ?? info.instanceUrl}). Dừng lại để không ghi nhầm org. Chạy lại thao tác.`), { errorCode: 'ORG_CHANGED' }));
            } else callback(null, fresh.accessToken);
          },
          (err) => callback(err),
        );
      },
    });
    return { conn, info };
  }

  function entryFor(target) {
    if (!connections.has(target)) {
      const pending = cli.getConnection(target).then((info) => build(target, info));
      // Don't cache a failed lookup (e.g. org not logged in yet) — the next call should retry.
      pending.catch(() => connections.delete(target));
      connections.set(target, pending);
    }
    return connections.get(target);
  }

  const connectionFor = async (target) => (await entryFor(target)).conn;

  /**
   * Reads the org again from the sf CLI (`sf org display`, not the 10-minute cache) and rebuilds
   * the Connection from that very lookup. Every insert and delete starts with this, so its writes
   * go where its history says. → { username, orgId, instanceUrl } (no token)
   */
  async function refreshOrg(target) {
    const info = await cli.getConnection(target, { refresh: true });
    connections.set(target, Promise.resolve(build(target, info)));
    return orgIdentity(info);
  }

  async function call(target, fn) {
    const conn = await connectionFor(target);
    try {
      return await fn(conn);
    } catch (e) {
      // Salesforce-side failures are not server bugs: surface them as 502 with the API error code.
      throw Object.assign(new Error(`Salesforce: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`), { status: 502, cause: e });
    }
  }

  /**
   * A Bulk API 2.0 ingest job. `operation` must be 'insert' or 'delete' (anything else throws
   * before any request). New job: { object, operation }; existing job (read its results): { id, operation }.
   * Every call goes through `call` (Salesforce errors → 502 with `cause`, refreshFn on an expired token).
   */
  function bulkJob(target, { object, operation, id } = {}) {
    if (!BULK_OPERATIONS.includes(operation)) {
      throw Object.assign(new Error(`Bulk API: thao tác "${operation}" không được phép (chỉ insert hoặc delete).`), { status: 500 });
    }
    let job = null;
    const jobOf = (conn) => {
      if (!job) {
        job = id
          ? conn.bulk2.job('ingest', { id })
          : conn.bulk2.createJob({ object, operation, lineEnding: 'LF', columnDelimiter: 'COMMA' });
      }
      return job;
    };
    const run = (fn) => call(target, (conn) => fn(jobOf(conn)));
    return {
      get id() {
        return job?.id ?? id ?? null;
      },
      open: () => {
        if (id) throw new Error('Job đã có, không mở lại được.');
        return run((j) => j.open());
      },
      upload: (csv) => run((j) => j.uploadData(String(csv))),
      close: () => run((j) => j.close()),
      check: () => run((j) => j.check()),
      abort: () => run((j) => j.abort()),
      successfulResults: () => run((j) => j.getSuccessfulResults()),
      failedResults: () => run((j) => j.getFailedResults()),
    };
  }

  return {
    connection: connectionFor,
    refreshOrg,
    /** Identity of the org the cached Connection of `target` writes to (no token). */
    orgOf: async (target) => orgIdentity((await entryFor(target)).info),
    describeGlobal: (target) => call(target, (conn) => conn.describeGlobal()),
    describe: (target, sobject) => call(target, (conn) => conn.describe(sobject)),
    /** Cache identity of an org target (server/sf/query.js): instance URL + username from the sf CLI. */
    identity: async (target) => {
      const info = await cli.getConnection(target);
      return `${info.instanceUrl}|${info.username ?? target}`;
    },
    /**
     * Create records of one sObject type. Uses sObject Collections (allOrNone=false), so the result
     * has one SaveResult per record: { id, success, errors: [{ statusCode, message, fields }] }.
     * Callers send at most 200 records per call (see server/sf/insert.js).
     */
    create: (target, sobject, records) => call(target, (conn) => conn.sobject(sobject).create(records, { allOrNone: false })),
    /**
     * Deletes records by Id (sObject Collections `DELETE /composite/sobjects?ids=…`, at most 200 Ids;
     * allOrNone false, Salesforce's default: jsforce only adds the parameter when it is true). One
     * result per Id, in order: { id, success, errors }. Deleted records go to the Recycle Bin.
     */
    destroy: (target, sobject, ids) => {
      if (!Array.isArray(ids) || ids.length > 200) throw Object.assign(new Error('Xóa tối đa 200 Id mỗi lời gọi.'), { status: 500 });
      return call(target, (conn) => conn.sobject(sobject).destroy(ids, { allOrNone: false }));
    },
    bulkJob,
    /** Org limits (`GET /limits`, read only): { DailyApiRequests: { Max, Remaining }, DailyBulkApiBatches: { … }, … }. */
    limits: (target) => call(target, (conn) => conn.limits()),
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
