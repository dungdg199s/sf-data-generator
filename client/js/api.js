// Thin fetch wrappers. Errors carry `issues` (workflow validation) when the server sends them.

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, issues: data.issues });
  return data;
}

export const api = {
  meta: () => call('GET', '/api/meta'),
  validate: (workflow) => call('POST', '/api/validate', { workflow }),
  /**
   * org: the org Query steps read for a preview (none → sample rows); refreshQueries: bypass the
   * server's query cache; expectQueries: fingerprints of the preview an insert must match (409).
   */
  run: (workflow, { seed, target, org, refreshQueries, expectQueries } = {}) => call('POST', '/api/run', { workflow, seed, target, org, refreshQueries, expectQueries }),
  orgs: () => call('GET', '/api/orgs'),
  /** purpose 'query': objects a Query can read; default: objects a Record can create. */
  sobjects: (org, { purpose } = {}) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects${purpose === 'query' ? '?for=query' : ''}`),
  describe: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}`),
  /** Every field of an sObject (Query "Chọn field…"). */
  fields: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}/fields`),
};
