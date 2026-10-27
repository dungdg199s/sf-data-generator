// Minimal Salesforce REST client on top of global fetch. Retries once with a fresh
// token from the sf CLI when the cached one is rejected (401).

export function createSfClient({ cli, fetchImpl = globalThis.fetch }) {
  async function request(target, method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await cli.getConnection(target, { refresh: attempt > 0 });
      const res = await fetchImpl(`${conn.instanceUrl}/services/data/v${conn.apiVersion}${path}`, {
        method,
        headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const msg = Array.isArray(data) ? data.map((d) => d.message).join('; ') : data?.message || res.statusText;
        throw new Error(`Salesforce ${res.status}: ${msg}`);
      }
      return data;
    }
    throw new Error('Salesforce từ chối token. Chạy lại: sf org login web');
  }

  return {
    describeGlobal: (target) => request(target, 'GET', '/sobjects/'),
    describe: (target, sobject) => request(target, 'GET', `/sobjects/${encodeURIComponent(sobject)}/describe/`),
    /** sObject Collections create, up to 200 records, allOrNone=false (per-record results). */
    createCollection: (target, records) => request(target, 'POST', '/composite/sobjects', { allOrNone: false, records }),
  };
}
