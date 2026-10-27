// UI smoke test: starts the server, loads the editor in headless Chromium, runs the
// "Account + Contact" sample preview and fails on any page error.
// Usage: node .claude/skills/smoke-test/smoke.cjs [screenshotDir]
// Needs Playwright with a Chromium build available (require('playwright')).

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const port = 3900 + Math.floor(Math.random() * 90);
const outDir = process.argv[2];

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright not found. Install it globally or run this from an environment that has it.');
  process.exit(2);
}

async function waitForServer(url, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not start');
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  let browser;
  try {
    await waitForServer(`${base}/api/meta`);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => localStorage.clear());
    await page.goto(base);
    await page.waitForSelector('.node');

    await page.click('#sample-items .palette-item >> nth=0');
    await page.click('#btn-preview');
    await page.waitForSelector('table.data tbody tr');
    const summary = await page.textContent('#results-summary');
    const nodes = await page.$$eval('.node', (n) => n.length);
    const issues = await page.$$eval('.issue.error', (n) => n.map((x) => x.textContent));
    if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke.png') });

    console.log(`nodes=${nodes}`);
    console.log(`summary=${summary.trim()}`);
    if (issues.length) errors.push(`validation errors on sample: ${issues.join(' | ')}`);
    if (!/Account: \d+/.test(summary)) errors.push('preview summary missing Account count');
  } catch (e) {
    errors.push(String(e));
  } finally {
    await browser?.close();
    server.kill();
  }
  if (errors.length) {
    console.error('SMOKE FAILED\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('SMOKE OK');
})();
