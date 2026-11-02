// Insert history (design 0011): files on the machine that runs the server, so the app can list
// its inserts, hand out the Ids it created and delete exactly those (and nothing else) later.
//
// Where: <dataDir>/history/, dataDir = $SFDG_DATA_DIR, else per OS (Linux $XDG_DATA_HOME or
// ~/.local/share, macOS ~/Library/Application Support, Windows %APPDATA%) + /sf-data-generator.
// Directories are created 0700, files 0600; a symlinked or foreign-owned directory or file is never
// used, and `<dir>/.lock` (pid) keeps a second server off the same directory. A directory that
// cannot be used turns the history off (`enabled: false`, `reason`): previews still work, inserts
// are refused (nothing could be deleted again through the app). Pruning removes only runs with
// nothing left in the org; when only runs with records would have to go, a new insert is refused
// (`code: 'HISTORY_FULL'`) instead of silently forgetting Ids.
//
//   <hid>.json          the run (rewritten whole: temp file + rename)
//   <hid>.ids.csv       Ids inserted, append only: sobject,step,ref,id
//   <hid>.deleted.csv   delete outcomes, append only: id,outcome (deleted | gone)
//
// Never stored: access / refresh tokens, passwords, Authorization headers, Query rows (they can
// be real org data). The org is { alias, username, orgId, instanceUrl, kind } only.
// Time is the server's Date.now() (injectable for tests): determinism is a rule of generators and
// the executor only.

import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, appendFile, rename, rm, stat, lstat, chmod, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { LIMITS } from './workflow/nodes.js';

export const HID = /^h\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const IDS_HEADER = 'sobject,step,ref,id\n';
const DELETED_HEADER = 'id,outcome\n';
const ORG_KEYS = ['alias', 'username', 'orgId', 'instanceUrl', 'kind'];

/** The per-OS data directory of the app (SFDG_DATA_DIR wins). */
export function dataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.SFDG_DATA_DIR) return path.resolve(env.SFDG_DATA_DIR);
  // Safety net: a test (node --test sets NODE_TEST_CONTEXT) never writes into the user's data dir.
  if (env.NODE_TEST_CONTEXT) throw new Error('Tests must set SFDG_DATA_DIR (test/data-dir.js) instead of using the real data directory.');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'sf-data-generator');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sf-data-generator');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'sf-data-generator');
}

/** CSV cell (history files hold Ids, aliases and step ids; quoted when needed). */
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (no line break inside a cell in these files) → cells. */
function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const IS_WIN = process.platform === 'win32';

/**
 * Review nit: history files and the directory are never followed through a symlink nor read when
 * another user owns them (lstat, uid). → false when `p` does not exist; throws when it is unsafe.
 */
export async function checkOwned(p, { directory = false } = {}) {
  let st;
  try {
    st = await lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const what = directory ? 'thư mục' : 'file';
  if (st.isSymbolicLink()) throw new Error(`${what} ${p} là symlink; app không dùng symlink cho Lịch sử`);
  if (directory ? !st.isDirectory() : !st.isFile()) throw new Error(`${p} không phải ${what}`);
  if (!IS_WIN && typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${what} ${p} thuộc user khác (uid ${st.uid}); app chỉ dùng ${what} của chính user chạy server`);
  }
  return true;
}

/** Lines of a file after its header (none when the file does not exist). */
async function* lines(file) {
  if (!(await checkOwned(file))) return;
  let stream;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    if (line) yield splitLine(line);
  }
}

// One lock per history directory and process (review nit): `<dir>/.lock` holds the pid, so two
// servers on one data directory do not break each other's running / deleting state.
const heldLocks = new Set();
let exitHook = false;
function releaseLocksOnExit() {
  if (exitHook) return;
  exitHook = true;
  process.once('exit', () => {
    for (const f of heldLocks) {
      try {
        if (readFileSync(f, 'utf8').trim() === String(process.pid)) unlinkSync(f);
      } catch {
        // already gone
      }
    }
  });
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const compactIso = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * @param dir       the history directory (<dataDir>/history)
 * @param clock     () → ms (Date.now)
 * @param maxRuns / maxBytes  LIMITS.historyMaxRuns / historyMaxBytes
 */
export function createHistory({ dir = path.join(dataDir(), 'history'), clock = () => Date.now(), maxRuns = LIMITS.historyMaxRuns, maxBytes = LIMITS.historyMaxBytes, random = () => randomBytes(3).toString('hex') } = {}) {
  const state = { enabled: false, reason: null };
  const inserting = new Set(); // hids of inserts running in this process
  const deleting = new Set(); // hids being deleted
  const queues = new Map(); // hid → tail of its write queue (writes of one run never interleave)

  const file = (hid, ext) => {
    if (!HID.test(hid)) throw Object.assign(new Error('bad history id'), { status: 404 });
    return path.join(dir, `${hid}${ext}`);
  };

  /** Runs `fn` after the previous write of `hid`; → its result. */
  function queued(hid, fn) {
    const prev = queues.get(hid) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(hid, next.catch(() => {}));
    return next;
  }

  async function writeJson(hid, data) {
    const target = file(hid, '.json');
    const tmp = `${target}.${random()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
    await rename(tmp, target);
  }

  async function readJson(hid) {
    try {
      const f = file(hid, '.json');
      if (!(await checkOwned(f))) return null;
      return JSON.parse(await readFile(f, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Appends to a history file that is missing or a regular file of this user (never a symlink). */
  async function appendSafe(f, text) {
    await checkOwned(f);
    await appendFile(f, text, { mode: 0o600 });
  }

  async function takeLock() {
    const lock = path.join(dir, '.lock');
    try {
      await writeFile(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await checkOwned(lock);
      const pid = Number((await readFile(lock, 'utf8')).trim());
      if (pid && pid !== process.pid && alive(pid)) {
        throw new Error(`thư mục Lịch sử ${dir} đang được một server khác dùng (pid ${pid}). Dừng server đó, hoặc đặt SFDG_DATA_DIR khác cho server này`);
      }
      await writeFile(lock, String(process.pid), { mode: 0o600 }); // ours already, or a stale lock
    }
    heldLocks.add(lock);
    releaseLocksOnExit();
  }

  const ready = (async () => {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await checkOwned(dir, { directory: true });
      if (!IS_WIN) await chmod(dir, 0o700);
      const probe = path.join(dir, `.probe-${random()}`);
      await writeFile(probe, '', { mode: 0o600, flag: 'wx' });
      await unlink(probe);
      await takeLock();
      state.enabled = true;
    } catch (e) {
      state.enabled = false;
      state.reason = e.message;
      return;
    }
    // Inserts that were running when the server stopped: interrupted, with the Ids written so far.
    for (const name of await readdir(dir)) {
      const m = /^(h\d{8}T\d{6}Z-[0-9a-f]{6})\.json$/.exec(name);
      if (!m) continue;
      const data = await readJson(m[1]);
      if (data?.status !== 'running' && data?.deletion?.status !== 'running') continue;
      if (data.status === 'running') {
        data.status = 'interrupted';
        // The counts of the json lag behind the Ids file: recount (total and per step).
        const perStep = new Map();
        let total = 0;
        for await (const [, step] of lines(file(m[1], '.ids.csv'))) {
          total++;
          perStep.set(step, (perStep.get(step) ?? 0) + 1);
        }
        data.inserted = total;
        data.steps = (data.steps ?? []).map((st) => ({ ...st, inserted: perStep.get(st.nodeId) ?? 0 }));
      }
      if (data.deletion?.status === 'running') data.deletion.status = 'interrupted';
      await writeJson(m[1], data).catch(() => {});
    }
    // Temp files of a write cut short.
    for (const name of await readdir(dir)) if (name.endsWith('.tmp')) await rm(path.join(dir, name), { force: true });
  })();

  async function allRuns() {
    await ready;
    if (!state.enabled) return [];
    const out = [];
    for (const name of await readdir(dir)) {
      const m = /^(h\d{8}T\d{6}Z-[0-9a-f]{6})\.json$/.exec(name);
      if (!m) continue;
      const data = await readJson(m[1]);
      if (data) out.push(data);
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || String(b.id).localeCompare(String(a.id)));
  }

  const isRunning = (run) => inserting.has(run.id) || deleting.has(run.id);
  /** Inserted records still in the org, from the counters (the files are the truth: see remaining). */
  const leftOf = (run) => Math.max(0, (run.inserted ?? 0) - (run.deletion?.deleted ?? 0) - (run.deletion?.gone ?? 0));
  /** Bulk insert jobs whose Ids were never read: the run may still have records (review S3/S4). */
  const unreadJobs = (run) => (run.bulkJobs ?? []).filter((j) => j?.jobId && !j.idsCollected && !j.neverProcessed);
  const hasRecords = (run) => leftOf(run) > 0 || unreadJobs(run).length > 0;

  async function folderBytes() {
    let n = 0;
    for (const name of await readdir(dir)) n += (await stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size;
    return n;
  }

  /**
   * Room for one more run (review S4): only runs with nothing left in the org (deleted, or no
   * record ever inserted) are removed, oldest first, never a running one. → { full, runs, bytes }
   * after that; with `apply: false` nothing is removed (the Insert confirmation asks first).
   */
  async function makeRoom({ apply }) {
    const runs = (await allRuns()).reverse(); // oldest first
    let count = runs.length;
    let bytes = await folderBytes();
    for (const r of runs) {
      if (count < maxRuns && bytes < maxBytes) break;
      if (isRunning(r) || hasRecords(r)) continue;
      const own = await runBytes(r.id);
      if (apply) await removeFiles(r.id);
      bytes -= own;
      count--;
    }
    return { full: count >= maxRuns || bytes >= maxBytes, runs: count, bytes };
  }

  async function runBytes(hid) {
    let n = 0;
    for (const ext of ['.json', '.ids.csv', '.deleted.csv']) n += (await stat(file(hid, ext)).catch(() => ({ size: 0 }))).size;
    return n;
  }

  const fullMessage = () => `Lịch sử đã đủ ${maxRuns} lần insert còn bản ghi trong org (hoặc ${Math.round(maxBytes / 1048576)} MB), nên chưa ghi gì vào org: app không tự quên một lần insert còn bản ghi. Mở Lịch sử, bấm "Xóa khỏi org…" hoặc "Quên lần insert này" ở các lần cũ rồi insert lại.`;

  async function removeFiles(hid) {
    for (const ext of ['.json', '.ids.csv', '.deleted.csv']) await rm(file(hid, ext), { force: true });
  }

  /** A handle to write one run (insert or delete): appends and json updates, queued. */
  function handle(hid, data) {
    return {
      id: hid,
      data,
      /** Inserted Ids: [{ sobject, step, ref, id }] — awaited before the next write to the org. */
      appendIds: (rows) => queued(hid, () => appendSafe(file(hid, '.ids.csv'), rows.map((r) => `${cell(r.sobject)},${cell(r.step)},${cell(r.ref)},${cell(r.id)}\n`).join(''))),
      /** Delete outcomes: [{ id, outcome: 'deleted' | 'gone' }]. */
      appendDeleted: (rows) => queued(hid, async () => {
        const f = file(hid, '.deleted.csv');
        const exists = await checkOwned(f);
        await appendSafe(f, `${exists ? '' : DELETED_HEADER}${rows.map((r) => `${cell(r.id)},${cell(r.outcome)}\n`).join('')}`);
      }),
      /** Merges `patch` into the json and rewrites it. */
      save: (patch = {}) => queued(hid, async () => {
        // Written first, applied after: a failed write leaves the run as it was (review nit).
        await writeJson(hid, { ...data, ...patch });
        Object.assign(data, patch);
      }),
    };
  }

  return {
    ready,
    get enabled() {
      return state.enabled;
    },
    get reason() {
      return state.reason;
    },
    dir,
    maxRuns,
    inserting,
    deleting,
    isValidId: (hid) => typeof hid === 'string' && HID.test(hid),

    /**
     * New run, just before the first write to the org. Throws when the history is off or the
     * files cannot be written (the caller then writes nothing).
     */
    async create({ org, workflow, seed, now, bulk, steps, total, warnings = [] }) {
      await ready;
      if (!state.enabled) throw new Error(state.reason ?? 'Lịch sử đang tắt');
      if ((await makeRoom({ apply: true })).full) throw Object.assign(new Error(fullMessage()), { code: 'HISTORY_FULL' });
      const t = clock();
      let hid;
      do hid = `h${compactIso(t)}-${random()}`; while (await stat(file(hid, '.json')).then(() => true, () => false));
      const safeOrg = Object.fromEntries(ORG_KEYS.map((k) => [k, org?.[k] ?? null]));
      const data = {
        version: 1,
        id: hid,
        status: 'running',
        startedAt: new Date(t).toISOString(),
        finishedAt: null,
        org: safeOrg,
        workflow: workflow ? structuredClone(workflow) : null,
        seed,
        now,
        bulk,
        steps: steps.map((s) => ({ nodeId: s.nodeId, alias: s.alias, sobject: s.sobject, mode: s.mode, total: s.records ?? s.total ?? 0, inserted: 0, failed: 0 })),
        total,
        inserted: 0,
        failed: 0,
        notSent: 0,
        bulkJobs: [],
        errorGroups: [],
        errorGroupsOther: null,
        stopped: null,
        warnings,
        deletion: { status: 'none', deleted: 0, gone: 0, failed: 0, lastAt: null, errorGroups: [] },
      };
      inserting.add(hid);
      try {
        await writeFile(file(hid, '.ids.csv'), IDS_HEADER, { mode: 0o600 });
        await writeJson(hid, data);
      } catch (e) {
        inserting.delete(hid);
        await removeFiles(hid).catch(() => {});
        throw e;
      }
      const h = handle(hid, data);
      return {
        ...h,
        /** Bulk job log entry (created before its upload, updated when it ends). */
        recordJob: (entry) => {
          const list = data.bulkJobs;
          const at = list.findIndex((j) => j.jobId === entry.jobId);
          const copy = { ...entry };
          if (at >= 0) list[at] = copy;
          else list.push(copy);
          return h.save();
        },
        /** End of the insert: final counts and status; the run is no longer "running". */
        finish: async (patch) => {
          try {
            await h.save({ ...patch, finishedAt: new Date(clock()).toISOString() });
          } finally {
            inserting.delete(hid);
          }
        },
      };
    },

    /**
     * Cheap state for the Insert confirmation: on/off, and whether a new run would be refused
     * because only runs with records left would have to be forgotten.
     */
    async status() {
      await ready;
      if (!state.enabled) return { enabled: false, reason: state.reason, dir, maxRuns };
      const room = await makeRoom({ apply: false });
      return { enabled: true, dir, maxRuns, full: room.full, ...(room.full ? { fullMessage: fullMessage() } : {}) };
    },

    /** Handle of an existing run (delete), or null. */
    async open(hid) {
      await ready;
      if (!state.enabled || !HID.test(hid)) return null;
      const data = await readJson(hid);
      return data ? handle(hid, data) : null;
    },

    /** Summaries, newest first. */
    async list() {
      return (await allRuns()).map((r) => {
        const bySobject = {};
        for (const s of r.steps ?? []) bySobject[s.sobject] = (bySobject[s.sobject] ?? 0) + (s.inserted ?? 0);
        return {
          id: r.id,
          status: inserting.has(r.id) ? 'running' : r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          org: r.org,
          workflowName: r.workflow?.name ?? '',
          seed: r.seed,
          total: r.total,
          inserted: r.inserted,
          failed: r.failed,
          notSent: r.notSent,
          bySobject,
          steps: (r.steps ?? []).map(({ nodeId, alias, sobject, mode, total, inserted, failed }) => ({ nodeId, alias, sobject, mode, total, inserted, failed })),
          bulkJobs: (r.bulkJobs ?? []).length,
          stopped: r.stopped,
          deletion: { status: deleting.has(r.id) ? 'running' : r.deletion?.status ?? 'none', deleted: r.deletion?.deleted ?? 0, gone: r.deletion?.gone ?? 0, failed: r.deletion?.failed ?? 0, remaining: leftOf(r), unreadJobs: unreadJobs(r).length, lastAt: r.deletion?.lastAt ?? null },
        };
      });
    },

    /** The whole run (or null), status reflecting this process. */
    async read(hid) {
      await ready;
      if (!state.enabled || !HID.test(hid)) return null;
      const data = await readJson(hid);
      if (!data) return null;
      if (inserting.has(hid)) data.status = 'running';
      if (deleting.has(hid)) data.deletion = { ...data.deletion, status: 'running' };
      return data;
    },

    /**
     * What is left to delete, from the files: Ids of ids.csv minus those in deleted.csv.
     * → { total, bySobject, bySteps: [{ nodeId, sobject, count }] in delete order (reverse of the
     *   insert order), ids?: Map nodeId → [Id] in delete order (withIds) }
     */
    async remaining(hid, { withIds = false } = {}) {
      const data = await readJson(hid);
      if (!data) return null;
      const done = new Set();
      for await (const [id] of lines(file(hid, '.deleted.csv'))) done.add(id);
      const byStep = new Map(); // nodeId → { sobject, ids[] or count }
      for await (const [sobject, step, , id] of lines(file(hid, '.ids.csv'))) {
        if (!id || done.has(id)) continue;
        let g = byStep.get(step);
        if (!g) byStep.set(step, (g = { sobject, count: 0, ids: withIds ? [] : null }));
        g.count++;
        if (withIds) g.ids.push(id);
      }
      // Delete order: steps in the reverse order of their first record (children before parents);
      // inside a step, the reverse insert order (self-lookups).
      const order = [...(data.steps ?? []).map((s) => s.nodeId)].reverse();
      for (const k of byStep.keys()) if (!order.includes(k)) order.push(k);
      const bySteps = [];
      const bySobject = {};
      const ids = withIds ? new Map() : null;
      let total = 0;
      for (const nodeId of order) {
        const g = byStep.get(nodeId);
        if (!g) continue;
        bySteps.push({ nodeId, sobject: g.sobject, count: g.count });
        bySobject[g.sobject] = (bySobject[g.sobject] ?? 0) + g.count;
        total += g.count;
        if (withIds) ids.set(nodeId, g.ids.reverse());
      }
      return { total, bySobject, bySteps, ...(withIds ? { ids } : {}) };
    },

    /** ids.csv download rows: sobject,id,ref,step,status (inserted | deleted | gone). */
    async *idRows(hid, { sobject } = {}) {
      const outcome = new Map();
      for await (const [id, o] of lines(file(hid, '.deleted.csv'))) outcome.set(id, o);
      yield 'sobject,id,ref,step,status\r\n';
      for await (const [so, step, ref, id] of lines(file(hid, '.ids.csv'))) {
        if (sobject && so !== sobject) continue;
        yield `${[so, id, ref, step, outcome.get(id) ?? 'inserted'].map(cell).join(',')}\r\n`;
      }
    },

    /** Removes the three files of a run (not while it runs). */
    async forget(hid) {
      await ready;
      await removeFiles(hid);
    },
  };
}
