// Org connection via the Salesforce CLI already authenticated on this machine.
// We never store credentials: the access token is read from `sf org display` on demand
// and cached in memory only.

import { execFile } from 'node:child_process';

const TOKEN_TTL_MS = 10 * 60 * 1000;

export function createSfCli({ run = defaultRun } = {}) {
  const cache = new Map(); // target -> { conn, at }

  async function sf(args) {
    const { stdout, stderr, code } = await run('sf', [...args, '--json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const hint = code === 'ENOENT' ? ' Chưa cài Salesforce CLI (sf) hoặc sf không có trong PATH.' : '';
      throw Object.assign(new Error(`Không đọc được kết quả từ sf CLI.${hint} ${stderr || ''}`.trim()), { status: 503 });
    }
    if (parsed.status !== 0) throw Object.assign(new Error(parsed.message || `sf ${args.join(' ')} thất bại.`), { status: 502 });
    return parsed.result;
  }

  return {
    /** Orgs known to the local sf CLI, de-duplicated by username. */
    async listOrgs() {
      const result = await sf(['org', 'list']);
      const seen = new Map();
      for (const group of ['nonScratchOrgs', 'sandboxes', 'devHubs', 'scratchOrgs', 'other']) {
        for (const o of result?.[group] ?? []) {
          if (!o?.username || seen.has(o.username)) continue;
          seen.set(o.username, {
            alias: o.alias ?? null,
            username: o.username,
            instanceUrl: o.instanceUrl ?? null,
            isDefault: Boolean(o.isDefaultUsername || o.isDefaultDevHubUsername),
            isScratch: group === 'scratchOrgs',
            isSandbox: group === 'sandboxes' || Boolean(o.isSandbox),
            status: o.connectedStatus ?? o.status ?? null,
          });
        }
      }
      return [...seen.values()];
    },

    /** { accessToken, instanceUrl, apiVersion, username } for an alias or username. */
    async getConnection(target, { refresh = false } = {}) {
      const hit = cache.get(target);
      if (!refresh && hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.conn;
      const r = await sf(['org', 'display', '--target-org', target]);
      if (!r?.accessToken || !r?.instanceUrl) throw new Error(`Org "${target}" chưa đăng nhập hoặc token hết hạn. Chạy: sf org login web --alias ${target}`);
      const conn = {
        accessToken: r.accessToken,
        instanceUrl: r.instanceUrl.replace(/\/$/, ''),
        apiVersion: r.apiVersion || '62.0',
        username: r.username,
      };
      cache.set(target, { conn, at: Date.now() });
      return conn;
    },
  };
}

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32', env: { ...process.env, SF_NO_COLOR: 'true' } },
      (error, stdout, stderr) => resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 }),
    );
  });
}
