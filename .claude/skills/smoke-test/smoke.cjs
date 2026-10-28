// UI smoke test: starts the server, loads the editor ("Quy trình" view) in headless Chromium and
// exercises the main flows; fails on any page error. Flows (described in SKILL.md):
//   1. load the "Account + Contact" sample; steps, Start card and palette items have data-type and an
//      icon tile, no inline --c; NODE_COLORS is gone from the client (0008)
//   2. "+" inside the inner loop body (menu rows typed + icons) → Record; Alt+↑ moves it; Delete then
//      Ctrl+Z restores it
//   3. Ctrl+Enter previews: results table (sticky header right under the tabs) and "bản ghi" / "lần lặp"
//      stat chips on the cards; Record and Loop stripes differ from each other and the unknown-type fallback
//  3b. run progress (0004): Dừng + 3 px progress while a (delayed) run is on, Dừng drops it (focus back on
//      Xem trước); Dừng after the response but before `start` cancels by run id; 60 Contacts per
//      run show "Hiển thị 200/N" and "Tải CSV" downloads all N rows from /api/export
//   4. renaming an alias via "" keeps focus and Lookup refs follow
//   5. "Hoàn tác" on the delete toast disappears after another edit
//  5b. variable picker (0005): {x} + search + Enter inserts {{acc.Industry}}, "{{in" puts loop.index first,
//      chips are coloured by source type, a misspelt field turns its chip red with an error badge on the card,
//      "Sửa thành" fixes it, renaming the field updates the template
//  5c. Query → Chọn bản ghi → Record without an org (0006): the "Contact cho Account có sẵn" sample previews with
//      5 sample rows (tab "↓ accs", warning on the Query card), "Chọn bản ghi" from the palette fills from/alias,
//      "{{" in WHERE outlines the field
//   6. a v1 autosave is migrated on load (toast) and the sfdg.workflow.v1 key is left untouched
//   7. a malformed v2 autosave falls back to the sample without being overwritten
//   8. a malformed v2 file is refused with a toast
//   9. opening a v1 file with an unconnected node shows the migration report dialog
//  10. theme switch: Tối / Theo hệ thống set or clear data-theme on <html>, survive a reload and are
//      followed by a second tab (storage event)
//  11. narrow (390 px) layout renders, tapping a card opens the inspector bottom sheet
//  12. dark colour scheme: Sáng overrides it (also after reload), Theo hệ thống returns to dark; sample +
//      preview, and the Insert confirmation for a production org
//      (mocked /api/orgs; a run with a target is blocked) has a solid red "Insert" and the warning box;
//      then mocked inserts (answered by the route, never sent): a second Insert previews afresh, a fixed seed
//      warns about repeating the data, error groups are role=button rows (Space) with a remainder row
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

// Body background of each theme (--color-bg: gray-50 / gray-950).
const BG = { light: 'rgb(243, 245, 248)', dark: 'rgb(15, 18, 22)' };
const ORGS = [{ alias: 'prod', username: 'admin@acme.com', isSandbox: false, isScratch: false, connectedStatus: 'Connected' }];

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
    // Step types are drawn from data-type + an icon tile (CSS), not from inline colours.
    const untyped = await page.$$eval('.step, .start-card, #palette-items .palette-item', (els) =>
      els.filter((e) => !e.dataset.type || !e.querySelector('.ico-tile .ico') || e.style.getPropertyValue('--c')).length);
    check(untyped === 0, `${untyped} step/palette elements without data-type + .ico-tile (or with inline --c)`);
    // Each type wins over the neutral [data-type] fallback (equal specificity: source order).
    const stripes = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.dataset.type = 'no-such-type';
      probe.className = 'step-card';
      document.body.append(probe);
      const fallback = getComputedStyle(probe).borderLeftColor;
      probe.remove();
      const of = (t) => getComputedStyle(document.querySelector(`.step[data-type="${t}"] > .step-card`)).borderLeftColor;
      return { fallback, record: of('record'), loop: of('loop') };
    });
    check(stripes.record !== stripes.loop && ![stripes.record, stripes.loop].includes(stripes.fallback),
      `type stripes not distinct from each other / the fallback (${JSON.stringify(stripes)})`);
    const storeSrc = await (await fetch(`${base}/js/store.js`)).text();
    check(!/NODE_COLORS/.test(storeSrc), 'NODE_COLORS is still in client/js/store.js');
    const countSteps = () => page.$$eval('.step-card:not(.start-card)', (n) => n.length);
    const before = await countSteps();

    // "+" after "con" inside the inner loop body → Record.
    await page.click('.add-point[data-parent="loopCon"][data-slot="body"][data-index="1"] .add-btn');
    const menuTypes = await page.$$eval('.popup .popup-item', (n) => n.map((b) => (b.querySelector('.ico-tile') ? b.dataset.type : '-')));
    check(menuTypes.length > 0 && menuTypes.every((t) => t && t !== '-'), `"+" menu rows without data-type/icon (${menuTypes.join(', ')})`);
    await page.click('.popup .popup-item[data-type="record"]');
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
    // Sticky table header sits right under the sticky tab row (no gap) once the results are scrolled.
    const stickyGap = await page.evaluate(() => {
      const body = document.getElementById('results-body');
      body.scrollTop = 120;
      const gap = body.querySelector('table.data th').getBoundingClientRect().top - body.querySelector('.tabs').getBoundingClientRect().bottom;
      const scrolled = body.scrollTop > 0;
      body.scrollTop = 0;
      return scrolled ? gap : 0;
    });
    check(Math.abs(stickyGap) < 0.5, `sticky table header is ${stickyGap}px away from the tab row`);
    console.log(`steps=${before + 1}`);
    console.log(`summary=${summary.trim()}`);
    if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440.png') });

    // Run progress (0004): while a run is on, Dừng takes the download buttons' place and a 3 px
    // <progress> sits on the bottom edge of the results header; Dừng before the server answered
    // drops the request. Then 60 Contacts per run: the Contact tab shows 200 with a "Hiển thị 200/N"
    // hint, and "Tải CSV" regenerates the whole tab on the server.
    await page.route('**/api/run', async (r) => { await new Promise((res) => setTimeout(res, 200)); await r.continue().catch(() => {}); });
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#btn-stop:not([hidden])');
    const during = await page.evaluate(() => {
      const head = document.querySelector('.results-head').getBoundingClientRect();
      const bar = document.getElementById('run-progress').getBoundingClientRect();
      return { summary: document.getElementById('results-summary').textContent, json: document.getElementById('btn-dl-json').hidden, h: bar.height, gap: Math.abs(head.bottom - bar.bottom), w: bar.width - head.width };
    });
    check(/Đang sinh dữ liệu/.test(during.summary) && during.json, `no running state (${JSON.stringify(during)})`);
    check(during.h > 0 && during.h <= 3 && during.gap < 1 && Math.abs(during.w) < 1, `progress bar is not a 3 px line on the header edge (${JSON.stringify(during)})`);
    await page.click('#btn-stop');
    await page.waitForSelector('#btn-stop', { state: 'hidden' });
    check(/Đã dừng/.test(await page.textContent('#results-summary')), 'Dừng did not report the stop');
    check(!(await page.isDisabled('#btn-preview')), 'Xem trước stays disabled after Dừng');
    check(await page.evaluate(() => document.activeElement?.id === 'btn-preview'), 'focus was not moved from Dừng to Xem trước when the run ended');
    check((await page.getAttribute('#results-summary', 'aria-live')) === 'polite', '#results-summary has no aria-live="polite"');
    await page.unroute('**/api/run');
    // Dừng after the response arrived but before its first event: the run is cancelled by id
    // (POST /api/runs/<id>/cancel when `start` comes), not by dropping the stream.
    await page.evaluate(() => {
      const orig = window.fetch;
      window.__cancels = [];
      window.__restoreFetch = () => { window.fetch = orig; };
      window.fetch = async (url, opts) => {
        if (String(url).includes('/cancel')) window.__cancels.push(String(url));
        const res = await orig(url, opts);
        if (!String(url).endsWith('/api/run')) return res;
        const body = new ReadableStream({
          async start(c) {
            await new Promise((r) => setTimeout(r, 200));
            const rd = res.body.getReader();
            for (let x; !(x = await rd.read()).done;) c.enqueue(x.value);
            c.close();
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      };
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#btn-stop:not([hidden])');
    await page.click('#btn-stop');
    await page.waitForSelector('#btn-stop', { state: 'hidden' });
    const cancels = await page.evaluate(() => { window.__restoreFetch(); return window.__cancels; });
    check(cancels.length === 1 && /\/api\/runs\/r[0-9a-f]{8}\/cancel$/.test(cancels[0]), `Dừng after the response did not cancel by run id (${cancels})`);
    check(/bản ghi/.test(await page.textContent('#results-summary')), 'the stream was dropped instead of read to its end');
    await page.click('.step-card[data-id="con"] .type');
    await page.fill('#inspector input[data-key="count"]', '60');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+Enter');
    await page.click('.tabs button:has-text("Contact (")');
    await page.waitForSelector('.table-more');
    const conTotal = Number((await page.textContent('.tabs button:has-text("Contact (")')).replace(/\D/g, ''));
    const more = await page.textContent('.table-more');
    check(conTotal > 200 && more.includes(`Hiển thị 200/${conTotal.toLocaleString('en').replace(/,/g, ' ')} dòng đầu`), `no truncated-table hint (${more})`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-dl-csv')]);
    const csvLines = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r\n/);
    check(csvLines.length === conTotal + 1 && /^ref,FirstName,LastName/.test(csvLines[0]), `CSV export: ${csvLines.length} lines for ${conTotal} Contacts, header ${csvLines[0]}`);
    await page.fill('#inspector input[data-key="count"]', '1');
    await page.keyboard.press('Tab');

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

    // Variable picker (0005): open the Title options of "con", insert variables with {x} and "{{",
    // see the chips, a misspelt field turns its chip red (error badge on the card) and "Sửa thành" fixes it.
    await page.click('.step-card[data-id="con"] .type');
    const title = '#inspector .field-card[data-field="fields.Title"]';
    await page.click(`${title} .actions button[title="Tùy chọn"]`);
    const tplInput = `${title} input[data-key="template"]`;
    await page.waitForSelector(tplInput);
    await page.fill(tplInput, '');
    await page.click(`${title} .var-btn`);
    await page.waitForSelector('.var-picker .vp-item');
    check(await page.evaluate(() => document.activeElement?.classList.contains('var-search')), '{x} did not focus the picker search');
    // ARIA: the listbox holds only groups/options, the popup is not a dialog, aria-controls points at it.
    const aria = await page.evaluate((sel) => {
      const lb = document.querySelector('.var-picker [role="listbox"]');
      const bad = [...lb.querySelectorAll(':scope > *')].filter((n) => n.getAttribute('role') !== 'group').length
        + [...lb.querySelectorAll('[role="group"] > *')].filter((n) => !['option'].includes(n.getAttribute('role')) && !n.classList.contains('vp-head') && !n.classList.contains('vp-more')).length;
      return { bad, dialog: Boolean(document.querySelector('.var-picker[role="dialog"]')), controls: document.querySelector(sel).getAttribute('aria-controls') === lb.id };
    }, tplInput);
    check(aria.bad === 0 && !aria.dialog && aria.controls, `picker ARIA structure (${JSON.stringify(aria)})`);
    await page.keyboard.type('indu');
    const activeAfterSearch = await page.$eval('.var-picker .vp-item.active', (el) => el.dataset.path).catch(() => null);
    check(activeAfterSearch === 'acc.Industry', `"indu" did not highlight acc.Industry (${activeAfterSearch})`);
    await page.keyboard.press('Enter');
    check(!(await page.$('.var-picker')), 'picker still open after Enter');
    check((await page.inputValue(tplInput)) === '{{acc.Industry}}', `insert gave ${await page.inputValue(tplInput)}`);
    check(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), tplInput), 'focus did not return to the template field');
    check(!(await page.$eval(tplInput, (el) => el.hasAttribute('aria-controls'))), 'aria-controls left on the field while the picker is closed');
    check(await page.waitForSelector(`${title} .var-chip[data-path="acc.Industry"][data-type="record"]`, { timeout: 2000 }).catch(() => null), 'no record-coloured chip for acc.Industry');
    await page.keyboard.type(' #{{');
    await page.waitForSelector('.var-picker .vp-item');
    await page.keyboard.type('in');
    const firstIn = await page.$eval('.var-picker .vp-item.active', (el) => el.dataset.path);
    check(firstIn === 'loop.index', `"{{in" should put loop.index first (${firstIn})`);
    await page.keyboard.press('Enter');
    check((await page.inputValue(tplInput)) === '{{acc.Industry}} #{{loop.index}}', `autocomplete gave ${await page.inputValue(tplInput)}`);
    check(await page.waitForSelector(`${title} .var-chip[data-path="loop.index"][data-type="loop"]`, { timeout: 2000 }).catch(() => null), 'no loop-coloured chip for loop.index');
    check((await page.$$eval(`${title} .var-chip[tabindex="0"]`, (n) => n.length)) === 1, 'the chip strip should be a single tab stop');
    await page.keyboard.type(' {{acc.Nmae}}');
    await page.waitForSelector(`${title} .var-chip.has-error[data-path="acc.Nmae"]`, { timeout: 3000 });
    check(await page.isVisible('.step-card[data-id="con"].has-error'), 'card "con" has no error badge for the broken reference');
    check(/Ý bạn là "Name"/.test(await page.textContent(`${title} .error-text`)), 'no "Ý bạn là" hint under the field');
    await page.click(`${title} .fix-btn`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.value === '{{acc.Industry}} #{{loop.index}} {{acc.Name}}', tplInput, { timeout: 2000 }).catch(() => {});
    check((await page.inputValue(tplInput)) === '{{acc.Industry}} #{{loop.index}} {{acc.Name}}', `"Sửa thành" gave ${await page.inputValue(tplInput)}`);
    await page.waitForFunction(() => !document.querySelector('.step-card[data-id="con"].has-error'), null, { timeout: 3000 }).catch(() => {});
    check(!(await page.$('.step-card[data-id="con"].has-error')), 'error badge stayed after the fix');
    // Renaming a field moves {{acc.Industry}} along (on change), with a toast.
    await page.click('.step-card[data-id="acc"] .type');
    const industry = await page.$('#inspector .field-card[data-field="fields.Industry"] input[aria-label="Tên field"]');
    await industry.fill('Industry__c');
    await industry.press('Tab');
    const followed = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('sfdg.workflow.v2'))).match(/"name":"Title","type":"template","options":\{"template":"([^"]*)"/)?.[1]);
    check(followed === '{{acc.Industry__c}} #{{loop.index}} {{acc.Name}}', `field rename did not follow (${followed})`);
    check(/Đã cập nhật 1 tham chiếu: acc.Industry → acc.Industry__c/.test(await page.textContent('#toast')), 'no rename toast');
    // One undo restores both the name and the references.
    await page.click('#btn-undo');
    const undone = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('sfdg.workflow.v2'))));
    check(undone.includes('"name":"Industry","type":"picklist"') && undone.includes('"template":"{{acc.Industry}} #{{loop.index}} {{acc.Name}}"'), 'one Ctrl+Z did not undo the field rename and its references together');

    // Renaming the field that owns a chip strip keeps the strip live; $n chips are neutral; ⊗ on unresolved error chips.
    await page.click('.step-card[data-id="con"] .type');
    const titleName = await page.$(`${title} input[aria-label="Tên field"]`);
    await titleName.fill('Title2');
    await titleName.press('Tab');
    const title2 = '#inspector .field-card[data-field="fields.Title2"]';
    await page.click(`${title2} input[data-key="template"]`);
    await page.keyboard.press('End');
    await page.keyboard.type(' {{zzz.Name}} {{this.$n}}');
    await page.keyboard.press('Escape');
    const stale = await page.waitForSelector(`${title2} .var-chip.has-error[data-path="zzz.Name"]`, { timeout: 3000 }).catch(() => null);
    check(stale, 'chip strip did not follow the renamed field (no red chip for zzz.Name)');
    if (stale) check(await stale.evaluate((el) => getComputedStyle(el, '::before').content !== 'none'), 'no ⊗ icon on an unresolved error chip');
    check(await page.$(`${title2} .var-chip[data-path="this.$n"][data-type="start"]`), '{{this.$n}} chip is not neutral (start)');
    // Editing referenceTo refreshes the "Bản ghi cha" list.
    const accountId = '#inspector .field-card[data-field="fields.AccountId"]';
    await page.click(`${accountId} .actions button[title="Tùy chọn"]`);
    await page.fill(`${accountId} textarea[data-key="referenceTo"]`, 'Lead');
    const refText = await page.$eval(`${accountId} select[data-key="ref"] option[value="acc"]`, (o) => o.textContent);
    check(/trỏ tới Lead/.test(refText), `"Bản ghi cha" did not refresh after referenceTo (${refText})`);

    // Path fields (branch "Giá trị"): a valid default outside loops, no opening on focus, Tab never inserts untouched.
    await page.evaluate(() => {
      const rec = { id: 'a', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [{ name: 'Name', type: 'text', options: {} }] } };
      const top = { id: 'top', type: 'branch', config: { kind: 'chance', probability: 0.5 }, slots: { true: [], false: [] } };
      const inner = { id: 'B', type: 'branch', config: { kind: 'compare', left: '', op: 'eq', right: '1' }, slots: { true: [], false: [] } };
      localStorage.setItem('sfdg.workflow.v2', JSON.stringify({ version: 2, name: 'p', steps: [rec, top, { id: 'L', type: 'loop', config: { count: 2, alias: 'loop' }, slots: { body: [inner] } }] }));
    });
    await page.reload();
    await page.waitForSelector('.step-card[data-id="top"]');
    await page.click('.step-card[data-id="top"] .type');
    await page.selectOption('#inspector select[data-key="kind"]', 'compare');
    const leftSel = '#inspector input[data-key="left"]';
    check((await page.inputValue(leftSel)) === 'acc.Name', `compare outside loops kept an invalid default (${await page.inputValue(leftSel)})`);
    await page.click('.step-card[data-id="B"] .type');
    await page.focus('#inspector select[data-key="kind"]');
    await page.keyboard.press('Tab');
    check(!(await page.$('.var-picker')), 'the path picker opened on focus');
    await page.keyboard.press('Tab');
    check((await page.inputValue(leftSel)) === '', 'Tab through an empty path field inserted a variable');
    await page.click(leftSel);
    await page.waitForSelector('.var-picker .vp-item');
    await page.keyboard.press('Tab');
    check((await page.inputValue(leftSel)) === '' && !(await page.$('.var-picker')), 'Tab accepted the first row without typing');
    await page.click(leftSel);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    check((await page.inputValue(leftSel)) !== '', 'Tab after moving the selection did not insert');

    // Query → Chọn bản ghi → Record without an org (0006): sample rows, warning, palette defaults, {{ }} refused.
    await page.click('#sample-items .palette-item:has-text("Contact cho Account có sẵn")');
    await page.waitForSelector('.step-card[data-id="accs"] .tag-sample');
    await page.keyboard.press('Control+Enter');
    const qTab = await page.waitForSelector('.tabs .tab-query[data-query="accs"]', { timeout: 3000 }).catch(() => null);
    check(qTab && /↓ accs · Account \(5\)/.test(await qTab.textContent()), 'no "↓ accs · Account (5)" tab of sample rows');
    check(/accs: 5 bản ghi mẫu/.test(await page.textContent('#results-summary')), 'results summary does not mention the sample rows');
    check(/Contact: 10/.test(await page.textContent('#results-summary')), 'the Query sample did not generate 10 Contacts');
    check(await page.isVisible('.step-card[data-id="accs"].has-warning'), 'no warning on the Query card without an org');
    await page.click('.step-card[data-id="accs"] .type');
    await page.click('#palette-items .palette-item[data-type="pick"]');
    await page.waitForSelector('#inspector select[data-key="from"]');
    const pickFrom = await page.$eval('#inspector select[data-key="from"]', (el) => el.value);
    const pickAlias = await page.inputValue('#inspector input[data-key="alias"]');
    check(pickFrom === 'accs' && /^acc\d*$/.test(pickAlias), `new Chọn bản ghi did not default to accs / acc… (${pickFrom}, ${pickAlias})`);
    await page.click('.step-card[data-id="accs"] .type');
    await page.fill('#inspector input[data-key="where"]', 'AccountId = {{acc.Id}}');
    check(await page.waitForSelector('#inspector input[data-key="where"].invalid', { timeout: 3000 }).catch(() => null), '"{{" in WHERE is not outlined');

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

    // Theme switch: explicit theme overrides the OS scheme and survives a reload.
    const theme = () => page.evaluate(() => [document.documentElement.dataset.theme ?? '', getComputedStyle(document.body).backgroundColor, localStorage.getItem('sfdg.theme')]);
    check((await theme())[1] === BG.light, `light scheme: unexpected background ${(await theme())[1]}`);
    const other = await ctx.newPage(); // a second tab follows theme changes through the storage event
    other.on('pageerror', (e) => errors.push(`[tab 2] ${e}`));
    await other.goto(base);
    await other.waitForSelector('.step-card');
    const otherTheme = () => other.evaluate(() => [document.documentElement.dataset.theme ?? '', document.getElementById('theme-select').value]);
    await page.selectOption('#theme-select', 'dark');
    let t = await theme();
    check(t[0] === 'dark' && t[1] === BG.dark && t[2] === 'dark', `"Tối" did not apply the dark theme (${t})`);
    await other.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 2000 }).catch(() => {});
    check(String(await otherTheme()) === 'dark,dark', `second tab did not follow "Tối" (${await otherTheme()})`);
    await page.reload();
    await page.waitForSelector('.step-card');
    t = await theme();
    check(t[0] === 'dark' && t[1] === BG.dark && (await page.inputValue('#theme-select')) === 'dark', `dark theme not kept after reload (${t})`);
    await page.selectOption('#theme-select', 'system');
    t = await theme();
    check(t[0] === '' && t[1] === BG.light && t[2] === null, `"Theo hệ thống" did not return to the OS scheme (${t})`);
    await other.waitForFunction(() => !document.documentElement.dataset.theme, null, { timeout: 2000 }).catch(() => {});
    check(String(await otherTheme()) === ',system', `second tab did not follow "Theo hệ thống" (${await otherTheme()})`);
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
    if (outDir) {
      await m.emulateMedia({ colorScheme: 'dark' });
      await m.waitForTimeout(250); // sheet transition
      await m.screenshot({ path: path.join(outDir, 'smoke-390-dark.png') });
    }
    await narrow.close();

    // ---------- dark scheme + insert confirmation ----------
    const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const d = await dark.newPage();
    d.on('pageerror', (e) => errors.push(`[dark] ${e}`));
    let insertSent = false;
    await d.route('**/api/orgs', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORGS) }));
    // The mocked org does not exist: never let sobjects/describe calls reach the real sf CLI.
    await d.route('**/api/orgs/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'smoke: org giả lập' }) }));
    await d.route('**/api/run', (r) => {
      // Safety: a run with a target would write to an org. Never let it reach the server.
      if (r.request().postDataJSON()?.target) { insertSent = true; return r.abort(); }
      return r.continue();
    });
    await d.goto(base);
    await d.evaluate(() => localStorage.clear());
    await d.reload();
    await d.waitForSelector('.step-card[data-id="con"]');
    const darkBg = await d.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(darkBg === BG.dark, `dark scheme: unexpected background ${darkBg}`);
    // "Sáng" overrides a dark OS, survives a reload, and "Theo hệ thống" returns to dark.
    const dTheme = () => d.evaluate(() => [document.documentElement.dataset.theme ?? '', getComputedStyle(document.body).backgroundColor, localStorage.getItem('sfdg.theme')]);
    await d.selectOption('#theme-select', 'light');
    let dt = await dTheme();
    check(dt[0] === 'light' && dt[1] === BG.light && dt[2] === 'light', `"Sáng" did not override the dark OS scheme (${dt})`);
    await d.reload();
    await d.waitForSelector('.step-card[data-id="con"]');
    dt = await dTheme();
    check(dt[0] === 'light' && dt[1] === BG.light && (await d.inputValue('#theme-select')) === 'light', `"Sáng" not kept after reload on a dark OS (${dt})`);
    await d.selectOption('#theme-select', 'system');
    dt = await dTheme();
    check(dt[0] === '' && dt[1] === BG.dark && dt[2] === null, `"Theo hệ thống" did not return to the dark OS scheme (${dt})`);
    await d.keyboard.press('Control+Enter');
    await d.waitForSelector('table.data tbody tr');
    if (outDir) await d.screenshot({ path: path.join(outDir, 'smoke-1440-dark.png') });
    await d.selectOption('#org-select', 'prod');
    await d.click('#btn-insert');
    await d.waitForSelector('dialog[open]');
    check(await d.isVisible('dialog[open] .warn-box'), 'no production warning in the Insert confirmation');
    check(await d.isVisible('dialog[open] .actions button.danger.solid:has-text("Insert")'), '"Insert" confirmation button is not .danger.solid');
    if (outDir) await d.screenshot({ path: path.join(outDir, 'smoke-1440-dark-insert.png') });
    await d.click('dialog[open] .actions button:has-text("Hủy")');
    check(!(await d.$('dialog[open]')), '"Hủy" did not close the Insert confirmation');
    // The confirmation for a workflow whose preview read the org (canned preview: the mocked org does not exist).
    await d.route('**/api/run', (r) => {
      const body = r.request().postDataJSON();
      if (body?.target) { insertSent = true; return r.abort(); }
      // The run streams NDJSON events (design 0004): start, then done with the result.
      const result = {
        seed: 1, now: Date.now(), warnings: [], records: [], samples: {},
        stats: { total: 0, bySobject: { Contact: 0 }, byStep: {}, durationMs: 1, previewRows: 200, truncated: false },
        queries: [{ nodeId: 'accs', alias: 'accs', sobject: 'Account', soql: 'SELECT Id FROM Account', org: 'prod', source: 'org', fetchedAt: new Date().toISOString(), count: 2, totalSize: 2, truncated: false, fingerprint: 'abcd1234', fields: ['Id'], records: [{ Id: '001A' }, { Id: '001B' }] }],
      };
      return r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: [{ type: 'start', runId: 'rsmoke', seed: 1, now: result.now, warnings: [] }, { type: 'done', result }].map((e) => JSON.stringify(e)).join('\n') + '\n' });
    });
    d.on('dialog', (x) => x.accept());
    await d.click('#sample-items .palette-item:has-text("Contact cho Account có sẵn")');
    await d.waitForSelector('.step-card[data-id="accs"]');
    await d.fill('#seed', '1');
    await d.keyboard.press('Control+Enter');
    await d.waitForSelector('.tabs .tab-query');
    await d.click('#btn-insert');
    await d.waitForSelector('dialog[open]');
    const confirmText = await d.textContent('dialog[open]');
    check(/Đọc từ org, không ghi: Account 2 \(accs, đọc lúc/.test(confirmText), `confirmation does not list the rows read (${confirmText})`);
    check(/quá 10 phút/.test(confirmText) && /⟳ Đọc lại/.test(confirmText), 'confirmation over-promises change detection');
    check(!/null/.test(confirmText), 'confirmation prints "null"');
    await d.click('dialog[open] .actions button:has-text("Hủy")');
    check(!insertSent, 'an insert request was sent');

    // Insert twice (0004 review): the mock answers every insert itself, so nothing reaches the
    // server or an org. A second Insert previews afresh (an inserted result is not a preview to
    // repeat); with a fixed seed the confirmation warns that the data repeats the last insert.
    // The "Lỗi insert" groups are buttons (Space selects the step) with a remainder row.
    let previews = 0;
    let mockedInserts = 0;
    await d.unroute('**/api/run');
    await d.route('**/api/run', (r) => {
      const body = r.request().postDataJSON();
      if (!body?.target) { previews++; return r.continue(); }
      mockedInserts++;
      const result = {
        runId: 'rmock0001', seed: body.seed, now: body.now, warnings: [], records: [], samples: {},
        stats: { total: 1, bySobject: { Account: 1 }, byStep: {}, durationMs: 1, previewRows: 200, truncated: false },
        insert: {
          inserted: 1, failed: 7, errorsTotal: 7, total: 8, notSent: 0, cancelled: false, stopped: null, ids: {}, bySobject: { Account: { inserted: 1, failed: 0 } },
          errors: [{ ref: 'con#1', sobject: 'Contact', nodeId: 'con', field: 'fields.LastName', message: 'REQUIRED_FIELD_MISSING: x' }],
          errorGroups: [{ sobject: 'Contact', nodeId: 'con', field: 'fields.LastName', message: 'REQUIRED_FIELD_MISSING: x', count: 2, refs: ['con#1', 'con#2'] }],
          errorGroupsOther: { groups: 3, count: 5 },
        },
      };
      return r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'start', runId: 'rmock0001', seed: body.seed, now: body.now, warnings: [] })}\n${JSON.stringify({ type: 'done', result })}\n` });
    });
    await d.click('#sample-items .palette-item >> nth=0');
    await d.waitForSelector('.step-card[data-id="con"]');
    const insertOnce = async () => {
      await d.click('#btn-insert');
      await d.waitForSelector('dialog[open]');
      await d.click('dialog[open] .actions button.danger');
      await d.waitForFunction(() => !document.querySelector('dialog[open]') && document.getElementById('btn-stop').hidden && !document.getElementById('btn-preview').disabled);
    };
    await d.fill('#seed', '');
    await insertOnce();
    const p1 = previews;
    await d.click('#btn-insert');
    await d.waitForSelector('dialog[open]');
    check(previews === p1 + 1, `the second Insert did not preview afresh (${p1} → ${previews})`);
    check(!(await d.$('dialog[open] .same-seed')), 'same-seed warning without a fixed seed');
    await d.click('dialog[open] .actions button:has-text("Hủy")');
    await d.fill('#seed', '7');
    await insertOnce();
    await d.click('.tabs .tab-issues');
    check(/và 3 nhóm lỗi khác/.test(await d.textContent('table.error-groups')), 'no remainder row for the groups past the cap');
    check((await d.getAttribute('table.error-groups tbody tr.clickable', 'role')) === 'button', 'error group rows are not role=button');
    await d.click('.step-card[data-id="acc"] .type');
    await d.focus('table.error-groups tbody tr.clickable');
    await d.keyboard.press(' ');
    await d.waitForSelector('.step-card.selected[data-id="con"]', { timeout: 2000 }).catch(() => errors.push('Space on an error group did not select its step'));
    await d.click('#btn-insert');
    await d.waitForSelector('dialog[open]');
    check(/Seed 7 đã dùng cho lần insert trước/.test((await d.textContent('dialog[open] .same-seed').catch(() => '')) ?? ''), 'no same-seed warning on a repeated insert with a fixed seed');
    await d.click('dialog[open] .actions button:has-text("Hủy")');
    check(mockedInserts === 2, `${mockedInserts} mocked inserts`);
    await dark.close();
  } catch (e) {
    errors.push(String(e));
  } finally {
    await browser?.close();
    server.kill();
  }
  const ms = Date.now() - t0;
  console.log(`duration=${ms}ms`);
  // 12 s: the 0006 flows (Query sample, canned insert confirmation) brought a typical run to ~8 s and
  // single runs on a loaded machine to ~9.6 s; 10 s left no margin.
  if (ms > 12000) errors.push(`smoke test took ${ms} ms (limit 12 s)`);
  if (errors.length) {
    console.error('SMOKE FAILED\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('SMOKE OK');
})();
