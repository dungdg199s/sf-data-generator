// Salesforce API access through jsforce. The sf CLI is used only to obtain the access token
// and instance URL (server/sf/cli.js); every API call goes through a jsforce Connection.
//
// One Connection is kept per org target. When Salesforce rejects the token (INVALID_SESSION_ID),
// jsforce calls refreshFn, which asks the sf CLI for a fresh token (`sf org display` refreshes it
// from the CLI's stored auth) and retries the request.

import { Connection } from 'jsforce';

export function createSfClient({ cli, createConnection = (options) => new Connection(options) }) {
  const connections = new Map(); // target -> Promise<Connection>

  function connectionFor(target) {
    if (!connections.has(target)) {
      const pending = cli.getConnection(target).then((info) =>
        createConnection({
          instanceUrl: info.instanceUrl,
          accessToken: info.accessToken,
          version: info.apiVersion,
          refreshFn: (_conn, callback) => {
            cli.getConnection(target, { refresh: true }).then(
              (fresh) => callback(null, fresh.accessToken),
              (err) => callback(err),
            );
          },
        }),
      );
      // Don't cache a failed lookup (e.g. org not logged in yet) — the next call should retry.
      pending.catch(() => connections.delete(target));
      connections.set(target, pending);
    }
    return connections.get(target);
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

  return {
    connection: connectionFor,
    describeGlobal: (target) => call(target, (conn) => conn.describeGlobal()),
    describe: (target, sobject) => call(target, (conn) => conn.describe(sobject)),
    /**
     * Create records of one sObject type. Uses sObject Collections (allOrNone=false), so the result
     * has one SaveResult per record: { id, success, errors: [{ statusCode, message, fields }] }.
     * Callers send at most 200 records per call (see server/sf/insert.js).
     */
    create: (target, sobject, records) => call(target, (conn) => conn.sobject(sobject).create(records, { allOrNone: false })),
  };
}
