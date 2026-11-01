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

const ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** The error of a write whose connection now points at another org (review 2 of 0011, item 1). */
export function orgChangedError(message, cause) {
  return Object.assign(new Error(message), { status: 409, code: 'ORG_CHANGED', cause });
}
export const isOrgChanged = (e) => e?.code === 'ORG_CHANGED' || e?.cause?.code === 'ORG_CHANGED' || e?.cause?.errorCode === 'ORG_CHANGED';

export function createSfClient({ cli, createConnection = (options) => new Connection(options) }) {
  // Connections are keyed by who the CLI says the target is (instance URL + username + org Id), so
  // an alias re-pointed at another org (re-login after a sandbox refresh) gets a new connection
  // instead of writing with the old one (review of 0011, S1).
  const connections = new Map(); // identity key -> Promise<{ conn, expected }>
  const sessions = new WeakMap(); // session (from whoami) -> { conn, expected, revoked }
  const keyOf = (info) => `${info.instanceUrl}|${info.username ?? ''}|${info.orgId ?? ''}`;

  async function connectionFor(target, { refresh = false } = {}) {
    const info = refresh ? await cli.getConnection(target, { refresh: true }) : await cli.getConnection(target);
    const key = keyOf(info);
    if (!connections.has(key)) {
      // Who this connection must stay: the CLI's word first, Salesforce's once whoami asked.
      const expected = { orgId: info.orgId ?? null, username: info.username ?? null };
      const pending = Promise.resolve().then(() => ({
        expected,
        conn: createConnection({
          instanceUrl: info.instanceUrl,
          accessToken: info.accessToken,
          version: info.apiVersion,
          refreshFn: (_conn, callback) => {
            cli.getConnection(target, { refresh: true }).then(
              (fresh) => {
                // Fail closed (review 2, item 1): a fresh token whose org is unknown, or another org
                // or user, is never used by this connection.
                if (!fresh?.orgId || (expected.orgId && fresh.orgId !== expected.orgId) || (expected.username && fresh.username !== expected.username)) {
                  // jsforce rewraps this error ("Unable to refresh session…"), so the refusal is also
                  // remembered on the connection for `call` to recognise; the connection is dropped.
                  expected.refused = `Org "${target}" bây giờ là org khác (${fresh?.orgId ?? 'không rõ org Id'}, ${fresh?.username ?? '?'}) so với kết nối đang dùng (${expected.orgId ?? '?'}, ${expected.username ?? '?'}). Không gửi tiếp. Chạy lại thao tác này.`;
                  connections.delete(key);
                  callback(Object.assign(new Error(expected.refused), { errorCode: 'ORG_CHANGED', code: 'ORG_CHANGED' }));
                } else callback(null, fresh.accessToken);
              },
              (err) => callback(err),
            );
          },
        }),
      }));
      pending.catch(() => connections.delete(key));
      connections.set(key, pending);
    }
    const { conn, expected } = await connections.get(key);
    return { conn, expected, info };
  }

  /**
   * `target` is an alias / username, or a session from whoami: a session is pinned to the very
   * connection whoami checked, so every write goes to that org even if the alias is re-pointed
   * meanwhile; once a refresh is refused the session is dead (ORG_CHANGED, 409).
   */
  async function call(target, fn) {
    let conn;
    let expected;
    let state = null;
    if (target && typeof target === 'object') {
      state = sessions.get(target);
      if (!state) throw new Error('Phiên kết nối org không hợp lệ.');
      if (state.revoked) throw orgChangedError(state.revoked);
      ({ conn, expected } = state);
    } else ({ conn, expected } = await connectionFor(target));
    try {
      if (expected?.refused) throw orgChangedError(expected.refused);
      return await fn(conn);
    } catch (e) {
      if (isOrgChanged(e) || expected?.refused) {
        const message = expected?.refused ?? e.message;
        if (state) state.revoked = message;
        throw orgChangedError(message, e);
      }
      // Salesforce-side failures are not server bugs: surface them as 502 with the API error code.
      throw Object.assign(new Error(`Salesforce: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`), { status: 502, cause: e });
    }
  }

  const wrap = (e) => Object.assign(new Error(`Salesforce: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`), { status: 502, cause: e });

  return {
    /**
     * Who the org connection really is, asked through the connection that will write (review of
     * 0011, S1; review 2, item 9): the REST root's `identity` URL gives the org and user Ids (parsed,
     * never fetched: it points at login.salesforce.com and would carry the token), and the username
     * comes from `SELECT Username FROM User WHERE Id = …` on the instance.
     * `refresh`: read the CLI again first (a re-login since the last call is seen).
     * → { orgId, username, userId, instanceUrl, cli: { orgId, username }, session }
     *   session: pass it instead of the alias to create / destroy / bulkJob to pin the writes.
     */
    whoami: async (target, { refresh = false } = {}) => {
      const { conn, expected, info } = await connectionFor(target, { refresh });
      let orgId;
      let userId;
      let username;
      try {
        const root = await conn.request(`/services/data/v${conn.version}`);
        const m = String(root?.identity ?? '').match(/\/id\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/?$/);
        if (!m || !ORG_ID.test(m[1]) || !USER_ID.test(m[2])) throw new Error('Salesforce không trả identity (org Id, user Id) của kết nối.');
        [, orgId, userId] = m;
        const r = await conn.query(`SELECT Username FROM User WHERE Id = '${userId}'`);
        username = r?.records?.[0]?.Username ?? null;
      } catch (e) {
        throw wrap(e);
      }
      if (!username) throw wrap(new Error('Salesforce không trả username của kết nối.'));
      // From now on the connection's refresh must keep exactly this org and user.
      expected.orgId = orgId;
      expected.username = username;
      const session = Object.freeze({ target, orgId, username, userId, instanceUrl: info.instanceUrl ?? null });
      sessions.set(session, { conn, expected, revoked: null });
      return { orgId, username, userId, instanceUrl: info.instanceUrl ?? null, cli: { orgId: info.orgId ?? null, username: info.username ?? null }, session };
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
     * attaches to an existing job for reading only (check / results; open, upload, close and abort
     * throw). `open()` resolves with the job info Salesforce returns. Every method goes through
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
        abort: writable(() => withJob((j) => j.abort())),
        check: () => withJob(async (j) => {
          const info = await j.check();
          return {
            state: info.state,
            numberRecordsProcessed: Number(info.numberRecordsProcessed ?? 0),
            numberRecordsFailed: Number(info.numberRecordsFailed ?? 0),
            errorMessage: info.errorMessage ?? null,
            // What the job is and who made it (an attached job is checked before its Ids are used).
            operation: info.operation ?? null,
            object: info.object ?? null,
            createdById: info.createdById ?? null,
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
