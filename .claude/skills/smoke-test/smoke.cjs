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
//  13. screen layout (0009): issues bar docked under the canvas (F8, collapse kept after reload, expands on a
//      failed run), top bar rows / no overflow with a long (mocked) org label, the "⋯" menu (Mẫu, Seed chip),
//      bottom sheet keeps the selected card above it and closes on run, one-row results header with "⤓ Tải"
//  14. Lặp "Mỗi bản ghi trong pool" (0010): the sample previews 15 Contacts ("5 lần lặp"), "⋯ → Lặp qua từng
//      bản ghi" on the Query inserts a filled each-loop (one undo), switching a Lặp to each fills pool and name,
//      a Contact moved out of the loop gets the outsideLoop error
//  15. Sơ đồ view (0003 đợt B): M switches with the selection kept, focused and inside the viewport; "+" on a
//      connector adds a Record there; Delete removes it; ↑ walks the tree; M back; dark screenshot; at 390 px
//      the saved Sơ đồ is not applied, the ⋯ menu switches (not saved) and a tap opens the sheet above the card
//  16. insert history and delete (0011, every org call mocked in the page): Bulk checkbox and limit warning in the
//      Insert confirmation, Tải Id / Lịch sử links, "Xóa dữ liệu này…" opens the delete confirmation (Hủy focused),
//      production needs the org name typed, the history dialog (org filter, interrupted title, forget, 390 px)
//  17. variables and loops (0013): "Số lần lặp" {x} lists number variables only and inserts {{accs.$count}};
//      turning the each filter on fills AccountId = {{acc.Id}} (toast, one undo); shuffle + limit 2 → "10 lần
//      lặp"; filter options hidden in fixed mode; run.seed sample; branch right {x}; values loop empty → error,
//      Hot/Warm/Cold → summary
// The flows run in parallel, one browser context each (independent storage): see SKILL.md.
// Usage: node .claude/skills/smoke-test/smoke.cjs [screenshotDir]
// Needs Playwright with a Chromium build available (require('playwright')).

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const outDir = process.argv[2];

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright not found. Install it globally or run this from an environment that has it.');
  process.exit(2);
}

/**
 * The app in this process on a free port (port 0): it dies with the smoke (Ctrl+C, kill), and a
 * stale server on a fixed port can never answer instead. The sf CLI is a stub that fails like a
 * machine without `sf` (503), so the smoke can never reach a real org.
 */
let smokeTmp = null; // temporary dir of the run (insert history of design 0011, files to open), removed at the end

async function startServer() {
  const { createApp, allowedHostsFor } = await import(pathToFileURL(path.join(root, 'server/index.js')).href);
  const { createHistory } = await import(pathToFileURL(path.join(root, 'server/history.js')).href);
  const noCli = async () => { throw Object.assign(new Error('smoke: không dùng sf CLI'), { status: 503 }); };
  // Never the user's real data directory: the history goes to a temporary one.
  smokeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdg-smoke-'));
  const history = createHistory({ dir: path.join(smokeTmp, 'history') });
  const server = http.createServer(createApp({ cli: { listOrgs: noCli, getConnection: noCli }, history, allowedHosts: allowedHostsFor('127.0.0.1') }));
  await new Promise((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', res));
  return server;
}

// Body background of each theme (--color-bg: gray-50 / gray-950).
const BG = { light: 'rgb(243, 245, 248)', dark: 'rgb(15, 18, 22)' };
const ORGS = [{ alias: 'prod', username: 'admin@acme.com', isSandbox: false, isScratch: false, connectedStatus: 'Connected' }];
// 0009: the label that made the top bar wrap ("alias — username [sandbox]").
const LONG_ORGS = [{ alias: 'dev-sandbox-very-long', username: 'admin.developer@acme-corporation.com.devsb', isSandbox: true, isScratch: false, connectedStatus: 'Connected' }];

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

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
let browser;
let base;

/** A fresh context (empty storage) and page; page errors are reported with `label`. */
async function newPage(label, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...ctxOpts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label ? `[${label}] ` : ''}${e}`));
  page.on('dialog', (d) => d.accept());
  return page;
}

/** Answers /api/orgs with `orgs`; describe / sobjects of a mocked org never reach the sf CLI. */
async function mockOrgs(page, orgs) {
  await page.route('**/api/orgs', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orgs) }));
  await page.route('**/api/orgs/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'smoke: org giả lập' }) }));
}

/** Flows 1–5: sample, editing, preview (+ run progress, downloads), alias rename, delete toast. */
async function flowEditing() {
  const page = await newPage('');
  await page.goto(base);
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
  // The request is held until Dừng was clicked (no fixed delay: a slow machine cannot finish the run first).
  let releaseRun;
  const runGate = new Promise((res) => { releaseRun = res; });
  // The held request must be the one this Ctrl+Enter sends: wait for it to reach the route and for
  // the header to say so (one snapshot right after #btn-stop showed was racy under CPU load, review 0011).
  let routedRun;
  const runRouted = new Promise((res) => { routedRun = res; });
  await page.route('**/api/run', async (r) => { routedRun(); await runGate; await r.continue().catch(() => {}); });
  await page.keyboard.press('Control+Enter');
  await Promise.race([runRouted, new Promise((res) => setTimeout(res, 10000))]);
  await page.waitForFunction(() => /Đang sinh dữ liệu/.test(document.getElementById('results-summary').textContent) && !document.getElementById('btn-stop').hidden, null, { timeout: 10000 })
    .catch(() => errors.push('3b: the held preview never showed its running state (Ctrl+Enter lost or the request was not held)'));
  const during = await page.evaluate(() => {
    const head = document.querySelector('.results-head').getBoundingClientRect();
    const bar = document.getElementById('run-progress').getBoundingClientRect();
    return { summary: document.getElementById('results-summary').textContent, json: document.getElementById('btn-dl-json').hidden, h: bar.height, gap: Math.abs(head.bottom - bar.bottom), w: bar.width - head.width };
  });
  check(/Đang sinh dữ liệu/.test(during.summary) && during.json, `no running state (${JSON.stringify(during)})`);
  check(during.h > 0 && during.h <= 3 && during.gap < 1 && Math.abs(during.w) < 1, `progress bar is not a 3 px line on the header edge (${JSON.stringify(during)})`);
  await page.click('#btn-stop');
  releaseRun();
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
    // The response body is held until the smoke releases it (after Dừng), never by a timer.
    window.__bodyGate = new Promise((r) => { window.__releaseBody = r; });
    window.fetch = async (url, opts) => {
      if (String(url).includes('/cancel')) window.__cancels.push(String(url));
      const res = await orig(url, opts);
      if (!String(url).endsWith('/api/run')) return res;
      window.__gotResponse = true;
      const body = new ReadableStream({
        async start(c) {
          await window.__bodyGate;
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
  await page.waitForFunction(() => window.__gotResponse); // the response is here, its body is not
  await page.click('#btn-stop');
  await page.evaluate(() => window.__releaseBody());
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
  await page.context().close();
}

/** Flow 5b: variable picker (0005), then path fields on a seeded workflow. */
async function flowPicker() {
  const page = await newPage('picker');
  await page.goto(base);
  await page.waitForSelector('.step-card[data-id="con"]');
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
  await page.context().close();
}

/** Flows 5c–10: Query sample, autosave / file migration, theme switch with a second tab. */
async function flowFiles() {
  const page = await newPage('files');
  // The validation of the first workflow is held until after the Query sample was previewed: when
  // it lands it is stale and must not wipe the newer issues (0009 review, validateSeq).
  let releaseValidate;
  let heldValidate = null;
  const validateGate = new Promise((res) => { releaseValidate = res; });
  await page.route('**/api/validate', async (r) => {
    if (!heldValidate) {
      heldValidate = r.request();
      await validateGate;
    }
    await r.continue().catch(() => {});
  });
  await page.goto(base);
  await page.waitForSelector('.step-card[data-id="con"]');
  // Query → Chọn bản ghi → Record without an org (0006): sample rows, warning, palette defaults, {{ }} refused.
  await page.click('#sample-items .palette-item:has-text("Contact cho Account có sẵn")');
  await page.waitForSelector('.step-card[data-id="accs"] .tag-sample');
  await page.keyboard.press('Control+Enter');
  const qTab = await page.waitForSelector('.tabs .tab-query[data-query="accs"]', { timeout: 3000 }).catch(() => null);
  check(qTab && /↓ accs · Account \(5\)/.test(await qTab.textContent()), 'no "↓ accs · Account (5)" tab of sample rows');
  check(/accs: 5 bản ghi mẫu/.test(await page.textContent('#results-summary')), 'results summary does not mention the sample rows');
  check(/Contact: 10/.test(await page.textContent('#results-summary')), 'the Query sample did not generate 10 Contacts');
  check(await page.isVisible('.step-card[data-id="accs"].has-warning'), 'no warning on the Query card without an org');
  const staleDone = page.waitForEvent('requestfinished', (q) => q === heldValidate);
  releaseValidate();
  await staleDone;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  check(await page.isVisible('.step-card[data-id="accs"].has-warning'), 'a stale /api/validate response wiped the newer warning of the Query card');
  await page.unroute('**/api/validate');
  // A later validation of the same workflow (name edited and put back) keeps the run's warning.
  const name = await page.inputValue('#wf-name');
  await page.fill('#wf-name', `${name} x`);
  const revalidated = page.waitForResponse((r) => r.url().endsWith('/api/validate'));
  await page.fill('#wf-name', name);
  await revalidated;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  check(await page.isVisible('.step-card[data-id="accs"].has-warning'), 'the validation of the unchanged workflow erased the run\'s Query warning');
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
  const badFile = path.join(fs.mkdtempSync(path.join(smokeTmp, 'f-')), 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ version: 2, steps: [{ id: 'a', type: 'record', config: {} }, 3] }));
  await page.setInputFiles('#file-input', badFile);
  await page.waitForFunction(() => /Không mở được file: steps\[1\]/.test(document.getElementById('toast').textContent));
  check(await page.isVisible('.step-card[data-id="con"]'), 'malformed file replaced the workflow');

  // Opening a v1 file with an unconnected node → report dialog.
  const tmp = path.join(fs.mkdtempSync(path.join(smokeTmp, 'f-')), 'old.json');
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
  const other = await page.context().newPage(); // a second tab follows theme changes through the storage event
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
  await page.context().close();
}

/** Flow 12: dark scheme, Insert confirmations (mocked org and inserts, nothing written). */
async function flowDark() {
  const d = await newPage('dark', { colorScheme: 'dark' });
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
  await d.context().close();
}

// ---------- 13. screen layout (design 0009) ----------

/** "Account + Contact" + `opp` (Opportunity, no fields: a warning) + `task` (no sObject, an unnamed field: 2 errors). */
async function issuesWorkflow() {
  const { SAMPLES } = await import(pathToFileURL(path.join(root, 'client/js/samples.js')).href);
  const wf = structuredClone(SAMPLES[0].workflow);
  wf.steps.push(
    { id: 'opp', type: 'record', config: { sobject: 'Opportunity', alias: 'opp', count: 1, fields: [] } },
    { id: 'task', type: 'record', config: { sobject: '', alias: 'task', count: 1, fields: [{ name: '', type: 'text', options: {} }] } },
  );
  return wf;
}

/** Storage of a fresh context before the first load (kept across reloads): workflow and selected org. */
async function seedStorage(page, { workflow, org }) {
  await page.addInitScript(({ wf, o }) => {
    if (localStorage.getItem('smoke.seeded')) return;
    if (wf) localStorage.setItem('sfdg.workflow.v2', JSON.stringify(wf));
    if (o) localStorage.setItem('sfdg.org', o);
    localStorage.setItem('smoke.seeded', '1');
  }, { wf: workflow, o: org });
}

/** Waits until CSS transitions (sheet, toast) are over: no fixed timeouts. */
const settle = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

/** Top bar measurements at the current viewport. */
const topbarBox = (page) => page.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const visible = (s) => {
    const x = r(s);
    return x.width > 0 && x.left >= 0 && x.right <= innerWidth + 0.5 && x.bottom <= innerHeight;
  };
  return {
    h: r('.topbar').height, overflow: document.documentElement.scrollWidth - innerWidth,
    org: visible('#org-select'), preview: visible('#btn-preview'), insert: visible('#btn-insert'), theme: r('#theme-select').width,
  };
});

/** 13a (issues bar), 13b (top bar, wide widths), 13e (download buttons at 1440). */
async function flowLayoutWide() {
  const page = await newPage('0009 wide');
  await mockOrgs(page, LONG_ORGS);
  await seedStorage(page, { workflow: await issuesWorkflow(), org: LONG_ORGS[0].alias });
  await page.goto(base);
  await page.waitForSelector('#issues:not([hidden]) .issue.error');
  await page.waitForFunction((o) => document.getElementById('org-select').value === o, LONG_ORGS[0].alias);
  // The aria-live count is only rewritten when it changes: an edit that keeps "2 lỗi · 1 cảnh báo"
  // must not re-announce it after the background validation.
  await page.evaluate(() => {
    window.__countMutations = 0;
    new MutationObserver(() => { window.__countMutations++; }).observe(document.getElementById('issues-count'), { childList: true, subtree: true, characterData: true });
  });
  const validated = page.waitForResponse((r) => r.url().endsWith('/api/validate'));
  await page.fill('#wf-name', 'Account + Contact 2');
  await validated;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  check((await page.evaluate(() => window.__countMutations)) === 0, 'the issues count (aria-live) was rewritten although it did not change');

  // 13a: the bar is in the flow under the canvas, no card under it; on a short (landscape phone)
  // screen it takes at most a quarter of the middle column and stays above the results header.
  for (const [width, height] of [[844, 390], [1440, 900], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    const m = await page.evaluate(() => {
      const bar = document.getElementById('issues');
      const ib = bar.getBoundingClientRect();
      const pb = document.getElementById('process').getBoundingClientRect();
      const under = [...document.querySelectorAll('#process .step-card')].filter((c) => {
        const r = c.getBoundingClientRect();
        const top = Math.max(r.top, pb.top);
        const bottom = Math.min(r.bottom, pb.bottom); // the part of the card the canvas shows
        return bottom > top && bottom > ib.top + 0.5 && top < ib.bottom && r.right > ib.left && r.left < ib.right;
      }).map((c) => c.dataset.id);
      const col = document.querySelector('.view-wrap').getBoundingClientRect();
      const results = document.querySelector('.results-head').getBoundingClientRect();
      return {
        under, gap: ib.top - pb.bottom, position: getComputedStyle(bar).position, rows: bar.querySelectorAll('.issue').length,
        h: ib.height, col: col.height, below: ib.bottom - Math.min(col.bottom, results.top), brand: getComputedStyle(document.querySelector('.brand')).display,
      };
    });
    check(!m.under.length && m.gap >= -0.5 && m.position !== 'absolute' && m.rows === 3, `${width}px: issues bar covers cards or floats (${JSON.stringify(m)})`);
    check(m.below <= 0.5 && m.h <= Math.max(0.25 * m.col, 33) + 0.5, `${width}px: issues bar taller than a quarter of the middle column or under the results header (${JSON.stringify(m)})`);
    // < 1 300 px the app name goes (the bar fits one row only without it).
    check((m.brand === 'none') === (width < 1300), `${width}px: app name display ${m.brand}`);
    const tb = await topbarBox(page);
    check(tb.h <= (width >= 1280 ? 50 : 90), `${width}px: top bar is ${tb.h}px high with a long org label`);
    check(tb.org && tb.preview && tb.insert && tb.overflow <= 0, `${width}px: Org / Xem trước / Insert not all visible (${JSON.stringify(tb)})`);
    check(Math.abs(tb.theme - 32) < 0.5, `${width}px: theme select is ${tb.theme}px wide (32 expected)`);
    if (width === 1280 && outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1280-issues.png') });
  }
  // F8 walks the rows in order and wraps; Shift+F8 goes back.
  const selected = () => page.$eval('.step-card.selected', (c) => c.dataset.id).catch(() => null);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('F8');
    seen.push(await selected());
  }
  check(seen.join() === 'task,task,opp,task', `F8 order ${seen.join()} (task, task, opp, then back to task)`);
  check((await page.$$('#issues .issue.current')).length === 1, 'F8 does not mark the current row');
  await page.keyboard.press('Shift+F8');
  check((await selected()) === 'opp', 'Shift+F8 did not go back to the last row (opp)');
  // Collapse: one 32 px row, kept after a reload; its first line jumps to the first issue.
  await page.click('#btn-issues-toggle');
  const collapsed = () => page.evaluate(() => ({
    h: document.getElementById('issues').getBoundingClientRect().height,
    expanded: document.getElementById('btn-issues-toggle').getAttribute('aria-expanded'),
    first: document.getElementById('issues-first').hidden ? '' : document.getElementById('issues-first').textContent,
  }));
  let c = await collapsed();
  check(c.h <= 40 && c.expanded === 'false' && /\[task\] Chưa nhập sObject/.test(c.first), `collapsed issues bar (${JSON.stringify(c)})`);
  await page.reload();
  await page.waitForSelector('#issues:not([hidden])');
  c = await collapsed();
  check(c.h <= 40 && c.expanded === 'false', `collapsed state not kept after reload (${JSON.stringify(c)})`);
  await page.click('#issues-first');
  check((await selected()) === 'task', 'the collapsed first line did not go to its step');
  // A run that fails validation expands the bar (background validation never does).
  await page.click('.step-card[data-id="opp"] .type');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#issues:not(.collapsed)', { timeout: 3000 }).catch(() => errors.push('the issues bar did not expand when the run failed validation'));
  check((await selected()) === 'task', 'a failed run did not select the first step with an error');
  // 13e (wide): both download buttons, no "⤓ Tải".
  await page.setViewportSize({ width: 1440, height: 900 });
  const dl = await page.evaluate(() => ['btn-dl-json', 'btn-dl-csv', 'btn-dl-menu'].map((id) => document.getElementById(id).getBoundingClientRect().width > 0));
  check(dl.join() === 'true,true,false', `1440px: download buttons ${dl} (JSON, CSV shown; ⤓ Tải hidden)`);
  // N5: a selection on a wide screen does not pop a sheet open when the window gets narrow.
  await page.setViewportSize({ width: 800, height: 900 });
  await settle(page);
  const narrowed = await page.evaluate(() => {
    const insp = document.getElementById('inspector');
    return { open: insp.classList.contains('open'), top: insp.getBoundingClientRect().top, inert: insp.inert, sheet: document.body.classList.contains('sheet-open') };
  });
  check(!narrowed.open && !narrowed.sheet && narrowed.inert && narrowed.top >= 899, `narrowing the window popped the sheet open (${JSON.stringify(narrowed)})`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.getElementById('inspector').inert, null, { timeout: 2000 }).catch(() => errors.push('the inspector stays inert on a wide screen'));
  const theme = await page.evaluate(() => ({ title: document.getElementById('theme-select').title, color: getComputedStyle(document.querySelector('#theme-select option')).color }));
  check(theme.title === 'Giao diện: Theo hệ thống' && !/rgba\(0, 0, 0, 0\)|transparent/.test(theme.color), `theme select title/option colour (${JSON.stringify(theme)})`);
  await page.context().close();
}

/** 11 (narrow sheet), 13b (top bar at 390/360), 13c (⋯ menu, Seed chip), 13d (sheet), 13e (results header). */
async function flowLayoutNarrow() {
  const m = await newPage('390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await mockOrgs(m, LONG_ORGS);
  await seedStorage(m, { org: LONG_ORGS[0].alias });
  await m.goto(base);
  await m.waitForSelector('.step-card[data-id="con"]');
  await m.waitForFunction((o) => document.getElementById('org-select').value === o, LONG_ORGS[0].alias);
  // 11 + 13b: no horizontal overflow, two rows at most, Org / Xem trước / Insert visible.
  for (const [width, height] of [[360, 740], [390, 844]]) {
    await m.setViewportSize({ width, height });
    const tb = await topbarBox(m);
    check(tb.h <= 90 && tb.overflow <= 0 && tb.org && tb.preview && tb.insert, `${width}px top bar (${JSON.stringify(tb)})`);
  }
  if (outDir) {
    await m.screenshot({ path: path.join(outDir, 'smoke-390.png') });
    await m.screenshot({ path: path.join(outDir, 'smoke-390-topbar.png'), clip: { x: 0, y: 0, width: 390, height: 160 } });
  }
  const sheet = () => m.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { card: r('.step-card[data-id="con"]').bottom, sheet: r('#inspector').top, canvas: r('#process').top, palette: r('.palette').bottom, open: document.getElementById('inspector').classList.contains('open') };
  });
  // 11 + 13d: the sheet opens with the card just above its edge.
  await m.tap('.step-card[data-id="con"] .type');
  await m.waitForSelector('#inspector.open');
  await settle(m);
  let s = await sheet();
  check(s.card <= s.sheet + 0.5 && s.sheet - s.canvas >= 190, `390px: sheet covers the selected card or leaves < 190px of canvas (${JSON.stringify(s)})`);
  if (outDir) await m.screenshot({ path: path.join(outDir, 'smoke-390-sheet.png') });
  // "‹ Xong" by keyboard: focus goes to the selected card, the closed sheet is inert.
  await m.focus('#inspector .sheet-close');
  await m.keyboard.press('Enter');
  const closed = await m.evaluate(() => ({ open: document.getElementById('inspector').classList.contains('open'), inert: document.getElementById('inspector').inert, focus: document.activeElement?.dataset.id ?? document.activeElement?.id }));
  check(!closed.open && closed.inert && closed.focus === 'con', `"‹ Xong" (${JSON.stringify(closed)}: closed, inert, focus on the card expected)`);

  // 13c: the ⋯ menu holds what the phone top bar hides, plus Mẫu.
  await m.tap('#btn-more');
  const menu = await m.evaluate(() => ({
    // ARIA: inside role=menu only menu items, groups and aria-hidden text; inputs only inside a group.
    aria: [...document.querySelectorAll('.popup[role="menu"] *')].filter((e) => !e.closest('[role="group"], [role^="menuitem"], [aria-hidden="true"]')
      && ([...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || e.matches('input'))).map((e) => e.outerHTML.slice(0, 60)),
    items: [...document.querySelectorAll('.popup .popup-item')].map((b) => b.textContent),
    seed: Boolean(document.querySelector('.popup input[data-field="seed"]')),
    radio: document.querySelector('.popup [role="group"][aria-label="Giao diện"] [role="menuitemradio"][aria-checked="true"]')?.textContent ?? '',
  }));
  const want = ['Mới', 'Mở…', 'Lưu', 'Account + Contact', 'Tối'];
  check(want.every((w) => menu.items.some((x) => x.includes(w))) && menu.seed && /Theo hệ thống/.test(menu.radio), `⋯ menu at 390px (${JSON.stringify(menu)})`);
  check(!menu.aria.length, `text or input directly inside role=menu: ${menu.aria.join(' | ')}`);
  await m.fill('.popup input[data-field="seed"]', '42');
  check((await m.inputValue('#seed')) === '42', 'the Seed field of the ⋯ menu does not set #seed');
  await m.keyboard.press('Enter');
  check(!(await m.$('.popup')) && (await m.isVisible('#seed-chip')) && (await m.textContent('#seed-chip')) === 'Seed 42', 'no "Seed 42" chip after typing the seed in the menu');
  await m.tap('#seed-chip');
  check(await m.evaluate(() => document.activeElement?.dataset.field === 'seed'), 'the Seed chip does not open the menu on the Seed field');
  await m.keyboard.press('Escape');
  check(await m.evaluate(() => document.activeElement?.id === 'seed-chip'), 'Esc in the menu opened from the Seed chip did not return focus to the chip');
  // Tab / Shift+Tab leave the menu back to its button, not to the ends of the page.
  for (const key of ['Tab', 'Shift+Tab']) {
    await m.tap('#btn-more');
    await m.focus('.popup input[data-field="seed"]');
    await m.keyboard.press(key);
    const after = await m.evaluate(() => ({ open: Boolean(document.querySelector('.popup')), focus: document.activeElement?.id }));
    check(!after.open && after.focus === 'btn-more', `${key} in the ⋯ menu (${JSON.stringify(after)})`);
  }
  await m.tap('#btn-more');
  await m.tap('.popup .popup-item:has-text("Lead theo xác suất")');
  await m.waitForSelector('.step-card[data-id="lead"]');
  await m.tap('#btn-more');
  await m.tap('.popup .popup-item:has-text("Account + Contact")');
  await m.waitForSelector('.step-card[data-id="acc"]');
  await m.setViewportSize({ width: 800, height: 900 });
  await m.click('#btn-more');
  const groups = await m.$$eval('.popup .popup-group', (n) => n.map((x) => x.textContent));
  // 0011: "Lịch sử insert" sits in a Chạy group of the ⋯ menu (≤ 900 px).
  check(groups.join() === 'Chạy,Mẫu', `800px: ⋯ menu groups ${groups} (Chạy with Lịch sử insert, then Mẫu)`);
  await m.keyboard.press('Escape');
  await m.setViewportSize({ width: 390, height: 844 });

  // 13d: a run closes the sheet (selection kept) so the results show. Started with Ctrl+Enter in a
  // field of the sheet, focus must leave the hidden form: typing afterwards edits nothing.
  await m.tap('.step-card[data-id="con"] .type');
  await m.waitForSelector('#inspector.open');
  await m.focus('#inspector input[data-key="alias"]');
  await m.keyboard.press('Control+Enter');
  await m.waitForSelector('table.data tbody tr');
  await settle(m);
  s = await sheet();
  const table = await m.evaluate(() => {
    const r = document.querySelector('table.data').getBoundingClientRect();
    // Not under the sheet: above its top edge (off screen once closed).
    return r.height > 0 && r.top < Math.min(innerHeight, document.getElementById('inspector').getBoundingClientRect().top);
  });
  check(!s.open && (await m.isVisible('.step-card.selected[data-id="con"]')) && table, `Xem trước with the sheet open (${JSON.stringify(s)}, table ${table})`);
  const typedIn = await m.evaluate(() => ({ inSheet: document.getElementById('inspector').contains(document.activeElement), inert: document.getElementById('inspector').inert }));
  await m.keyboard.type('ZZ');
  check(!typedIn.inSheet && typedIn.inert && (await m.inputValue('#inspector input[data-key="alias"]')) === 'con', `typing after a run edited the hidden sheet (${JSON.stringify(typedIn)})`);
  // 13e: one-row results header, "⤓ Tải" menu with the two downloads.
  const head = await m.evaluate(() => ({ h: document.querySelector('.results-head').getBoundingClientRect().height, expanded: document.getElementById('btn-results-toggle').getAttribute('aria-expanded') }));
  check(head.h <= 50 && head.expanded === 'true', `390px results header after Xem trước (${JSON.stringify(head)})`);
  await m.tap('#btn-dl-menu');
  const dl = await m.$$eval('.popup .popup-item', (n) => n.map((x) => x.textContent));
  check(dl.join('|') === 'Tải JSON|Tải CSV (tab hiện tại)', `⤓ Tải menu: ${dl.join('|')}`);
  await m.keyboard.press('Escape');
  // The selected card reopens the sheet; "‹ Xong" sticks to its top; a toast sits above it.
  await m.tap('.step-card[data-id="con"] .type');
  await m.waitForSelector('#inspector.open');
  await settle(m);
  const stuck = await m.evaluate(() => {
    const insp = document.getElementById('inspector');
    insp.scrollTop = insp.scrollHeight;
    const a = insp.getBoundingClientRect();
    const b = insp.querySelector('.sheet-close').getBoundingClientRect();
    return insp.scrollTop > 0 && b.top >= a.top - 0.5 && b.bottom <= a.bottom;
  });
  check(stuck, '"‹ Xong" scrolls away with the sheet');
  await m.keyboard.press('F8'); // nothing to go to: a toast
  await m.waitForSelector('#toast.show');
  await settle(m);
  const toastBox = await m.evaluate(() => ({ toast: document.getElementById('toast').getBoundingClientRect().bottom, sheet: document.getElementById('inspector').getBoundingClientRect().top }));
  check(toastBox.toast <= toastBox.sheet + 0.5, `toast over the sheet (${JSON.stringify(toastBox)})`);
  // Landscape phone: the sheet leaves at least one card's height (60 px) of canvas.
  await m.setViewportSize({ width: 844, height: 390 });
  await settle(m);
  s = await sheet();
  check(s.sheet >= s.palette + 60 - 0.5 && s.sheet - s.canvas >= 60 - 0.5, `844×390: less than 60 px of canvas above the sheet (${JSON.stringify(s)})`);
  await m.tap('#btn-more');
  check(await m.$('.popup .popup-item:has-text("Thu gọn tất cả")'), '844×390: "Thu gọn tất cả" is neither on screen nor in the ⋯ menu');
  await m.keyboard.press('Escape');
  await m.setViewportSize({ width: 390, height: 844 });
  await m.tap('#inspector .sheet-close');

  // Going to an issue on a phone: the card ends up fully between the palette and the sheet.
  await m.evaluate((wf) => localStorage.setItem('sfdg.workflow.v2', JSON.stringify(wf)), await issuesWorkflow());
  await m.reload();
  await m.waitForSelector('#issues:not([hidden]) .issue.error');
  const cardBetween = (id) => m.evaluate((id) => {
    const c = document.querySelector(`.step-card[data-id="${id}"]`).getBoundingClientRect();
    const top = Math.max(document.getElementById('process').getBoundingClientRect().top, document.querySelector('.palette').getBoundingClientRect().bottom);
    return { card: [c.top, c.bottom], top, sheet: document.getElementById('inspector').getBoundingClientRect().top, ok: c.top >= top - 0.5 && c.bottom <= document.getElementById('inspector').getBoundingClientRect().top + 0.5 };
  }, id);
  for (const [width, height, row, id] of [[390, 844, '.issue.error >> nth=0', 'task'], [844, 390, '.issue.warning', 'opp']]) {
    await m.setViewportSize({ width, height });
    if (await m.$('#inspector.open')) await m.tap('#inspector .sheet-close');
    await m.tap(`#issues ${row}`);
    await m.waitForSelector('#inspector.open');
    await settle(m);
    const b = await cardBetween(id);
    check(b.ok, `${width}×${height}: after tapping its issue, "${id}" is not fully visible above the sheet (${JSON.stringify(b)})`);
  }
  await m.setViewportSize({ width: 390, height: 844 });
  if (outDir) {
    await m.tap('#inspector .sheet-close');
    await m.emulateMedia({ colorScheme: 'dark' });
    await settle(m);
    await m.screenshot({ path: path.join(outDir, 'smoke-390-dark.png') });
  }
  await m.context().close();
}

/**
 * Flow 14: Lặp "Mỗi bản ghi trong pool" without an org (design 0010): the sample previews 15
 * Contacts with "5 lần lặp" on the loop; "⋯ → Lặp qua từng bản ghi" on the Query inserts a filled
 * each-loop (one undo); switching a new Lặp to "Mỗi bản ghi trong pool" fills pool and name;
 * a Contact moved out of the loop gets the outsideLoop error on AccountId.
 */
async function flowEach() {
  const page = await newPage('each');
  await page.goto(base);
  await page.waitForSelector('.step-card');
  await page.click('#sample-items .palette-item:has-text("Contact cho mỗi Account có sẵn")');
  const loopCard = '.step-card[data-id="eachAcc"]';
  await page.waitForSelector(loopCard);
  check(await page.textContent(`${loopCard} .alias`) === 'acc', 'the each-loop card does not show the record name "acc"');
  check(await page.textContent(`${loopCard} .sum`) === 'Mỗi bản ghi trong accs → acc · {{loop.index}}', `each-loop summary: ${await page.textContent(`${loopCard} .sum`)}`);
  await page.keyboard.press('Control+Enter');
  const chip = await page.waitForSelector(`${loopCard} .stat`, { timeout: 3000 }).catch(() => null);
  check(chip && (await chip.textContent()) === '5 lần lặp', `each-loop chip: ${chip && await chip.textContent()}`);
  check(/Contact: 15/.test(await page.textContent('#results-summary')), 'the each-loop sample did not generate 15 Contacts');

  // ⋯ on the Query card → "Lặp qua từng bản ghi": a filled Lặp right after it, selected.
  await page.click('.step-card[data-id="accs"] .menu-btn');
  await page.click('.popup [role="menuitem"]:has-text("Lặp qua từng bản ghi")');
  await page.waitForSelector('#inspector select[data-key="from"]');
  const filled = await page.evaluate(() => ({
    mode: document.querySelector('#inspector select[data-key="mode"]').value,
    from: document.querySelector('#inspector select[data-key="from"]').value,
    item: document.querySelector('#inspector input[data-key="itemAlias"]').value,
    count: document.querySelector('#inspector [data-key="count"]').closest('.form-row').hidden,
    next: (() => { const ids = [...document.querySelectorAll('#process .step[data-step]')].map((e) => e.dataset.step); return ids[ids.indexOf('accs') + 1]; })(),
    selected: document.querySelector('.step-card.selected')?.dataset.id,
  }));
  check(filled.mode === 'each' && filled.from === 'accs' && filled.item === 'acc2' && filled.count, `⋯ → Lặp qua từng bản ghi: ${JSON.stringify(filled)}`);
  check(filled.selected && filled.selected === filled.next, `the new each-loop is not selected right after accs (${JSON.stringify(filled)})`);
  const fromText = await page.$eval('#inspector select[data-key="from"] option:checked', (o) => o.textContent);
  check(fromText === 'accs (Account · đọc từ org)', `"Lặp qua pool" option: ${fromText}`);
  await page.keyboard.press('Escape');
  await page.click('#btn-undo');
  check(!(await page.$(`.step-card[data-id="${filled.selected}"]`)), 'one undo did not remove the inserted each-loop');

  // A Lặp from the palette switched to "Mỗi bản ghi trong pool": pool and name are filled.
  await page.click('.step-card[data-id="accs"] .type');
  await page.click('#palette-items .palette-item[data-type="loop"]');
  await page.waitForSelector('#inspector select[data-key="mode"]');
  await page.selectOption('#inspector select[data-key="mode"]', 'each');
  await page.waitForFunction(() => document.querySelector('#inspector input[data-key="itemAlias"]')?.value === 'acc2', null, { timeout: 3000 }).catch(() => {});
  const switched = await page.evaluate(() => [document.querySelector('#inspector select[data-key="from"]').value, document.querySelector('#inspector input[data-key="itemAlias"]').value]);
  check(switched.join() === 'accs,acc2', `switching to each did not fill from / itemAlias (${switched})`);
  await page.click('#btn-undo');
  await page.click('#btn-undo');

  // Renaming the record looped over moves the references inside the body.
  await page.click(`${loopCard} .type`);
  await page.fill('#inspector input[data-key="itemAlias"]', 'a');
  const con = await page.evaluate(() => JSON.parse(localStorage.getItem('sfdg.workflow.v2')).steps[1].slots.body[0].config.fields);
  check(con.find((f) => f.name === 'AccountId')?.options.ref === 'a' && /\{\{a\.Name\}\}/.test(con.find((f) => f.name === 'Title')?.options.template), `itemAlias rename did not follow: ${JSON.stringify(con)}`);
  await page.click('#btn-undo');

  // The Contact moved out of the loop: AccountId points at "acc" outside its loop.
  await page.click('.step-card[data-id="con"] .type');
  await page.keyboard.press('Alt+ArrowUp');
  const err = await page.waitForSelector('.step-card[data-id="con"].has-error', { timeout: 3000 }).catch(() => null);
  check(err, 'the Contact moved out of the each-loop has no error badge');
  const issue = await page.textContent('#issues');
  check(/"acc" là bản ghi đang lặp của bước Lặp phía trên, chỉ dùng được bên trong vòng lặp đó/.test(issue), 'no outsideLoop message for the record looped over');

  // Review fixes N6 / N7: a pool made in a finished fixed loop is not labelled "bản ghi cuối" in a
  // pool dropdown; inside a loop over each record of a Query, the picker's pool group points at
  // the record looped over instead of "dùng bước Chọn bản ghi".
  const tpl = (name) => ({ name, type: 'template', options: { template: 'x' } });
  const wfN = { version: 2, name: 'review', steps: [
    { id: 'accs', type: 'query', config: { sobject: 'Account', alias: 'accs', fields: ['Id', 'Name'] } },
    { id: 'l', type: 'loop', config: { count: 2, alias: 'i' }, slots: { body: [{ id: 'acc', type: 'record', config: { sobject: 'Account', alias: 'acc', fields: [tpl('Name')] } }] } },
    { id: 'e', type: 'loop', config: { mode: 'each', from: 'acc', itemAlias: 'a' }, slots: { body: [{ id: 'c', type: 'record', config: { sobject: 'Contact', alias: 'c', fields: [tpl('LastName')] } }] } },
    { id: 'e2', type: 'loop', config: { mode: 'each', from: 'accs', itemAlias: 'row', alias: 'k' }, slots: { body: [{ id: 'c2', type: 'record', config: { sobject: 'Contact', alias: 'c2', fields: [tpl('Title')] } }] } },
  ] };
  await page.evaluate((w) => localStorage.setItem('sfdg.workflow.v2', JSON.stringify(w)), wfN);
  await page.reload();
  await page.click('.step-card[data-id="e"] .type');
  const accOpt = await page.$eval('#inspector select[data-key="from"] option:checked', (o) => o.textContent);
  check(accOpt === 'acc (Account · đã sinh)', `pool option of a record made in a finished loop: ${accOpt}`);
  await page.click('.step-card[data-id="c2"] .type');
  const t2 = '#inspector .field-card[data-field="fields.Title"]';
  await page.click(`${t2} .actions button[title="Tùy chọn"]`);
  await page.click(`${t2} .var-btn`);
  await page.waitForSelector('.var-picker .vp-item');
  const note = await page.$eval('.var-picker .vp-group[aria-label^="accs "] .vp-note', (n) => n.textContent).catch(() => null);
  check(note === 'không có bản ghi hiện tại: dùng bản ghi đang lặp "row"', `picker note of the pool looped over: ${note}`);
  await page.context().close();
}

/** Flow 15: the Sơ đồ view (design 0003 đợt B, + review fixes). Own contexts (wide, then phone). */
async function flowCanvas() {
  const page = await newPage('canvas');
  // The empty-slot labels come from the catalogue (review nit): a different `empty` text for Lặp.
  await page.route('**/api/meta', async (route) => {
    const meta = await (await route.fetch()).json();
    meta.nodeTypes.find((t) => t.type === 'loop').slots[0].empty = 'Thêm bước vào thân Lặp';
    await route.fulfill({ json: meta });
  });
  await page.goto(base);
  await page.fill('#wf-name', 'Sơ đồ'); // an edit writes the autosave the checks read
  await page.waitForSelector('#process .step-card[data-id="con"]');
  // Enter on a focused ⋯ opens the step menu, not the inspector (review S5, Quy trình).
  await page.focus('#process .step-card[data-id="con"] .menu-btn');
  await page.keyboard.press('Enter');
  check(await page.isVisible('.popup'), 'Quy trình: Enter on a focused ⋯ did not open the step menu');
  await page.keyboard.press('Escape');
  await page.click('#process .step-card[data-id="con"] .type');
  await page.keyboard.press('m');
  await page.waitForSelector('#canvas .step-card[data-id="con"]');
  const inView = (id) => page.evaluate((i) => {
    const c = document.querySelector(`#canvas .step-card[data-id="${i}"]`);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const v = document.getElementById('canvas').getBoundingClientRect();
    return { inside: r.left >= v.left && r.top >= v.top && r.right <= v.right && r.bottom <= v.bottom, selected: c.classList.contains('selected'), focused: document.activeElement === c };
  }, id);
  const focusedId = () => page.evaluate(() => document.activeElement?.closest?.('#canvas .step-card')?.dataset.id ?? document.activeElement?.tagName);
  const v = await inView('con');
  check(v?.inside && v.selected && v.focused, `M: con not selected / focused / inside the diagram (${JSON.stringify(v)})`);
  const sw = await page.evaluate(() => ({
    process: document.querySelectorAll('#process *').length, hidden: document.getElementById('process').hidden,
    pressed: document.querySelector('.view-switch [data-view="canvas"]').getAttribute('aria-pressed'), saved: localStorage.getItem('sfdg.view'),
    tree: document.getElementById('canvas').getAttribute('role'),
    // One tab stop in the tree (review): the selected card; "+", ⋯ and badges are reached with keys.
    tabStops: [...document.querySelectorAll('#canvas [tabindex], #canvas button')].filter((e) => e.tabIndex >= 0).map((e) => e.dataset.id ?? e.className),
    posinset: document.querySelector('#canvas .step-card[data-id="con"]').getAttribute('aria-posinset'),
    zoomLabel: document.getElementById('btn-zoom-reset').getAttribute('aria-label'),
  }));
  check(sw.process === 0 && sw.hidden && sw.pressed === 'true' && sw.saved === 'canvas' && sw.tree === 'tree' && sw.tabStops.join() === 'con' && sw.posinset === '1' && /100%/.test(sw.zoomLabel), `switch state ${JSON.stringify(sw)}`);
  // Enter on a focused "+" opens its menu (review S5) → Record, added right after con.
  const count = () => page.evaluate(() => (JSON.stringify(JSON.parse(localStorage.getItem('sfdg.workflow.v2')).steps).match(/"type":"record"/g) ?? []).length);
  const before = await count();
  await page.focus('#canvas button.dg-add[aria-label="Thêm bước sau \\"con\\""]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.popup', { timeout: 2000 }).catch(() => errors.push('Enter on a focused "+" did not open the menu'));
  await page.click('.popup [role="menuitem"][data-type="record"]');
  const added = await page.waitForFunction(() => {
    const id = document.querySelector('#canvas .step-card.selected')?.dataset.id;
    const wf = JSON.parse(localStorage.getItem('sfdg.workflow.v2'));
    const find = (list) => { for (const s of list) { for (const k of Object.keys(s.slots ?? {})) { const at = s.slots[k].findIndex((x) => x.id === id); if (at >= 0) return { prev: s.slots[k][at - 1]?.id, type: s.slots[k][at].type }; const deep = find(s.slots[k]); if (deep) return deep; } } return null; };
    return id && id !== 'con' && find(wf.steps);
  }, null, { timeout: 3000 }).then((x) => x.jsonValue()).catch(() => null);
  check(added?.prev === 'con' && added.type === 'record' && (await count()) === before + 1, `"+" after con did not add a Record there (${JSON.stringify(added)})`);
  const newId = await page.$eval('#canvas .step-card.selected', (c) => c.dataset.id);
  const nv = await inView(newId);
  check(nv?.inside && nv.focused, `the new step is not inside the viewport / focused (${JSON.stringify(nv)})`);
  await page.keyboard.press('Delete');
  await page.waitForFunction((id) => !document.querySelector(`#canvas .step-card[data-id="${id}"]`), newId, { timeout: 3000 }).catch(() => errors.push('Delete did not remove the step from the diagram'));
  check((await count()) === before, 'Delete did not remove the added Record');
  // Focus survives every re-render (review B1): Delete, ↑, Alt+↓ (moves the loop), Ctrl+Z.
  check((await focusedId()) === 'con', `after Delete focus is on ${await focusedId()} (con expected)`);
  await page.keyboard.press('ArrowUp');
  const up = await page.$eval('#canvas .step-card.selected', (c) => ({ id: c.dataset.id, type: c.dataset.type, focused: document.activeElement === c }));
  check(up.type === 'loop' && up.focused, `↑ from con: ${JSON.stringify(up)}`);
  await page.keyboard.press('Alt+ArrowDown');
  check((await focusedId()) === up.id, `after Alt+↓ focus is on ${await focusedId()} (${up.id} expected)`);
  await page.keyboard.press('Control+z');
  check((await focusedId()) === up.id, `after Ctrl+Z focus is on ${await focusedId()} (${up.id} expected)`);
  // F8 to a warning (an empty Lặp from the palette) selects and focuses its card.
  await page.click('#palette-items .palette-item[data-type="loop"]');
  const loopId = await page.$eval('#canvas .step-card.selected', (c) => c.dataset.id);
  await page.waitForSelector('#issues:not([hidden])');
  await page.keyboard.press('Home');
  await page.keyboard.press('F8');
  check((await focusedId()) === loopId, `after F8 focus is on ${await focusedId()} (${loopId} expected)`);
  const emptyLabel = () => page.$eval('.view:not([hidden]) .slot-empty', (b) => b.getAttribute('aria-label')).catch(() => null);
  check(await emptyLabel() === 'Thêm bước vào thân Lặp', `Sơ đồ: empty body label ${await emptyLabel()} (catalogue text expected)`);
  await page.keyboard.press('m');
  await page.waitForSelector('#process .slot-empty');
  check(await emptyLabel() === 'Thêm bước vào thân Lặp', `Quy trình: empty body label ${await emptyLabel()} (catalogue text expected)`);
  await page.keyboard.press('m');
  await page.waitForSelector(`#canvas .step-card[data-id="${loopId}"]:focus`, { timeout: 2000 }).catch(() => errors.push('M back to Sơ đồ: the selected card has no focus'));
  await page.keyboard.press('Delete');
  // The results panel opening (Ctrl+Enter) shrinks the diagram: the selected card stays in view (review nit).
  await page.click('#canvas .step-card[data-id="con"] .type');
  // con just above the bottom edge first, so the smaller diagram would cut it off.
  const low = await page.evaluate(() => {
    const c = document.querySelector('#canvas .step-card[data-id="con"]').getBoundingClientRect();
    const v = document.getElementById('canvas').getBoundingClientRect();
    return { x: v.left + v.width / 2, y: v.top + v.height / 2, dy: c.bottom - (v.bottom - 30) };
  });
  await page.mouse.move(low.x, low.y);
  await page.mouse.wheel(0, low.dy);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('#canvas .step-card[data-id="con"] .stat');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  check((await inView('con'))?.inside, 'the results panel hid the selected card of the diagram');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440-canvas.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === BG.dark, 'Sơ đồ: dark scheme not applied');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440-canvas-dark.png') });
  // M with the Start card selected, there and back: focus follows (review B1).
  await page.keyboard.press('Home');
  await page.keyboard.press('m');
  await page.waitForSelector('#process .start-card.selected');
  await page.keyboard.press('m');
  await page.waitForSelector('#canvas .step-card[data-id="__start"]');
  check((await focusedId()) === '__start', `M with Start selected: focus on ${await focusedId()}`);
  // Background click focuses the diagram, so "+" zooms from the keyboard (review nit).
  const corner = await page.evaluate(() => { const v = document.getElementById('canvas').getBoundingClientRect(); return { x: v.left + 12, y: v.bottom - 12 }; });
  await page.mouse.click(corner.x, corner.y);
  await page.keyboard.press('+');
  check(await page.textContent('#btn-zoom-reset') === '125%', `+ after a background click: zoom ${await page.textContent('#btn-zoom-reset')}`);
  // Another workflow starts at 100 % with its Start card at the left, wherever the old one was panned (review S2).
  for (let i = 0; i < 6; i++) await page.mouse.wheel(500, 300);
  await page.click('#sample-items .palette-item:has-text("Contact cho Account có sẵn")');
  await page.waitForFunction(() => document.querySelector('.dg-world').style.transform.startsWith('translate(0px'), null, { timeout: 2000 }).catch(() => errors.push('loading a sample kept the old pan'));
  check((await inView('__start'))?.inside && await page.textContent('#btn-zoom-reset') === '100%', 'after loading a sample the Start card is not in view at 100 %');
  // Type labels are not cut ("Query (đọc org)" next to its alias and badge, review nit).
  const cut = await page.$$eval('#canvas .type-label', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent));
  check(!cut.length && await page.isVisible('#canvas .step-card[data-type="query"]'), `truncated type labels: ${cut}`);
  // Panning far away leaves part of the diagram on screen (review S2).
  await page.mouse.move(low.x, low.y);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(-3000, -3000);
  const left = await page.evaluate(() => {
    const v = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('#canvas .step-card')].some((c) => { const r = c.getBoundingClientRect(); return r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom; });
  });
  check(left, 'panning far away left no card on screen');
  await page.context().close();

  // Phone: the saved Sơ đồ is not applied; the ⋯ menu offers it and does not save it.
  const m = await newPage('canvas 390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await m.addInitScript(() => { if (!localStorage.getItem('smoke.view')) { localStorage.setItem('sfdg.view', 'canvas'); localStorage.setItem('smoke.view', '1'); } });
  await m.goto(base);
  await m.waitForSelector('#process .step-card[data-id="con"]');
  await m.click('#btn-more');
  await m.click('.popup [role="menuitemradio"]:has-text("Sơ đồ")');
  await m.waitForSelector('#canvas .step-card[data-id="__start"]');
  const phone = await m.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, zoomButtons: [...document.querySelectorAll('.dg-zoom button')].filter((b) => b.offsetWidth).map((b) => b.offsetWidth) }));
  check(phone.overflow <= 0 && phone.zoomButtons.join() === '32', `390px Sơ đồ: overflow ${phone.overflow}px, zoom bar ${phone.zoomButtons} (only ⤢, 32 px)`);
  await m.tap('#canvas .step-card[data-id="__start"] .type');
  await m.waitForSelector('#inspector.open');
  await settle(m);
  const sheet = await m.evaluate(() => ({ card: document.querySelector('#canvas .step-card.selected').getBoundingClientRect().bottom, sheet: document.getElementById('inspector').getBoundingClientRect().top, menu: document.querySelector('#canvas .step-card .menu-btn')?.offsetWidth }));
  check(sheet.card <= sheet.sheet + 0.5, `390px Sơ đồ: the selected card is under the sheet (${JSON.stringify(sheet)})`);
  if (outDir) await m.screenshot({ path: path.join(outDir, 'smoke-390-canvas.png') });
  // 844 × 390 (landscape phone, sheet open): the selected card's top is shown above the sheet and not
  // under the zoom bar (review S3).
  await m.setViewportSize({ width: 844, height: 390 });
  await settle(m);
  await m.keyboard.press('End');
  await m.waitForFunction(() => document.querySelector('#canvas .step-card.selected')?.dataset.id === 'con');
  await m.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const land = await m.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const c = r('#canvas .step-card.selected');
    const z = r('.dg-zoom');
    return { top: c.top, canvas: r('#canvas').top, sheet: r('#inspector').top, underBar: c.left < z.right && c.right > z.left && c.top < z.bottom && c.bottom > z.top, menu: document.querySelector('#canvas .step-card.selected .menu-btn').offsetWidth };
  });
  check(land.top >= land.canvas - 0.5 && land.top + 24 <= land.sheet && !land.underBar && land.menu >= 32, `844×390 Sơ đồ: selected card hidden or small targets (${JSON.stringify(land)})`);
  // A landscape phone counts as a phone: choosing Quy trình there is not saved either.
  await m.click('#btn-more');
  await m.click('.popup [role="menuitemradio"]:has-text("Quy trình")');
  await m.waitForSelector('#process .step-card');
  check(await m.evaluate(() => localStorage.getItem('sfdg.view')) === 'canvas', 'a view chosen on a (landscape) phone was saved');
  await m.context().close();
}

// ---------- 16. insert history and delete (design 0011) ----------

const H1 = 'h20261028T103200Z-a1b2c3';
const H2 = 'h20261028T091500Z-d4e5f6';
const H3 = 'h20261027T080200Z-0a0b0c';
const HIST_ORGS = [
  { alias: 'dev-sb', username: 'me@example.com', isSandbox: true, isScratch: false, connectedStatus: 'Connected' },
  { alias: 'dev-prod', username: 'admin@prod.example.com', isSandbox: false, isScratch: false, connectedStatus: 'Connected' },
];
const histRun = (id, { org, kind, inserted, status = 'done', startedAt }) => ({
  id, status, startedAt, finishedAt: startedAt, org: { alias: org, username: HIST_ORGS.find((o) => o.alias === org).username, orgId: '00D000000000001AAA', kind },
  workflowName: 'Account + Contact', seed: 42, total: inserted, inserted, failed: 0, notSent: 0, bySobject: { Account: 5, Contact: inserted - 5 },
  steps: [{ nodeId: 'acc', alias: 'acc', sobject: 'Account', mode: 'collections', total: 5, inserted: 5, failed: 0 }, { nodeId: 'con', alias: 'con', sobject: 'Contact', mode: 'bulk', total: inserted - 5, inserted: inserted - 5, failed: 0 }],
  bulkJobs: 0, stopped: null, deletion: { status: 'none', deleted: 0, gone: 0, failed: 0, remaining: inserted, lastAt: null },
});
const HIST_RUNS = [
  histRun(H1, { org: 'dev-sb', kind: 'sandbox', inserted: 12005, startedAt: '2026-10-28T10:32:00.000Z' }),
  histRun(H2, { org: 'dev-prod', kind: 'production', inserted: 8, startedAt: '2026-10-28T09:15:00.000Z' }),
  histRun(H3, { org: 'dev-sb', kind: 'sandbox', inserted: 1200, status: 'interrupted', startedAt: '2026-10-27T08:02:00.000Z' }),
];

/** Flow 16 (0011): Bulk in the Insert confirmation, Tải Id / Lịch sử links, "Xóa dữ liệu này…", production name, history dialog. */
async function flowHistory() {
  const page = await newPage('history');
  const sent = { inserts: [], deletes: [], forgets: [] };
  await page.addInitScript(() => { if (!localStorage.getItem('smoke.h')) { localStorage.setItem('sfdg.org', 'dev-sb'); localStorage.setItem('smoke.h', '1'); } });
  // Everything that would touch an org is answered here; nothing reaches the server's (absent) sf CLI.
  await page.route('**/api/**', (r) => {
    const url = new URL(r.request().url());
    const p = url.pathname;
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const nd = (events) => r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
    if (p === '/api/orgs') return json(HIST_ORGS);
    if (/^\/api\/orgs\/[^/]+\/limits$/.test(p)) return json({ api: { max: 15000, remaining: 30 }, bulkBatches: { max: 15000, remaining: 14980 } });
    if (p.startsWith('/api/orgs/')) return json({ error: 'smoke: org giả lập' }, 404);
    if (p === '/api/run') {
      const body = r.request().postDataJSON();
      const stats = { total: 12005, bySobject: { Account: 5, Contact: 12000 }, byStep: { loopAcc: { runs: 1, records: 12005, iterations: 5 }, acc: { runs: 5, records: 5 }, loopCon: { runs: 5, records: 12000, iterations: 12000 }, con: { runs: 12000, records: 12000 } }, durationMs: 1, previewRows: 200, truncated: true };
      const base = { runId: 'rsmoke16', seed: body.seed ?? 42, now: body.now ?? 1761645120000, warnings: [], records: [], samples: {}, stats };
      if (!body.target) return nd([{ type: 'start', runId: 'rsmoke16', seed: base.seed, now: base.now, warnings: [] }, { type: 'done', result: base }]);
      sent.inserts.push(body);
      const insert = { inserted: 12005, failed: 0, errorsTotal: 0, errors: [], errorGroups: [], errorGroupsOther: null, ids: {}, bySobject: { Account: { inserted: 5, failed: 0 }, Contact: { inserted: 12000, failed: 0 } }, notSent: 0, cancelled: false, stopped: null, total: 12005, historyId: H1, bulk: [] };
      return nd([{ type: 'start', runId: 'rsmoke16', seed: base.seed, now: base.now, warnings: [] }, { type: 'plan', total: 12005, bySobject: stats.bySobject, apiCalls: 41, historyId: H1 }, { type: 'done', result: { ...base, insert } }]);
    }
    if (p === '/api/history') return json({ enabled: true, dir: '/home/me/.local/share/sf-data-generator/history', maxRuns: 100, runs: HIST_RUNS });
    if (p === '/api/history/status') return json({ enabled: true, dir: '/home/me/.local/share/sf-data-generator/history', maxRuns: 100, full: false });
    let m;
    if ((m = /^\/api\/history\/([^/]+)\/delete$/.exec(p))) {
      sent.deletes.push({ hid: m[1], body: r.request().postDataJSON() });
      // The production delete leaves one failure on a step that is not in the workflow any more.
      const failed = m[1] === H2 ? 1 : 0;
      const errorGroups = failed ? [{ sobject: 'Contact', nodeId: 'removedStep', message: 'DELETE_FAILED: smoke', count: 1, refs: ['003000000000001AAA'] }] : [];
      return nd([{ type: 'start', runId: 'rsmoked', historyId: m[1], total: 12005, bySobject: { Contact: 12000, Account: 5 } }, { type: 'done', result: { total: 12005, deleted: 12005 - failed, gone: 0, failed, errorGroups, errorGroupsOther: null, bySobject: {}, remaining: failed, cancelled: false, stopped: null, bulkAborted: null } }]);
    }
    if ((m = /^\/api\/history\/([^/]+)\/forget$/.exec(p))) {
      sent.forgets.push(m[1]);
      return json({ ok: true });
    }
    if ((m = /^\/api\/history\/([^/]+)$/.exec(p))) {
      const run = HIST_RUNS.find((x) => x.id === m[1]);
      return json({ ...run, workflowName: run.workflowName, remaining: { total: run.inserted, bySobject: { Contact: run.inserted - 5, Account: 5 }, bySteps: [{ nodeId: 'con', sobject: 'Contact', count: run.inserted - 5 }, { nodeId: 'acc', sobject: 'Account', count: 5 }] }, pendingBulkJobs: [], hasParents: false, errorGroups: [], bulkJobs: [] });
    }
    return r.continue();
  });
  await page.goto(base);
  await page.waitForSelector('.step-card[data-id="con"]');
  await page.waitForFunction(() => document.getElementById('org-select').value === 'dev-sb');

  // 16a. Insert confirmation: Bulk checkbox on, the step line, calls change when unticked, the limit warning.
  await page.click('#btn-insert');
  await page.waitForSelector('dialog[open] .bulk-check input');
  check(await page.isChecked('dialog[open] .bulk-check input'), '16a: Bulk checkbox not ticked by default');
  check(/con \(Contact\) 12 000: 200 bản ghi đầu gửi thử bằng sObject Collections, phần còn lại 2 job Bulk\./.test(await page.textContent('dialog[open] .bulk-steps')), '16a: no Bulk step line');
  const callsOn = await page.textContent('dialog[open] .insert-calls');
  // 30 calls left: enough with Bulk (26), not without (61) — the warning follows the checkbox.
  await page.waitForSelector('dialog[open] .insert-limits:not([hidden])', { timeout: 3000 }).catch(() => errors.push('16a: no "Org còn …" line'));
  check(await page.isHidden('dialog[open] .limits-warn'), '16a: limit warning although Bulk fits the 30 calls left');
  await page.click('dialog[open] .bulk-check input');
  const callsOff = await page.textContent('dialog[open] .insert-calls');
  const num = (t) => Number((/Khoảng ([\d ]+) lời gọi/.exec(t)?.[1] ?? '0').replace(/ /g, ''));
  check(num(callsOff) > num(callsOn) && num(callsOn) > 0, `16a: calls did not grow when Bulk was unticked (${callsOn} → ${callsOff})`);
  await page.waitForSelector('dialog[open] .limits-warn:not([hidden])', { timeout: 3000 }).catch(() => errors.push('16a: no API limit warning with 30 calls left and Bulk off'));
  check(await page.isVisible('dialog[open] .insert-history'), '16a: no history line');
  await page.click('dialog[open] [data-action="confirm-insert"]');
  await page.waitForSelector('#results-summary [data-action="ids"]');
  check(sent.inserts.length === 1 && sent.inserts[0].target.bulk === 'off', `16a: insert request target ${JSON.stringify(sent.inserts[0]?.target)}`);
  check(await page.isVisible('#results-summary [data-action="history"]'), '16a: no Lịch sử link in the summary');
  check((await page.textContent('#toast .toast-action').catch(() => '')) === 'Xóa dữ liệu này…', '16a: no "Xóa dữ liệu này…" on the toast');

  // 16b. Delete from the toast: Hủy has focus, the count, the request carries the confirmation.
  await page.click('#toast .toast-action');
  await page.waitForSelector('dialog[open] [data-action="confirm-delete"]');
  check(await page.evaluate(() => document.activeElement?.dataset.action) === 'cancel', '16b: focus is not on Hủy');
  const delBtn = await page.$('dialog[open] [data-action="confirm-delete"]');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440-delete.png') });
  // Review S5: the cascade warning is always there (the mock says no parent steps).
  check(/có thể làm Salesforce tự xóa cả bản ghi con/.test(await page.textContent('#modal[open] .cascade-line').catch(() => '')), '16b: no cascade warning');
  check((await delBtn.textContent()) === 'Xóa 12 005 bản ghi' && await delBtn.evaluate((b) => b.matches('.danger.solid') && !b.disabled), '16b: delete button text / style / state');
  await delBtn.click();
  await page.waitForFunction(() => /Đã xóa 12 005 bản ghi khỏi dev-sb/.test(document.getElementById('results-summary').textContent));
  check(sent.deletes[0]?.hid === H1 && sent.deletes[0].body.confirm.username === 'me@example.com' && sent.deletes[0].body.confirm.count === 12005, `16b: delete request ${JSON.stringify(sent.deletes[0])}`);

  // 16d (1440). History dialog: filtered on the selected org, interrupted run explained, forget asks first.
  await page.click('#btn-history');
  await page.waitForSelector('dialog.history[open] .history-row');
  check(await page.isChecked('#history-filter'), '16d: org filter not on by default');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-1440-history.png') });
  const shown = await page.$$eval('dialog.history .history-row', (rows) => rows.map((r) => r.dataset.hid));
  check(shown.join() === [H1, H3].join(), `16d: filtered rows ${shown}`);
  check(/Server dừng giữa lúc insert/.test(await page.getAttribute(`.history-row[data-hid="${H3}"] [title^="Server"]`, 'title').catch(() => '') ?? ''), '16d: no title on "Bị gián đoạn"');
  await page.click(`.history-row[data-hid="${H3}"] .history-more`);
  await page.click('.popup [role="menuitem"]:has-text("Quên lần insert này")');
  await page.waitForSelector('#modal[open] [data-action="forget"]');
  check(/Chỉ xóa ghi chép trên máy này, không xóa gì trong org/.test(await page.textContent('#modal[open]')), '16d: forget confirmation text');
  await page.click('#modal[open] [data-action="forget"]');
  await page.waitForFunction(() => !document.querySelector('#modal[open]'));
  check(sent.forgets.join() === H3, `16d: forget request ${sent.forgets}`);

  // 16c. Production: the delete button stays locked until the org name is typed.
  await page.uncheck('#history-filter');
  await page.click(`.history-row[data-hid="${H2}"] [data-action="delete"]`);
  await page.waitForSelector('#modal[open] .typed-org');
  const locked = () => page.$eval('#modal[open] [data-action="confirm-delete"]', (b) => b.disabled);
  check(await locked(), '16c: production delete not locked before typing');
  await page.fill('#modal[open] .typed-org', 'dev-pro');
  check(await locked(), '16c: unlocked by a wrong name');
  await page.fill('#modal[open] .typed-org', 'dev-prod');
  check(!(await locked()), '16c: still locked after typing the alias');
  await page.click('#modal[open] [data-action="confirm-delete"]');
  await page.waitForFunction(() => /Đã xóa/.test(document.getElementById('results-summary').textContent) && document.getElementById('btn-stop').hidden);
  check(sent.deletes[1]?.hid === H2 && sent.deletes[1].body.confirm.typedOrg === 'dev-prod', `16c: production request ${JSON.stringify(sent.deletes[1])}`);
  // "Lỗi xóa" tab: a group of a step not in the workflow is not a button (review nit).
  await page.waitForSelector('table.error-groups tbody tr');
  check(await page.$eval('.tabs .tab-delete-errors.active', (b) => /Lỗi xóa \(1\)/.test(b.textContent)).catch(() => false), '16c: no active "Lỗi xóa (1)" tab');
  check(!(await page.$('table.error-groups tr.clickable, table.error-groups tr[role="button"]')), '16c: an error row of a removed step is still a button');

  // 16d (390). Full-screen dialog, no sideways overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btn-history');
  await page.waitForSelector('dialog.history[open] .history-row');
  const box = await page.evaluate(() => {
    const d = document.querySelector('dialog.history').getBoundingClientRect();
    return { w: d.width, h: d.height, sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, inner: document.querySelector('dialog.history').scrollWidth - document.querySelector('dialog.history').clientWidth };
  });
  check(Math.abs(box.w - box.iw) <= 1 && Math.abs(box.h - box.ih) <= 1 && box.sw === box.iw && box.inner <= 0, `16d 390px: history dialog not full screen or overflowing ${JSON.stringify(box)}`);
  if (outDir) await page.screenshot({ path: path.join(outDir, 'smoke-390-history.png') });
  await page.context().close();
}

/**
 * Flow 17: variables and loops (design 0013), own context. A seeded workflow (no org: sample rows);
 * no fixed waits.
 */
async function flowVarsLoops() {
  const page = await newPage('0013');
  const tpl = (name, template) => ({ name, type: 'template', options: { template } });
  const wf = { version: 2, name: 'smoke 0013', steps: [
    { id: 'q1', type: 'query', config: { sobject: 'Account', alias: 'accs', fields: ['Id', 'Name'] } },
    { id: 'q2', type: 'query', config: { sobject: 'Contact', alias: 'cons', fields: ['Id', 'LastName', 'AccountId'] } },
    { id: 'opp', type: 'record', config: { sobject: 'Opportunity', alias: 'opp', count: 1, fields: [{ name: 'Amount', type: 'currency', options: {} }] } },
    { id: 'la', type: 'loop', config: { mode: 'each', from: 'accs', itemAlias: 'acc' }, slots: { body: [
      { id: 'lc', type: 'loop', config: { mode: 'each', from: 'cons', itemAlias: 'con', alias: 'loop2' }, slots: { body: [
        { id: 'task', type: 'record', config: { sobject: 'Task', alias: 'task', count: 1, fields: [tpl('Subject', '{{con.LastName}}')] } },
      ] } },
    ] } },
    { id: 'lf', type: 'loop', config: { count: 1 }, slots: { body: [{ id: 'ld', type: 'record', config: { sobject: 'Lead', alias: 'ld', count: 1, fields: [tpl('LastName', 'x')] } }] } },
    { id: 'br', type: 'branch', config: { kind: 'compare', left: 'opp.Amount', op: 'gt', right: '' }, slots: { true: [{ id: 'ev', type: 'record', config: { sobject: 'Event', alias: 'ev', count: 1, fields: [] } }], false: [] } },
  ] };
  await seedStorage(page, { workflow: wf });
  await page.goto(base);
  await page.waitForSelector('.step-card[data-id="lf"]');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('sfdg.workflow.v2')));
  const findIn = (steps, id) => {
    for (const s of steps) {
      if (s.id === id) return s;
      for (const list of Object.values(s.slots ?? {})) { const f = findIn(list, id); if (f) return f; }
    }
    return null;
  };
  const cfg = async (id) => findIn((await stored()).steps, id)?.config ?? {};

  // "Số lần lặp" = {x} → accs.$count: only number variables are listed, the card prints the variable.
  await page.click('.step-card[data-id="lf"] .type');
  const count = '#inspector input[data-key="count"]';
  await page.waitForSelector(count);
  check((await page.getAttribute(count, 'inputmode')) === 'numeric', '"Số lần lặp" is not a numeric text field');
  await page.click('#inspector .form-row:has(input[data-key="count"]) .var-btn');
  await page.waitForSelector('.var-picker .vp-item');
  const listed = await page.$$eval('.var-picker .vp-item', (rows) => rows.map((r) => `${r.dataset.path}:${r.querySelector('.vp-type').textContent}`));
  check(listed.length && listed.every((x) => /:(Số|Từ org|Currency)$/.test(x)), `number picker lists non-numbers: ${listed.join(', ')}`);
  check(/Chỉ hiện biến kiểu Số/.test(await page.textContent('.var-picker')), 'number picker has no "Chỉ hiện biến kiểu Số" line');
  await page.keyboard.type('accs.$c');
  await page.keyboard.press('Enter');
  await page.waitForFunction((s) => document.querySelector(s)?.value === '{{accs.$count}}', count, { timeout: 3000 }).catch(() => {});
  check((await page.inputValue(count)) === '{{accs.$count}}', `count after the picker: ${await page.inputValue(count)}`);
  check(await page.$('#inspector .form-row:has(input[data-key="count"]) .var-chip[data-path="accs.$count"]'), 'no chip under "Số lần lặp"');
  await page.waitForFunction(() => /accs/.test(document.querySelector('.step-card[data-id="lf"] .sum')?.textContent), null, { timeout: 3000 }).catch(() => {});
  check((await page.textContent('.step-card[data-id="lf"] .sum')) === '{{accs.$count}} lần · {{loop.index}}', `lf summary: ${await page.textContent('.step-card[data-id="lf"] .sum')}`);

  // Lặp each over cons inside Lặp acc: turning the filter on fills AccountId = {{acc.Id}}; one ↶ undoes both.
  await page.click('.step-card[data-id="lc"] .type');
  await page.waitForSelector('#inspector select[data-key="filter"]');
  await page.selectOption('#inspector select[data-key="filter"]', 'compare');
  await page.waitForFunction(() => document.querySelector('#inspector input[data-key="filterValue"]')?.value === '{{acc.Id}}', null, { timeout: 3000 }).catch(() => {});
  const fill = await page.evaluate(() => [document.querySelector('#inspector input[data-key="filterField"]').value, document.querySelector('#inspector input[data-key="filterValue"]').value]);
  check(fill.join() === 'AccountId,{{acc.Id}}', `parent–child filter not filled: ${fill}`);
  check(/Đã điền điều kiện AccountId = \{\{acc\.Id\}\} \(bản ghi con của "acc"\)/.test(await page.textContent('#toast')), 'no "Đã điền điều kiện" toast');
  await page.click('#btn-undo');
  const undone = await cfg('lc');
  check((undone.filter ?? 'none') === 'none' && !undone.filterField && !undone.filterValue, `one ↶ did not undo the filter and its fill: ${JSON.stringify(undone)}`);

  // Xáo trộn + Tối đa 2: 5 sample accounts × 2.
  await page.click('.step-card[data-id="lc"] .type');
  await page.waitForSelector('#inspector select[data-key="order"]');
  await page.selectOption('#inspector select[data-key="order"]', 'shuffle');
  await page.fill('#inspector input[data-key="limit"]', '2');
  await page.waitForFunction(() => /tối đa 2/.test(document.querySelector('.step-card[data-id="lc"] .sum')?.textContent), null, { timeout: 3000 }).catch(() => {});
  check((await page.textContent('.step-card[data-id="lc"] .sum')) === 'Mỗi bản ghi trong cons → con · xáo trộn · tối đa 2 · {{loop2.index}}', `lc summary: ${await page.textContent('.step-card[data-id="lc"] .sum')}`);
  await page.keyboard.press('Control+Enter');
  const chip = await page.waitForSelector('.step-card[data-id="lc"] .stat', { timeout: 5000 }).catch(() => null);
  check(chip && (await chip.textContent()) === '10 lần lặp', `lc chip: ${chip && await chip.textContent()}`);
  check(/Lead: 5/.test(await page.textContent('#results-summary')), `{{accs.$count}} loops did not make 5 Leads: ${await page.textContent('#results-summary')}`);
  const seed = /seed (\d+)/.exec(await page.textContent('#results-summary'))?.[1];

  // In fixed mode every filter option is hidden (chained showIf), even with filter = compare.
  await page.click('.step-card[data-id="lc"] .type');
  await page.selectOption('#inspector select[data-key="filter"]', 'compare');
  await page.waitForFunction(() => document.querySelector('#inspector input[data-key="filterField"]')?.value === 'AccountId', null, { timeout: 3000 }).catch(() => {});
  await page.selectOption('#inspector select[data-key="mode"]', 'fixed');
  const hidden = await page.evaluate(() => ['filter', 'filterField', 'filterOp', 'filterValue', 'order', 'limit'].map((k) => document.querySelector(`#inspector [data-key="${k}"]`).closest('.form-row').hidden));
  check(hidden.every(Boolean), `filter options shown in fixed mode: ${hidden}`);
  await page.click('#btn-undo');

  // {{run.seed}} in a template has the preview's seed as sample.
  await page.click('.step-card[data-id="task"] .type');
  const subj = '#inspector .field-card[data-field="fields.Subject"]';
  await page.click(`${subj} .actions button[title="Tùy chọn"]`);
  await page.click(`${subj} .var-btn`);
  await page.waitForSelector('.var-picker .vp-item[data-path="run.seed"]');
  const runSample = await page.textContent('.var-picker .vp-item[data-path="run.seed"] .vp-sample');
  check(seed && runSample === seed, `run.seed sample "${runSample}" is not the preview seed ${seed}`);
  await page.keyboard.press('Escape');

  // Rẽ nhánh: {x} at "So với" inserts {{opp.Amount}}.
  await page.click('.step-card[data-id="br"] .type');
  await page.click('#inspector .form-row:has(input[data-key="right"]) .var-btn');
  await page.waitForSelector('.var-picker .vp-item');
  await page.keyboard.type('opp.Am');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#inspector input[data-key="right"]')?.value === '{{opp.Amount}}', null, { timeout: 3000 }).catch(() => {});
  check((await page.inputValue('#inspector input[data-key="right"]')) === '{{opp.Amount}}', `branch right: ${await page.inputValue('#inspector input[data-key="right"]')}`);

  // Lặp "Mỗi giá trị trong danh sách": empty → valuesEmpty on the field; Hot/Warm/Cold → the summary.
  await page.click('#palette-items .palette-item[data-type="loop"]');
  await page.waitForSelector('#inspector select[data-key="mode"]');
  const newId = await page.$eval('.step-card.selected', (c) => c.dataset.id);
  await page.selectOption('#inspector select[data-key="mode"]', 'values');
  const values = '#inspector textarea[data-key="values"]';
  check((await page.getAttribute(values, 'placeholder')) === 'Hot\nWarm\nCold', 'no Hot/Warm/Cold placeholder');
  await page.waitForSelector(`${values}.invalid`, { timeout: 3000 }).catch(() => {});
  check(await page.$(`${values}.invalid`), 'empty values list is not outlined');
  check(/Nhập ít nhất một giá trị, mỗi dòng một giá trị/.test(await page.textContent('#inspector .form-row:has(textarea[data-key="values"]) .opt-error')), 'no valuesEmpty message under the list');
  await page.fill(values, 'Hot\nWarm\nCold');
  await page.waitForFunction((id) => /^3 giá trị/.test(document.querySelector(`.step-card[data-id="${id}"] .sum`)?.textContent), newId, { timeout: 3000 }).catch(() => {});
  check((await page.textContent(`.step-card[data-id="${newId}"] .sum`)) === '3 giá trị: Hot, Warm, Cold · {{loop.value}}', `values summary: ${await page.textContent(`.step-card[data-id="${newId}"] .sum`)}`);
  await page.context().close();
}

(async () => {
  // A Playwright error outside a flow's promise (e.g. in an event handler) fails the run.
  process.on('uncaughtException', (e) => { console.error('SMOKE FAILED\n' + e); process.exit(1); });
  const t0 = Date.now();
  let server;
  try {
    // Browser start and server start overlap.
    [browser, server] = await Promise.all([chromium.launch(), startServer()]);
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`server: ${base}`);
    const orgs = await fetch(`${base}/api/orgs`);
    check(orgs.status === 503 && /smoke:/.test((await orgs.json()).error), 'the smoke server is not using the sf CLI stub');
    // Independent flows, one context each, in parallel. A flow that throws (timed-out wait) is
    // reported and the others still finish.
    let flows = { flowEditing, flowPicker, flowFiles, flowDark, flowLayoutWide, flowLayoutNarrow, flowEach, flowCanvas, flowHistory, flowVarsLoops };
    // SMOKE_ONLY=flowCanvas,flowEach runs only those flows (while working on one area).
    const only = process.env.SMOKE_ONLY?.split(',').filter(Boolean);
    if (only?.length) flows = Object.fromEntries(Object.entries(flows).filter(([n]) => only.includes(n)));
    const results = await Promise.allSettled(Object.values(flows).map((f) => f()));
    results.forEach((r, i) => { if (r.status === 'rejected') errors.push(`${Object.keys(flows)[i]}: ${r.reason}`); });
  } catch (e) {
    errors.push(String(e));
  } finally {
    // Server first: browser.close() can hang on a crashed page, and nothing must keep the port.
    server?.closeAllConnections();
    server?.close();
    await browser?.close();
    if (smokeTmp) fs.rmSync(smokeTmp, { recursive: true, force: true });
  }
  const ms = Date.now() - t0;
  console.log(`duration=${ms}ms`);
  // 12 s budget. Since 0009 the flows run in parallel (≈ 5–6 s); the budget stays to catch a flow
  // that starts waiting on fixed timeouts again.
  if (ms > 12000) errors.push(`smoke test took ${ms} ms (limit 12 s)`);
  if (errors.length) {
    console.error('SMOKE FAILED\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('SMOKE OK');
})();
