// Thin fetch wrappers. Errors carry `issues` (workflow validation) when the server sends them.
// Runs stream NDJSON events (design 0004): `runStream` reads them as they arrive.

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, issues: data.issues, body: data });
  return data;
}

/** `body`: the whole JSON error (a delete's 409 carries the new `count` and `collected`). */
async function errorOf(res) {
  const data = await res.json().catch(() => ({}));
  return Object.assign(new Error(data.error || res.statusText), { status: res.status, issues: data.issues, body: data });
}

/**
 * POST /api/run as a stream of events (start, progress, plan, done, error), one JSON per line.
 * Validation (422), changed org data (409) and Salesforce errors (502) arrive as plain JSON
 * before the stream and are thrown like `call` does. → the `done` result; an `error` event is
 * thrown with `issues` and `insert` (what was written before it). A connection lost mid-run
 * throws with `lost: true`.
 */
async function runStream(body, { onEvent, onResponse, signal, path = '/api/run' } = {}) {
  const res = await fetch(path, {
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

const limitsCache = new Map(); // org → { at, value }

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
  /**
   * Stops a run after the Salesforce call in flight (404 once it is over). force (Dừng ngay, design
   * 0011): also aborts the Bulk job being processed.
   */
  cancelRun: (runId, { force = false } = {}) => call('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, force ? { force: true } : {}),
  /** Insert history (design 0011): { enabled, reason?, dir, maxRuns, runs, prune }. */
  history: () => call('GET', '/api/history'),
  /** One entry (no workflow) + remaining, pendingBulkJobs, active?. */
  historyEntry: (hid) => call('GET', `/api/history/${encodeURIComponent(hid)}`),
  /** Removes the entry from history (nothing in the org). */
  forgetHistory: (hid) => call('POST', `/api/history/${encodeURIComponent(hid)}/forget`, {}),
  /** CSV of every Id of an insert (a plain link: the server names the file). */
  idsCsvUrl: (hid) => `/api/history/${encodeURIComponent(hid)}/ids.csv`,
  /**
   * Deletes the records of an insert, streamed like runStream: body { confirm: { username, count,
   * typedOrg? }, bulk }. Refusals (400/404/409/502/503) are thrown before the stream, with `body`.
   */
  deleteStream: (hid, body, opts = {}) => runStream(body, { ...opts, path: `/api/history/${encodeURIComponent(hid)}/delete` }),
  /** API limits of the org (≤ 3 s, cached 60 s here and on the server); null when unknown. */
  limits: async (org) => {
    const hit = limitsCache.get(org);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(org)}/limits`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const value = await res.json();
      limitsCache.set(org, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
  /** Regenerates the run on the server (same seed + now) → { blob, filename }. */
  exportFile: async (body) => {
    const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await errorOf(res);
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
    return { blob: await res.blob(), filename };
  },
  /**
   * Values of one field for the inspector (design 0012 E): body { sobject, fields, index, seed, now,
   * count } → { values }. A 422 throws with the server's message (and `issues`).
   */
  fieldSamples: async (body, { signal } = {}) => {
    const res = await fetch('/api/field-samples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw await errorOf(res);
    return res.json();
  },
  orgs: () => call('GET', '/api/orgs'),
  /** purpose 'query': objects a Query can read; default: objects a Record can create. */
  sobjects: (org, { purpose } = {}) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects${purpose === 'query' ? '?for=query' : ''}`),
  describe: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}`),
  /** Every field of an sObject (Query "Chọn field…"). */
  fields: (org, name) => call('GET', `/api/orgs/${encodeURIComponent(org)}/sobjects/${encodeURIComponent(name)}/fields`),
};
