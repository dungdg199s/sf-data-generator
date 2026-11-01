// Insert history (design 0011 §5): one entry per insert into an org, on the machine running the
// server, so the Ids of every record the app created can be downloaded and deleted later — and
// so a delete only ever touches Ids the server itself wrote down (it never takes Ids from a client).
//
// <dataDir>/history/  (directory 0700, files 0600)
//   <hid>.json          the run: org (alias, username, orgId, instanceUrl, kind — never a token),
//                       workflow snapshot, seed, now, steps, counts, Bulk jobs, error groups, deletion.
//                       Rewritten whole (temp file + rename).
//   <hid>.ids.csv       Ids inserted, append-only: sobject,step,ref,id
//   <hid>.deleted.csv   delete outcomes, append-only: id,outcome   (deleted | gone)
//
// Appends are awaited by the inserter before its next write call (server/sf/insert.js
// onInserted), so every record in the org has its Id on disk unless the server dies mid-call.
// Writes of one entry are serialized. On start (first use) entries still `running` become
// `interrupted`. Old entries are pruned past LIMITS.historyMaxRuns / historyMaxBytes, fully
// deleted (or empty) ones first, never a running one. Time is the server's Date.now (injectable):
// determinism only applies to generators and the executor.

import { mkdir, writeFile, rename, readFile, readdir, stat, unlink, chmod, open } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { parseCsv } from './sf/bulk-csv.js';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const HID_RE = /^h\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const isValidHid = (hid) => typeof hid === 'string' && HID_RE.test(hid);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IDS_HEADER = 'sobject,step,ref,id\n';
const DELETED_HEADER = 'id,outcome\n';

/** SFDG_DATA_DIR, else the OS data directory of the app. */
export function defaultDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SFDG_DATA_DIR) return path.resolve(env.SFDG_DATA_DIR);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'sf-data-generator');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sf-data-generator');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'sf-data-generator');
}

/** The org as history stores it: identity only, never credentials. */
export function orgIdentity(org = {}) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return { alias: str(org.alias), username: str(org.username), orgId: str(org.orgId), instanceUrl: str(org.instanceUrl), kind: str(org.kind) ?? 'unknown' };
}

/**
 * One cell of a history CSV. A line break can never be written (review of 0011, B1: a crafted
 * step id with "\n" used to forge extra Id rows); quotes and commas are quoted as RFC 4180.
 */
function cell(v) {
  const s = String(v ?? '');
  if (/[\r\n]/.test(s)) throw new Error('Giá trị có xuống dòng không được ghi vào Lịch sử.');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of a history CSV (header skipped), read with a real RFC 4180 parser (quoted line breaks stay in their cell). */
async function* lines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const rows = parseCsv(text);
  rows.shift();
  for (const r of rows) if (!(r.length === 1 && r[0] === '')) yield r;
}

/** Writes (or appends) and flushes to disk before resolving (review of 0011, N5). */
async function writeSynced(f, text, flag) {
  const fh = await open(f, flag, FILE_MODE);
  try {
    await fh.writeFile(text);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

/** Another live process holds the lock? (signal 0 only checks the pid exists). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const LOCKS = new Set(); // lock files this process created (removed on exit)
process.once('exit', () => {
  for (const f of LOCKS) {
    try {
      if (readFileSync(f, 'utf8').trim() === String(process.pid)) unlinkSync(f);
    } catch {
      // gone already
    }
  }
});

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * @param dir       data directory (history lives in <dir>/history)
 * @param clock     () → ms (Date.now)
 * @param random    () → 6 hex characters
 * @param maxRuns / maxBytes  pruning limits
 */
export function createHistory({ dir = defaultDataDir(), clock = () => Date.now(), random = () => randomBytes(3).toString('hex'), maxRuns = 100, maxBytes = 256 * 1024 * 1024 } = {}) {
  const root = path.join(dir, 'history');
  const state = { enabled: false, reason: null, ready: null };
  const chains = new Map(); // hid → Promise (serialized writes)
  const active = new Map(); // hid → 'insert' | 'delete'
  const live = new Map(); // hid → Ids appended by the running insert
  const file = (hid, ext) => {
    if (!isValidHid(hid)) throw Object.assign(new Error('Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).'), { status: 404 });
    return path.join(root, `${hid}${ext}`);
  };
  const serial = (hid, fn) => {
    const next = (chains.get(hid) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => {});
    chains.set(hid, settled);
    settled.then(() => { if (chains.get(hid) === settled) chains.delete(hid); });
    return next;
  };

  /** An append to an entry that vanished (forgotten, removed by hand) must not recreate its files. */
  async function mustExist(hid) {
    if (!(await stat(file(hid, '.json')).then(() => true, () => false))) {
      throw Object.assign(new Error('Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).'), { status: 404 });
    }
  }

  async function writeJson(hid, data) {
    const tmp = `${file(hid, '.json')}.tmp-${random()}`;
    await writeSynced(tmp, `${JSON.stringify(data, null, 1)}\n`, 'wx');
    await rename(tmp, file(hid, '.json'));
  }

  async function readJson(hid) {
    try {
      return JSON.parse(await readFile(file(hid, '.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
      throw e;
    }
  }

  async function countLines(f) {
    let n = 0;
    for await (const _ of lines(f)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  async function init() {
    try {
      await mkdir(root, { recursive: true, mode: DIR_MODE });
      if (process.platform !== 'win32') await chmod(root, DIR_MODE);
      const probe = path.join(root, `.probe-${random()}`);
      await writeFile(probe, '', { mode: FILE_MODE });
      await unlink(probe);
      // One server per history directory (N6): two writers would interleave Ids and prune each other.
      const other = await takeLock();
      if (other) {
        state.enabled = false;
        state.reason = `Một server sf-data-generator khác (pid ${other}) đang dùng thư mục Lịch sử ${root}. Dừng server đó, hoặc đặt SFDG_DATA_DIR khác cho server này`;
        return;
      }
      state.enabled = true;
      state.reason = null;
    } catch (e) {
      state.enabled = false;
      state.reason = e.message;
      return;
    }
    // Leftovers of a crash (N5): temporary files, Id files whose entry never got its .json.
    try {
      const names = await readdir(root);
      const entries = new Set(names.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
      for (const f of names) {
        const base = f.replace(/\.(json\.tmp-.*|ids\.csv|deleted\.csv)$/, '');
        if (/\.json\.tmp-/.test(f) || (/\.(ids|deleted)\.csv$/.test(f) && isValidHid(base) && !entries.has(base))) await unlink(path.join(root, f)).catch(() => {});
      }
    } catch {
      // best effort
    }
    // Entries a previous server left running were interrupted (server stopped mid-insert).
    for (const hid of await hids()) {
      const data = await readJson(hid).catch(() => null);
      if (data?.status !== 'running') continue;
      data.status = 'interrupted';
      data.inserted = await countLines(file(hid, '.ids.csv'));
      await writeJson(hid, data).catch(() => {});
    }
  }

  const ready = () => (state.ready ??= init());

  /** → null when this process holds the lock, else the pid of the live process that does. */
  async function takeLock() {
    const lock = path.join(root, '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeSynced(lock, String(process.pid), 'wx');
        LOCKS.add(lock);
        return null;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number(await readFile(lock, 'utf8').catch(() => ''));
        if (pid === process.pid) return null;
        if (pid > 0 && alive(pid)) return pid;
        await unlink(lock).catch(() => {}); // stale: its server is gone
      }
    }
    return null;
  }

  async function hids() {
    try {
      return (await readdir(root)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isValidHid).sort();
    } catch {
      return [];
    }
  }

  async function sizeOf(hid) {
    let n = 0;
    for (const ext of ['.json', '.ids.csv', '.deleted.csv']) n += await stat(file(hid, ext)).then((s) => s.size, () => 0);
    return n;
  }

  async function removeFiles(hid) {
    for (const ext of ['.json', '.ids.csv', '.deleted.csv']) await unlink(file(hid, ext)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    live.delete(hid);
  }

  /**
   * Entries to remove to make room for one more: every entry with nothing left in an org (remaining
   * 0, no Bulk job still to collect) goes before ANY entry that still has records in an org (review
   * of 0011, S4); oldest first in each group; never a running or active one.
   * → [{ hid, data, size, remaining }]
   */
  async function pruneCandidates() {
    const all = [];
    for (const hid of await hids()) {
      const data = await readJson(hid).catch(() => null);
      all.push({ hid, data, size: await sizeOf(hid), remaining: data ? remainingOf(data) : 0 });
    }
    let count = all.length;
    let bytes = all.reduce((s, e) => s + e.size, 0);
    const removable = (e) => !active.has(e.hid) && e.data?.status !== 'running' && e.data !== null;
    const order = [...all.filter((e) => removable(e) && e.remaining === 0), ...all.filter((e) => removable(e) && e.remaining > 0)];
    const out = [];
    for (const e of order) {
      if (count + 1 <= maxRuns && bytes <= maxBytes) break;
      out.push(e);
      count--;
      bytes -= e.size;
    }
    return out;
  }

  async function prune() {
    for (const e of await pruneCandidates()) await removeFiles(e.hid);
  }

  /** Records an entry may still have in its org (Bulk jobs not collected yet count as at least one). */
  function remainingOf(data) {
    const inserted = live.get(data.id) ?? data.inserted ?? 0;
    const left = Math.max(0, inserted - (data.deletion?.deleted ?? 0) - (data.deletion?.gone ?? 0));
    return left + pendingRecords(data);
  }

  /** Records of Bulk jobs whose Ids are still to be read (not lost for good). */
  function pendingRecords(data) {
    return (data.bulkJobs ?? []).filter((j) => !j.idsCollected && !j.idsLost).reduce((n, j) => n + (j.records ?? 1), 0);
  }

  // remaining() of finished entries, reused while their files do not change (list() of 100 entries).
  const remainingCache = new Map(); // hid → { sig, value }
  async function cachedRemaining(hid) {
    const sig = (await Promise.all(['.json', '.ids.csv', '.deleted.csv'].map((ext) => stat(file(hid, ext)).then((x) => `${x.size}:${x.mtimeMs}`, () => '-')))).join('|');
    const hit = remainingCache.get(hid);
    if (hit?.sig === sig) return hit.value;
    const value = await api.remaining(hid);
    remainingCache.set(hid, { sig, value: value && { total: value.total, rejected: value.rejected } });
    return remainingCache.get(hid).value;
  }

  const api = {
    get dir() {
      return root;
    },
    /**
     * What creating one more entry would prune (S4): entries that still have records in an org are
     * returned so the insert can warn. → [{ id, startedAt, org, remaining }]
     */
    async prunePreview() {
      await ready();
      if (!state.enabled) return [];
      return (await pruneCandidates()).filter((e) => e.remaining > 0).map((e) => ({ id: e.hid, startedAt: e.data.startedAt, org: e.data.org, workflowName: e.data.workflow?.name ?? '', remaining: e.remaining }));
    },
    /** `retry`: a disabled history tries its directory again (it may have been fixed meanwhile). */
    async status({ retry = false } = {}) {
      await ready();
      if (retry && !state.enabled) {
        state.ready = null;
        await ready();
      }
      return { enabled: state.enabled, reason: state.reason, dir: root, maxRuns };
    },

    /**
     * New entry, right before the first write of an insert. Throws (the insert must not start)
     * when history is off or cannot be written.
     */
    async create({ org, workflow, seed, now, bulk = 'auto', steps = [], total = 0 }) {
      await ready();
      if (!state.enabled) {
        state.ready = null; // the directory may have been fixed: try again once
        await ready();
        if (!state.enabled) throw new Error(state.reason);
      }
      await prune();
      let hid;
      do hid = `h${stamp(clock())}-${random()}`; while (await stat(file(hid, '.json')).then(() => true, () => false));
      const data = {
        version: 1,
        id: hid,
        status: 'running',
        startedAt: new Date(clock()).toISOString(),
        finishedAt: null,
        org: orgIdentity(org),
        workflow: workflow ? { version: workflow.version, name: workflow.name ?? '', ...(workflow.settings ? { settings: workflow.settings } : {}), steps: workflow.steps ?? [] } : null,
        seed,
        now,
        bulk,
        steps: steps.map((s) => ({ nodeId: String(s.nodeId), alias: s.alias ?? null, sobject: s.sobject, mode: s.mode ?? 'collections', total: s.records ?? s.total ?? 0, inserted: 0, failed: 0 })),
        total,
        inserted: 0,
        failed: 0,
        notSent: 0,
        bulkJobs: [],
        errorGroups: [],
        errorGroupsOther: null,
        stopped: null,
        warnings: [],
        deletion: { status: 'none', deleted: 0, gone: 0, lastAt: null, errorGroups: [] },
      };
      await writeSynced(file(hid, '.ids.csv'), IDS_HEADER, 'wx');
      await writeJson(hid, data);
      live.set(hid, 0);
      return hid;
    },

    /** Ids of one call: [{ sobject, nodeId, ref, id }]. Resolves once on disk. */
    appendIds(hid, rows) {
      if (!rows.length) return Promise.resolve();
      let text;
      try {
        text = rows.map((r) => `${cell(r.sobject)},${cell(r.nodeId)},${cell(r.ref)},${cell(r.id)}\n`).join('');
      } catch (e) {
        return Promise.reject(e);
      }
      return serial(hid, async () => {
        await mustExist(hid);
        await writeSynced(file(hid, '.ids.csv'), text, 'a');
        if (live.has(hid)) live.set(hid, live.get(hid) + rows.length);
      });
    },

    /** Delete outcomes: [{ id, outcome: 'deleted' | 'gone' }]. */
    appendDeleted(hid, rows) {
      if (!rows.length) return Promise.resolve();
      let text;
      try {
        text = rows.map((r) => `${cell(r.id)},${cell(r.outcome)}\n`).join('');
      } catch (e) {
        return Promise.reject(e);
      }
      return serial(hid, async () => {
        await mustExist(hid);
        const f = file(hid, '.deleted.csv');
        const fresh = await stat(f).then(() => false, () => true);
        await writeSynced(f, `${fresh ? DELETED_HEADER : ''}${text}`, 'a');
      });
    },

    /** Merges `patch` into the entry (a function gets the current data and returns the patch). */
    update(hid, patch) {
      return serial(hid, async () => {
        const data = await readJson(hid);
        if (!data) throw Object.assign(new Error('Không tìm thấy lần insert này trong Lịch sử (có thể đã bị dọn vì vượt giới hạn lưu trữ).'), { status: 404 });
        const next = { ...data, ...(typeof patch === 'function' ? patch(data) : patch) };
        await writeJson(hid, next);
        return next;
      });
    },

    /** The insert ended (done, cancelled, stopped, error). */
    async finish(hid, patch) {
      const out = await api.update(hid, { ...patch, finishedAt: new Date(clock()).toISOString() });
      live.delete(hid);
      return out;
    },

    async read(hid) {
      if (!isValidHid(hid)) return null;
      await ready();
      const data = await readJson(hid);
      if (data && live.has(hid)) data.inserted = live.get(hid);
      return data;
    },

    /** Every Id row: { sobject, nodeId, ref, id }, in insert order. */
    async* ids(hid) {
      for await (const [sobject, nodeId, ref, id] of lines(file(hid, '.ids.csv'))) yield { sobject, nodeId, ref, id };
    },

    /** id → 'deleted' | 'gone' */
    async deletedMap(hid) {
      const map = new Map();
      for await (const [id, outcome] of lines(file(hid, '.deleted.csv'))) map.set(id, outcome);
      return map;
    },

    /**
     * Ids still to delete, grouped by step in the entry's step order (insert order). A row whose step
     * is not one of the entry's steps, or whose sObject is not that step's sObject, is never
     * returned (counted in `rejected`): only rows the inserter wrote for a known step can be deleted.
     * → { steps: [{ nodeId, sobject, ids }], total, bySobject, inserted, rejected }
     */
    async remaining(hid) {
      const data = await api.read(hid);
      if (!data) return null;
      const done = await api.deletedMap(hid);
      const byStep = new Map((data.steps ?? []).map((s) => [String(s.nodeId), { nodeId: String(s.nodeId), sobject: s.sobject, ids: [] }]));
      let inserted = 0;
      let rejected = 0;
      for await (const r of api.ids(hid)) {
        const step = byStep.get(r.nodeId);
        if (!step || step.sobject !== r.sobject || !r.id) {
          rejected++;
          continue;
        }
        inserted++;
        if (done.has(r.id)) continue;
        step.ids.push(r.id);
      }
      const steps = [...byStep.values()];
      const bySobject = {};
      for (const s of steps) if (s.ids.length) bySobject[s.sobject] = (bySobject[s.sobject] ?? 0) + s.ids.length;
      return { steps, total: steps.reduce((n, s) => n + s.ids.length, 0), bySobject, inserted, rejected };
    },

    async list() {
      await ready();
      const out = [];
      for (const hid of (await hids()).reverse()) {
        const d = await readJson(hid).catch(() => null);
        if (!d) {
          // An empty or broken .json is shown, not dropped (N5): its Ids may still be in the org.
          const size = await stat(file(hid, '.json')).then((x) => x.size, () => null);
          if (size === null) continue;
          out.push({ id: hid, status: 'corrupt', error: `File ${hid}.json ${size ? 'hỏng' : 'rỗng'}: không đọc được lần insert này. Id đã ghi (nếu có) vẫn ở ${hid}.ids.csv.` });
          continue;
        }
        const inserted = live.get(hid) ?? d.inserted ?? 0;
        const bySobject = {};
        for (const s of d.steps ?? []) bySobject[s.sobject] = (bySobject[s.sobject] ?? 0) + (s.inserted ?? 0);
        // The same filtered count a delete uses (rows of unknown steps are not deletable, review 2
        // item 3); a running insert uses its live counter.
        let remaining = remainingOf({ ...d, inserted });
        let rejected = 0;
        if (!live.has(hid)) {
          const c = await cachedRemaining(hid, d).catch(() => null);
          if (c) {
            remaining = c.total + pendingRecords(d);
            rejected = c.rejected;
          }
        }
        out.push({
          id: d.id, status: d.status, startedAt: d.startedAt, finishedAt: d.finishedAt, org: d.org, workflowName: d.workflow?.name ?? '',
          seed: d.seed, total: d.total, inserted, failed: d.failed, notSent: d.notSent, bySobject,
          deletion: { status: d.deletion?.status ?? 'none', deleted: d.deletion?.deleted ?? 0, gone: d.deletion?.gone ?? 0, remaining },
          ...(rejected ? { rejected } : {}),
          ...(active.has(hid) ? { active: active.get(hid) } : {}),
        });
      }
      return out;
    },

    /** Removes the entry's files; refuses (409) while a run uses it (N1). */
    async forget(hid) {
      if (!(await api.read(hid))) return false;
      if (active.has(hid)) throw Object.assign(new Error('Lần insert này đang được dùng (insert, xóa hoặc quên đang chạy). Chờ việc đó xong rồi thử lại.'), { status: 409 });
      active.set(hid, 'forget');
      try {
        await serial(hid, () => removeFiles(hid));
      } finally {
        active.delete(hid);
      }
      return true;
    },

    /** A run in progress on an entry ('insert' | 'delete'): forget / delete refuse it. */
    activeKind: (hid) => active.get(hid) ?? null,
    markActive(hid, kind) {
      active.set(hid, kind);
      return () => { if (active.get(hid) === kind) active.delete(hid); };
    },

    /** Raw files of an entry (tests: modes, secret scan). */
    files: (hid) => ['.json', '.ids.csv', '.deleted.csv'].map((ext) => file(hid, ext)),
  };
  return api;
}
