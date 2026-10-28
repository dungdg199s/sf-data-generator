// Thin fetch wrappers. Errors carry `issues` (workflow validation) when the server sends them.
// Runs stream NDJSON events (design 0004): `runStream` reads them as they arrive.

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

async function errorOf(res) {
  const data = await res.json().catch(() => ({}));
  return Object.assign(new Error(data.error || res.statusText), { status: res.status, issues: data.issues });
}

/**
 * POST /api/run as a stream of events (start, progress, plan, done, error), one JSON per line.
 * Validation (422), changed org data (409) and Salesforce errors (502) arrive as plain JSON
 * before the stream and are thrown like `call` does. → the `done` result; an `error` event is
 * thrown with `issues` and `insert` (what was written before it). A connection lost mid-run
 * throws with `lost: true`.
 */
async function runStream(body, { onEvent, onResponse, signal } = {}) {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorOf(res);
  onResponse?.(); // the run has started on the server: stop it by id from now on
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    last = ev;
    onEvent?.(ev);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    handle(buf + decoder.decode());
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error('Mất kết nối với server.'), { lost: true, last });
  }
  if (last?.type === 'done') return last.result;
  if (last?.type === 'error') throw Object.assign(new Error(last.error), { issues: last.issues, insert: last.insert, runError: true });
  throw Object.assign(new Error('Mất kết nối với server.'), { lost: true, last });
}

export const api = {
  meta: () => call('GET', '/api/meta'),
  validate: (workflow) => call('POST', '/api/validate', { workflow }),
  /**
   * org: the org Query steps read for a preview (none → sample rows); refreshQueries: bypass the
   * server's query cache; expectQueries: fingerprints of the preview an insert must match (409).
   */
  run: (workflow, { seed, target, org, refreshQueries, expectQueries } = {}) => call('POST', '/api/run', { workflow, seed, target, org, refreshQueries, expectQueries }),
  /** Streaming run (design 0004): body { workflow, seed, now?, target?, org?, refreshQueries?, expectQueries? }. */
  runStream,
  /** Stops a run after the Salesforce call in flight (404 once it is over). */
  cancelRun: (runId) => call('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, {}),
  /** Regenerates the run on the server (same seed + now) → { blob, filename }. */
  exportFile: async (body) => {
    const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await errorOf(res);
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
    return { blob: await res.blob(), filename };
  },
  orgs: () => call('GET', '/api/orgs'),
  /** purpose 'query': objects a Query can read; default: objects a Record can create. */
  sobjects: (org, { purpose } = {}) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects${purpose === 'query' ? '?for=query' : ''}`),
  describe: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}`),
  /** Every field of an sObject (Query "Chọn field…"). */
  fields: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}/fields`),
};
