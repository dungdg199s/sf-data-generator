// Waiting for a Bulk API 2.0 job (design 0011 §2–3), shared by server/sf/insert.js and
// server/sf/delete.js. It only uses a job handle it is given (client.bulkJob is called in those two
// files only): check() with a back-off (2 s × 1.5 up to 15 s; not jsforce's job.poll(), whose 30 s
// default timeout is far too short), at most `timeoutMs`. `forceSignal` (Dừng ngay) aborts the job
// once and keeps checking until Salesforce reports it Aborted (or finished anyway).

export const POLL_START_MS = 2000;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 15000;
const TERMINAL = new Set(['JobComplete', 'Failed', 'Aborted']);

/** setTimeout that an AbortSignal cuts short (Dừng ngay must not wait out a 15 s back-off). */
export function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * → { state, info, timedOut, forced }  info: last check() answer
 */
export async function waitForJob(handle, {
  sleep = defaultSleep, clock = () => Date.now(), timeoutMs, forceSignal, onCheck,
  pollStart = POLL_START_MS, pollFactor = POLL_FACTOR, pollMax = POLL_MAX_MS,
} = {}) {
  const started = clock();
  let delay = pollStart;
  let forced = false;
  let info = { state: 'UploadComplete', numberRecordsProcessed: 0, numberRecordsFailed: 0, errorMessage: null };
  for (;;) {
    if (forceSignal?.aborted && !forced) {
      forced = true;
      try {
        await handle.abort();
      } catch {
        // The job may have finished meanwhile; the next check says so.
      }
    }
    await sleep(forced ? Math.min(pollStart, delay) : delay, forced ? undefined : forceSignal);
    info = await handle.check();
    onCheck?.(info);
    if (TERMINAL.has(info.state)) return { state: info.state, info, timedOut: false, forced };
    if (forceSignal?.aborted && !forced) continue;
    if (timeoutMs && clock() - started >= timeoutMs) return { state: info.state, info, timedOut: true, forced };
    delay = Math.min(delay * pollFactor, pollMax);
  }
}
