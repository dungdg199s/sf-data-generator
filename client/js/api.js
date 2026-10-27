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
  run: (workflow, { seed, target } = {}) => call('POST', '/api/run', { workflow, seed, target }),
  orgs: () => call('GET', '/api/orgs'),
  sobjects: (org) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects`),
  describe: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}`),
};
