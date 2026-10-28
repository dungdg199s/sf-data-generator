// Import first in every test file that builds the app or a history: points SFDG_DATA_DIR at a
// fresh temporary directory (removed when the process exits), so tests never write into the
// user's real data directory (server/history.js refuses to run under node --test without it).

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'sfdg-test-'));
process.env.SFDG_DATA_DIR = TEST_DATA_DIR;
process.on('exit', () => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
