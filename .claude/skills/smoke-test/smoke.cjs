// UI smoke test: starts the server, loads the editor ("Quy trình" view) in headless Chromium and
// exercises the main flows; fails on any page error.
//   1. load the "Account + Contact" sample
//   2. "+" inside the inner loop body → Record; Alt+↑ moves it; Delete then Ctrl+Z restores it
//   3. Ctrl+Enter previews: results table and a "bản ghi" stat chip on a card
//   4. a v1 autosave is migrated on load (toast) and the sfdg.workflow.v1 key is left untouched
//   5. opening a v1 file with an unconnected node shows the migration report dialog
//   6. a malformed v2 autosave falls back to the sample without being overwritten; a malformed
//      v2 file is refused with a toast; "Hoàn tác" on the delete toast disappears after another edit
//   7. narrow (390 px) layout renders, tapping a card opens the inspector bottom sheet
// Usage: node .claude/skills/smoke-test/smoke.cjs [screenshotDir]
// Needs Playwright with a Chromium build available (require('playwright')).

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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

const V1_SAMPLE = {
  version: 1,
  name: 'Cũ v1',
  nodes: [
    { id: 'start', type: 'start', position: { x: 40, y: 160 }, config: {} },
    { id: 'l', type: 'loop', position: { x: 300, y: 160 }, config: { count: 3, alias: 'loop' } },
    { id: 'a', type: 'record', position: { x: 580, y: 100 }, config: { sobject: 'Account', alias: 'acc', fields: [{ name: 'Name', type: 'text', options: { mode: 'company' } }] } },
  ],
  edges: [{ from: 'start', fromPort: 'next', to: 'l' }, { from: 'l', fromPort: 'body', to: 'a' }],
};
const V1_ORPHAN = {
  ...V1_SAMPLE,
  name: 'Có node lơ lửng',
  nodes: [...V1_SAMPLE.nodes, { id: 'o1', type: 'record', position: { x: 0, y: 0 }, config: { sobject: 'Lead', alias: 'ld', fields: [] } }],
};

(async () => {
  const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  const t0 = Date.now();
  let browser;
  const check = (cond, msg) => { if (!cond) errors.push(msg); };
  try {
    await waitForServer(`${base}/api/meta`);
    browser = await chromium.launch();

    // ---------- wide ----------
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.step-card');

    await page.click('#sample-items .palette-item >> nth=0');
    await page.waitForSelector('.step-card[data-id="con"]');
    const countSteps = () => page.$$eval('.step-card:not(.start-card)', (n) => n.length);
    const before = await countSteps();

    // "+" after "con" inside the inner loop body → Record.
    await page.click('.add-point[data-parent="loopCon"][data-slot="body"][data-index="1"] .add-btn');
    await page.click('.popup .popup-item:has-text("Record")');
    await page.waitForFunction((n) => document.querySelectorAll('.step-card:not(.start-card)').length === n + 1, before);
    const firstInBody = () => page.$eval('.step[data-step="loopCon"] > .step-body .step-card', (c) => c.dataset.id);
    const added = await page.$eval('.step-card.selected', (c) => c.dataset.id);
    check(added !== 'con', 'new Record step is not selected');
    check((await firstInBody()) === 'con', 'new step should be after "con"');

    await page.keyboard.press('Alt+ArrowUp');
    check((await firstInBody()) === added, 'Alt+↑ did not move the step above "con"');

    await page.keyboard.press('Delete');
    await page.waitForFunction((n) => document.querySelectorAll('.step-card:not(.start-card)').length === n, before);
    await page.keyboard.press('Control+z');
    await page.waitForFunction((n) => document.querySelectorAll('.step-card:not(.start-card)').length === n + 1, before);
    check((await firstInBody()) === added, 'Ctrl+Z did not restore the deleted step in place');

    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('table.data tbody tr');
    await page.waitForSelector('.step-card .stat');
    const chips = await page.$$eval('.step-card .stat', (n) => n.map((x) => x.textContent));
    check(chips.some((c) => /\d+ bản ghi/.test(c)), `no "bản ghi" stat chip (${chips.join(', ')})`);
    check(chips.some((c) => /\d+ lần lặp/.test(c)), 'no "lần lặp" stat chip');
    const summary = await page.textContent('#results-summary');
    const issues = await page.$$eval('.issue.error', (n) => n.map((x) => x.textContent));
    if (issues.length) errors.push(`validation errors on sample: ${issues.join(' | ')}`);
    if (!/Account: \d+/.test(summary)) errors.push('preview summary missing Account count');
    console.log(`steps=${before + 1}`);
    console.log(`summary=${summary.trim()}`);
    if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440.png') });

    // Renaming an alias by clearing the field and typing a name: Lookups follow, not lost on "".
    await page.click('.step-card[data-id="acc"] .type');
    const aliasInput = '#inspector input[data-key="alias"]';
    await page.fill(aliasInput, '');
    await page.type(aliasInput, 'account');
    const ref = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('sfdg.workflow.v2'))).match(/"ref":"(\w+)"/)?.[1]);
    check(ref === 'account', `Lookup ref did not follow the alias rename (${ref})`);
    check(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), aliasInput), 'alias input lost focus while typing');
    for (let i = 0; i < 'account'.length + 1; i++) await page.keyboard.press('Control+z');
    await page.waitForFunction(() => /"ref":"acc"/.test(localStorage.getItem('sfdg.workflow.v2')));

    // "Hoàn tác" in the delete toast only undoes the delete: another edit removes the button.
    await page.click(`.step-card[data-id="${added}"] .type`);
    await page.keyboard.press('Delete');
    await page.waitForSelector('#toast .toast-action');
    await page.keyboard.press('Control+d'); // duplicates the newly selected step
    await page.waitForFunction(() => !document.querySelector('#toast .toast-action'));
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.waitForFunction((n) => document.querySelectorAll('.step-card:not(.start-card)').length === n + 1, before);

    // Migration of a v1 autosave on load.
    const v1Text = JSON.stringify(V1_SAMPLE);
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('sfdg.workflow.v1', t); }, v1Text);
    await page.reload();
    await page.waitForSelector('.step-card[data-id="a"]');
    const toastText = await page.textContent('#toast');
    check(/Đã chuyển workflow đang soạn sang định dạng mới/.test(toastText), `no migration toast (${toastText})`);
    const kept = await page.evaluate(() => [localStorage.getItem('sfdg.workflow.v1'), JSON.parse(localStorage.getItem('sfdg.workflow.v2') || '{}').version]);
    check(kept[0] === v1Text, 'sfdg.workflow.v1 was modified');
    check(kept[1] === 2, 'sfdg.workflow.v2 was not written');

    // A malformed v2 autosave: the sample is shown, the autosave is not overwritten.
    const broken = JSON.stringify({ version: 2, name: 'Hỏng', steps: [{ id: 'x', type: 'loop', config: {}, slots: { body: 5 } }] });
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('sfdg.workflow.v2', t); }, broken);
    await page.reload();
    await page.waitForSelector('.step-card[data-id="con"]');
    const brokenToast = await page.textContent('#toast');
    check(/Không hiển thị được workflow lưu tự động/.test(brokenToast), `no recovery toast (${brokenToast})`);
    check(await page.isVisible('#toast button:has-text("Tải bản lưu")'), 'no "Tải bản lưu" button');
    const stored = await page.evaluate(() => [localStorage.getItem('sfdg.workflow.v2'), localStorage.getItem('sfdg.workflow.v2.broken')]);
    check(stored[0] === broken && stored[1] === broken, 'broken autosave was overwritten or not backed up');

    // A malformed v2 file is refused.
    const badFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfdg-smoke-')), 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify({ version: 2, steps: [{ id: 'a', type: 'record', config: {} }, 3] }));
    await page.setInputFiles('#file-input', badFile);
    await page.waitForFunction(() => /Không mở được file: steps\[1\]/.test(document.getElementById('toast').textContent));
    check(await page.isVisible('.step-card[data-id="con"]'), 'malformed file replaced the workflow');

    // Opening a v1 file with an unconnected node → report dialog.
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfdg-smoke-')), 'old.json');
    fs.writeFileSync(tmp, JSON.stringify(V1_ORPHAN));
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => d.accept());
    await page.setInputFiles('#file-input', tmp);
    await page.waitForSelector('dialog[open] .migration-report li');
    const report = await page.textContent('dialog[open] .migration-report');
    check(/"o1".*đang tắt/.test(report), `migration report does not mention the disabled node (${report})`);
    check(await page.isVisible('dialog[open] button:has-text("Tải bản gốc (v1)")'), 'no "Tải bản gốc (v1)" button');
    await page.click('dialog[open] button:has-text("Đồng ý")');
    check(await page.isVisible('.step[data-step="o1"].disabled'), 'unconnected node is not shown disabled');
    await ctx.close();

    // ---------- narrow ----------
    const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await narrow.newPage();
    m.on('pageerror', (e) => errors.push(`[390] ${e}`));
    m.on('dialog', (d) => d.accept());
    await m.goto(base);
    await m.evaluate(() => localStorage.clear());
    await m.reload();
    await m.waitForSelector('.step-card[data-id="con"]');
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(overflow <= 1, `narrow layout overflows horizontally by ${overflow}px`);
    if (outDir) await m.screenshot({ path: path.join(outDir, 'smoke-390.png') });
    await m.tap('.step-card[data-id="con"] .type');
    await m.waitForSelector('#inspector.open');
    await m.waitForTimeout(250); // sheet transition
    if (outDir) await m.screenshot({ path: path.join(outDir, 'smoke-390-sheet.png') });
    await m.tap('#inspector .sheet-close');
    check(!(await m.$('#inspector.open')), '"‹ Xong" did not close the sheet');
    await narrow.close();
  } catch (e) {
    errors.push(String(e));
  } finally {
    await browser?.close();
    server.kill();
  }
  const ms = Date.now() - t0;
  console.log(`duration=${ms}ms`);
  if (ms > 10000) errors.push(`smoke test took ${ms} ms (limit 10 s)`);
  if (errors.length) {
    console.error('SMOKE FAILED\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('SMOKE OK');
})();
