---
name: smoke-test
description: Launch sf-data-generator and verify the editor works in a real browser (load, sample workflow, editing, preview, variable picker, migration, theme switch, dark mode, insert confirmation, screen layout at desktop and phone widths), plus API checks with curl. Use after any client/ or API change, or when asked to run or screenshot the app.
---

# Smoke test

## Automated UI check

```bash
node .claude/skills/smoke-test/smoke.cjs /path/to/screenshot-dir   # dir optional
```

It runs the app **in its own process** (`createApp` from `server/index.js` on port 0, so it dies with the smoke on
Ctrl+C or kill and a stale server on a busy port can never answer instead) with a **stub sf CLI** that fails like a machine
without `sf` (503 `smoke: …`, checked at start), so no flow can reach a real org. It drives headless Chromium through these
flows
(failed checks are collected and reported together; a timed-out wait aborts that flow, the others finish).

**Speed (since design 0009).** The flows are grouped into seven independent functions that run **in parallel**, each in
its own browser context (so storage, routes and dialogs never leak between them): `flowEditing` (1–5), `flowPicker`
(5b), `flowFiles` (5c–10), `flowDark` (12), `flowLayoutWide` and `flowLayoutNarrow` (11, 13), `flowEach` (14), `flowCanvas` (15), `flowProductivity` (16). The browser launches
while the server starts; a fresh context starts with empty storage, so no `localStorage.clear()` + reload; storage a flow
needs before its first load is written by `addInitScript` (once, guarded by a marker key, so reloads keep it); layout
checks resize one page (`setViewportSize`) instead of opening a context per width; waits for the sheet or toast
transition use `document.getAnimations()` instead of fixed timeouts. A run went from ~10 s (sequential) to ~5.5 s with
flow 13 added. When you add a flow, put it in the function it depends on, or in a new function if it needs nothing from
the others; never add a fixed `waitForTimeout`: the smoke fails at start if its own source contains one (`noFixedWaits`).
Every context is created with `reducedMotion: 'reduce'` (the app honours it), so no transition has to finish before a check.
A flow that needs another workflow mid-way opens it through `#file-input` (`setInputFiles` with a buffer) rather than writing
storage and reloading (one app boot less; flow 5b).

1. **Wide (1440 px), light scheme.** Loads the "Account + Contact" sample. Every step, the Start card
   and every palette item carries `data-type` and an icon tile (`.ico-tile .ico`) and no inline `--c`;
   `client/js/store.js` no longer contains `NODE_COLORS` (design doc 0008).
2. **Editing.** The "+" inside the inner loop body opens the menu (every row has `data-type` and an icon)
   and adds a Record after `con`, which becomes selected; Alt+↑ moves it above `con`; Delete removes it
   and Ctrl+Z restores it in place.
3. **Preview.** Ctrl+Enter fills the results table, the cards get "bản ghi" / "lần lặp" stat chips, the
   summary shows the Account count, and the sample has no validation errors. Scrolled, the sticky table
   header sits right under the sticky tab row (no gap). The Record and Loop stripes (`border-left-color`)
   differ from each other and from the unknown-type `[data-type]` fallback. Screenshot `smoke-1440.png`.
3b. **Run progress (design doc 0004).** With `/api/run` held until Dừng was clicked (a promise, no timer), the results header shows
   "Đang sinh dữ liệu", the download buttons give their place to **Dừng**, and the `<progress>` is a ≤ 3 px
   line on the bottom edge of `.results-head`; Dừng drops the request ("Đã dừng") and re-enables Xem
   trước, and focus moves from Dừng to Xem trước; `#results-summary` is `aria-live="polite"`. With the run's response body
   held back in the page (a `fetch` wrapper, released after the click), Dừng sends `POST /api/runs/<runId>/cancel` once `start` arrives instead
   of dropping the stream. Then `con` makes 60 Contacts per run: the Contact tab shows "Hiển thị 200/N dòng đầu" and
   "Tải CSV (tab hiện tại)" downloads all N rows (header `ref,FirstName,LastName…`) from `/api/export`.
4. **Alias rename.** Clearing the `acc` alias and typing `account` keeps focus in the input and the
   Lookup `ref` follows the rename (never lost on the empty value); undo restores `acc`.
5. **Delete toast.** After Delete, the toast's "Hoàn tác" button disappears as soon as another edit
   (Ctrl+D) happens, so it can only undo the delete.
5b. **Variable picker (design doc 0005).** On `con`, the Title card's options open; the template is
   cleared, {x} opens the picker with the search focused, `indu` highlights `acc.Industry` and Enter
   inserts `{{acc.Industry}}` (focus back in the field, a record-coloured chip under it). Typing ` #{{`
   opens the list as autocomplete, `in` puts `loop.index` first, Enter inserts it (loop-coloured chip).
   Typing `{{acc.Nmae}}` turns that chip red after validation, the `con` card gets the error badge and the
   card shows "Ý bạn là "Name""; "Sửa thành …" fixes it and the badge goes. Renaming `Industry` to
   `Industry__c` on `acc` (then Tab) updates the template and shows the "Đã cập nhật 1 tham chiếu" toast.
   One click on ↶ undoes the rename and the references together. Renaming `Title` to `Title2` keeps its chip strip live
   (a new `{{zzz.Name}}` turns red, with the ⊗ icon), `{{this.$n}}` gets the neutral `start` colour, and the strip is a
   single tab stop. The picker's listbox only holds groups/options, it has no `role=dialog`, and the field has
   `aria-controls` only while it is open. Typing `Lead` into "Trỏ tới sObject" of `AccountId` refreshes "Bản ghi cha".
   Then a seeded workflow checks branch "Giá trị" (path mode): switching a root branch to "So sánh giá trị" fills
   `acc.Name` (not the invalid `loop.index`); tabbing into and out of an empty "Giá trị" neither opens the picker nor
   inserts; clicking it opens the list and Tab without typing inserts nothing; ↓ then Tab inserts.
5c. **Query → Chọn bản ghi → Record without an org (design doc 0006).** The "Contact cho Account có sẵn" sample
   shows "chưa chọn org" on the Query card; Ctrl+Enter generates 10 Contacts from 5 sample rows, with a "↓ accs ·
   Account (5)" tab, "accs: 5 bản ghi mẫu" in the summary and a warning on the Query card. With the Query selected,
   "Chọn bản ghi" in the palette fills "Chọn từ pool" = `accs` and alias `acc…`; `{{` typed in WHERE outlines it red.
   The first `/api/validate` (of the workflow before the sample) is held until after the preview: when it lands, the
   Query warning stays (stale responses are dropped). Editing the name and putting it back (a validation of the same
   workflow) also keeps the run's warning.
6. **v1 autosave.** A `sfdg.workflow.v1` autosave is migrated on load (toast), `sfdg.workflow.v2` is
   written and the v1 key is left untouched.
7. **Malformed v2 autosave.** The sample is shown with a recovery toast and a "Tải bản lưu" button; the
   broken autosave is neither overwritten nor lost (`sfdg.workflow.v2.broken` keeps a copy).
8. **Malformed v2 file.** Opening it is refused with a toast naming the bad entry (`steps[1]`); the
   current workflow stays.
9. **v1 file with an unconnected node.** The migration report dialog mentions the node as turned off and
   offers "Tải bản gốc (v1)"; after "Đồng ý" the node is shown as a disabled step.
10. **Theme switch.** "Tối" sets `data-theme="dark"` on `<html>`, the dark background and
    `localStorage['sfdg.theme']`; it survives a reload; "Theo hệ thống" removes the attribute and the key
    and the OS (light) scheme applies again. A second tab of the same context follows both changes
    (`storage` event: `data-theme` and the select value).
11. **Narrow (390 px, touch).** No horizontal overflow (`smoke-390.png`); tapping a card opens the
    inspector bottom sheet (`smoke-390-sheet.png`) and "‹ Xong" closes it. Dark-scheme shot of the same
    page: `smoke-390-dark.png`. (Runs inside `flowLayoutNarrow`, with flow 13.)
12. **Dark scheme (`colorScheme: 'dark'`, 1440 px).** The dark background applies without `data-theme`;
    "Sáng" overrides it (light background, `data-theme="light"`), still after a reload, and "Theo hệ
    thống" returns to the dark background and clears the key. `/api/orgs/**` (describe) is answered 404 so
    the mocked org never reaches the sf CLI; preview (`smoke-1440-dark.png`). With a mocked production org (`/api/orgs`), "⤒ Insert vào org" opens
    the confirmation with the production warning box and a solid red `.danger.solid` "Insert" button
    (`smoke-1440-dark-insert.png`): it previews first when needed, so it always says "Sẽ tạo N bản ghi" and the button
    reads "Insert N bản ghi"; "Hủy" closes it. Any `/api/run` request with a `target` is aborted
    and fails the run, so the smoke test never writes to an org. Then, with a canned preview of the Query sample that
    read the (mocked) org, the confirmation lists "Đọc từ org, không ghi: Account 2 (accs, đọc lúc …)" and says the
    rows are re-read only after 10 minutes or with "⟳ Đọc lại" (no over-promise, no "null"). The canned preview is
    an NDJSON stream (`start`, `done`) like the real `/api/run`. Then inserts are answered by the route mock itself (they
    never reach the server or an org): after an insert, a second Insert previews afresh (seed empty); with seed 7 the
    second confirmation warns "Seed 7 đã dùng cho lần insert trước…"; the "Lỗi insert" tab has role=button group rows
    (Space selects `con`) and a "… và 3 nhóm lỗi khác" remainder row.
13. **Screen layout (design 0009).** `/api/orgs` is mocked with one long label (`dev-sandbox-very-long — admin.developer@
    acme-corporation.com.devsb [sandbox]`, selected through `sfdg.org`); describe calls get 404, no real org is called.
    Measurements use `getBoundingClientRect`.
    - **13a issues bar** ("Account + Contact" + `opp` without fields + `task` without sObject and with an unnamed field: 2
      errors, 1 warning) at 844 × 390, 1440 × 900, 1280 × 800, 1024 × 768: the bar is not `position: absolute`, `#process`
      ends where `#issues` starts and no visible part of a `.step-card` is under it (`smoke-1280-issues.png`); it is at most
      a quarter of the middle column (or its 33 px head) and ends above the results header; the app name is hidden
      exactly below 1 300 px. An edit that keeps "2 lỗi · 1 cảnh báo" does not rewrite the aria-live count. F8 × 4 selects task,
      task, opp, task (wraps), one row is `.current`, Shift+F8 goes back to opp. "Thu gọn" leaves a ≤ 40 px bar showing
      "— [task] Chưa nhập sObject…", still collapsed after a reload; that line selects `task`. Ctrl+Enter (422) expands the
      bar and selects `task`. Narrowed to 800 px with a step selected, the sheet does not pop open (closed, inert, off
      screen); back at 1440 the inspector is not inert.
    - **13b top bar**: ≤ 50 px (one row) at 1440 and 1280, ≤ 90 px at 1024, 390 and 360; no horizontal overflow; `#org-select`,
      Xem trước and Insert inside the viewport at every width; the theme select is 32 px wide, `title` "Giao diện: Theo
      hệ thống", its `option` colour is not transparent (`smoke-390-topbar.png`).
    - **13c ⋯ menu at 390 × 844**: Mới, Mở…, Lưu, a Seed field, Account + Contact, Tối (radio, "Theo hệ thống" checked);
      typing 42 sets `#seed` and shows the chip "Seed 42"; the chip reopens the menu on the Seed field; Mẫu "Lead theo xác
      suất" then "Account + Contact" replace the workflow. At 800 px the menu only has the Mẫu group. Esc in the menu opened
      from the chip returns focus to the chip; Tab and Shift+Tab close the menu onto ⋯. Inside `role=menu` there is no
      text or input outside a group, a menu item or `aria-hidden` text.
    - **13d sheet at 390 × 844**: tapping `con` leaves its bottom ≤ the sheet top and ≥ 190 px of canvas above the sheet;
      "‹ Xong" by keyboard closes it, makes it inert and focuses the `con` card; Ctrl+Enter in the alias field closes the
      sheet, `con` stays selected, the table is above the sheet's top, focus left the sheet and typing "ZZ" changes
      nothing; tapping `con` reopens it; scrolled to the bottom, "‹ Xong" is still inside the sheet; a toast (F8 with
      nothing to go to) ends above the sheet; at 844 × 390 there are ≥ 60 px of canvas above the sheet and "Thu gọn tất
      cả" is in the ⋯ menu. With the issues workflow, tapping an issue row (390 × 844: `task`; 844 × 390: `opp`) leaves the
      card fully between the palette and the sheet.
    - **13e results header**: ≤ 50 px after Xem trước at 390 px with `aria-expanded="true"`; "⤓ Tải" opens "Tải JSON" and
      "Tải CSV (tab hiện tại)"; at 1440 px the two buttons show and "⤓ Tải" does not.

14. **Lặp "Mỗi bản ghi trong pool" (design 0010), `flowEach`, own context.** The "Contact cho mỗi Account có sẵn"
    sample: the loop card shows `acc` and "Mỗi bản ghi trong accs → acc · {{loop.index}}"; Ctrl+Enter (no org, 5 sample
    rows) gives "Contact: 15" and the chip "5 lần lặp". "⋯ → Lặp qua từng bản ghi" on the Query card inserts a Lặp right after
    it, selected, with "Lặp theo" = each, "Lặp qua pool" = `accs` (option text "accs (Account · đọc từ org)"), "Tên bản ghi
    đang lặp" = `acc2` and "Số lần lặp" hidden; one ↶ removes it. A Lặp from the palette switched to "Mỗi bản ghi trong
    pool" gets `accs` / `acc2`. Renaming the record to `a` updates the Contact's Lookup and template (autosave). Alt+↑ moves
    the Contact out of the loop: error badge and the outsideLoop message in the issues bar. Then (0010 review) a saved
    workflow: a pool made in a finished fixed loop reads "acc (Account · đã sinh)" in "Lặp qua pool" (no "bản ghi cuối"),
    and inside a loop over each row of `accs` the picker's `accs` group says `dùng bản ghi đang lặp "row"`.

15. **Sơ đồ view (design 0003 đợt B and its review fixes), `flowCanvas`, own contexts.** `/api/meta` is answered with
    the real catalogue except a different `empty` text for Lặp's body. In Quy trình, Enter on a focused ⋯ opens the step
    menu. With `con` selected, **M** shows the diagram: `con` still selected, focused and inside `#canvas`; `#process`
    has no DOM and is hidden, the "Sơ đồ" switch is `aria-pressed`, `sfdg.view` = `canvas`, `#canvas` is `role=tree`
    with one tab stop (the selected card), `aria-posinset` on cards, an `aria-label` on the zoom level button. Enter on
    the focused "+" `Thêm bước sau "con"` opens its menu → Record is added right after `con`, selected, focused, in
    view; Delete removes it. Focus stays on the card after Delete, ↑ (selects the Lặp), Alt+↓, Ctrl+Z, and F8 to the
    warning of an empty Lặp added from the palette; its empty box's `aria-label` is the catalogue text in both views
    (M there and back). With `con` panned near the bottom, Ctrl+Enter (results panel) keeps it in view. Dark scheme
    (`smoke-1440-canvas.png`, `smoke-1440-canvas-dark.png`); M with Start selected, there and back, focuses Start; a
    click on the background then **+** zooms to 125 %. Loading "Contact cho Account có sẵn" after panning away resets
    to 100 % with Start in view, no type label is cut (Query card), and panning far away still leaves a card on
    screen. At 390 × 844 (touch) with `sfdg.view` = `canvas` saved, the page opens in Quy trình; ⋯ → "Sơ đồ" shows the
    diagram without overflow, the zoom bar is only ⤢ (32 px); tapping Start opens the sheet with the card above it
    (`smoke-390-canvas.png`). At 844 × 390 with the sheet open, End selects `con`: its top is visible above the sheet,
    not under the zoom bar, its ⋯ is 32 px; ⋯ → "Quy trình" there leaves `sfdg.view` = `canvas` (landscape phone = phone).
    `SMOKE_ONLY=flowCanvas` (comma list) runs only the named flows.

16. **Editor productivity (design 0012), `flowProductivity`, own context (one page: G, then F1, I, C, H, D, E in that order).** G: a saved workflow (`addInitScript`) with a Task
    Record that has a `Name` field and a Contact whose template reads `{{task.Name}}`: the Task card has the warning badge, its
    Name field shows "Task không ghi được field Name nên insert sẽ lỗi. Đổi thành Subject…" with the button "Đổi thành Subject"; the
    button clears the warning, the field becomes `Subject` with the preset's list options and the template becomes
    `{{task.Subject}}`. A Record from the palette starts with `Name`; filling its sObject with `Task` turns the list into
    `Subject` at once while focus stays in the sObject field. The context has a mocked org `dev` (`/api/orgs` and its
    `sobjects` / describe answered by the route, never the sf CLI): switched to `Event`, the preset stays and the describe's only
    required field is appended (`Subject,ActivityDateTime,DurationInMinutes,Type__c`, toast "Đã thêm field bắt buộc…"); switched
    to `Invoice__c` (auto-number Name), the list becomes empty with an "auto-number" toast and focus stays in sObject. F1: the "Contact cho Account có sẵn" sample, `con`'s Title template set
    to `Ngành {{acc.Industry}}`: the field shows the button `Thêm Industry vào SELECT của "accs"`; clicking it clears the card's
    error, the Query's fields become `Id, Name, Industry` and the toast says "Đã thêm Industry vào Query "accs". Bấm Xem trước để
    đọc lại." I: hovering the chip `[acc · Industry]` gives the card `acc` `.is-ref-target`, leaving it clears it; focusing the
    Lookup chip `AccountId · Lookup → acc` on `con`'s card (after "Hiện các field") does the same and its title has
    `Nguồn: Chọn bản ghi "acc"`; blur clears it. C: ⋯ on `con` → "Bọc trong Lặp qua từng bản ghi" wraps it in a selected Lặp `each` over `accs` (con refers to the pick
    `acc` of `accs`) with the record `acc2`; the toast "Đổi Lookup AccountId (con) sang bản ghi đang lặp "acc2"?" [Đổi] sets the
    Lookup to `acc2`, mode `current`. H: before any run `con` (Lặp 10 × each row of `accs`, unread: LIMIT 200) shows the
    estimate chip `≈ 2.000 bản ghi` (title "khoảng 0–2.000"), the Start card ends with `≈ 2.000 bản ghi · ≤ 50.000`, and a limit of
    1 000 adds the `.tag-est-over` tag ("quá giới hạn 1.000 mỗi lần chạy"). Flow 15 waits for `.stat:not(.est)` after Ctrl+Enter
    (the estimate chip is there before the run); flow 14 picks "Lặp qua từng bản ghi" by exact label (not "Bọc trong Lặp qua…").
    D: the "Account + Contact" sample inserted into the mocked org `dev`: the insert `/api/run` (with a `target`) is answered by
    the route with NDJSON (`start`, `plan`, `progress` insert with `byStep`, `done`), never by the server or an org; the preview
    before the confirmation goes to the server. A MutationObserver on `#process` records the texts the chips take: `con` shows
    `insert 0/N` then `insert 4/N` and the tag `lỗi 3`; after the run the tag stays (aria-label "3 bản ghi của bước này insert lỗi.
    Bấm để xem nhóm lỗi."), `acc` has none, and clicking it opens "Lỗi insert" with the `con` group row `.current` and focused.
    E: ⚙ of the picklist `Industry` on `acc` shows `Ví dụ: "…" · "…" · "…"` (title mentions seed 1) from `/api/field-samples`;
    weights `0, 0, 0, 1` turn it into `Ví dụ: "Healthcare" · "Healthcare" · "Healthcare"` once the server answers (waits on the
    response, no fixed wait); `con`'s Title (reads `{{acc.Industry}}`) shows a "Lần xem trước…" line instead.

It also fails on any page error or a run over the **time budget**: `SMOKE_BUDGET_MS` when set, else
`15 000 × max(1, 4 / os.availableParallelism())` ms (15 s on 4 or more CPUs, 30 s on 2). The flows run in parallel and are
CPU-bound, so the cap scales with the CPUs; it is there to catch fixed waits and runaway flows, not to benchmark. The run prints
`flows: <name> <ms>, …` (longest first) and `duration=… (budget …)`, to see which flow is the critical path. History: the cap was
12 s until the 0012 review; with flow 16 complete a 4-CPU sandbox measured 11.3–11.9 s (10.5–12.3 s for the commit before
0012 C/I/H/D/E), ~9.5–10 s once reduced motion and the flow 5b file-open went in. A second context for flow 16 made it slower,
not faster.
Screenshots (only when a directory is given): `smoke-1440.png`, `smoke-390.png`, `smoke-390-sheet.png`,
`smoke-390-dark.png`, `smoke-390-topbar.png`, `smoke-1280-issues.png`, `smoke-1440-dark.png`, `smoke-1440-dark-insert.png`,
`smoke-1440-canvas.png`, `smoke-1440-canvas-dark.png`, `smoke-390-canvas.png`.
Requires Playwright with Chromium (`require('playwright')`); exit code 2 means it is not installed.

Extend the script when you add a UI flow worth guarding (keep it fast: see "Speed" above).

## Manual API checks

```bash
PORT=3999 npm start &            # binds 127.0.0.1
curl -s localhost:3999/api/meta | head -c 400
curl -s -X POST localhost:3999/api/run -H 'Content-Type: application/json' \
  -d '{"seed":1,"workflow":{"version":2,"steps":[{"id":"l","type":"loop","config":{"count":2},"slots":{"body":[{"id":"a","type":"record","config":{"sobject":"Account","alias":"acc","count":3,"fields":[{"name":"Name","type":"text","options":{"mode":"company"}}]}}]}}]}}'
# the UI asks for a stream (design 0004): one JSON event per line (start, progress, plan, done | error)
curl -sN -X POST localhost:3999/api/run -H 'Accept: application/x-ndjson' -H 'Content-Type: application/json' \
  -d '{"seed":1,"now":1761552000000,"workflow":{"version":2,"steps":[{"id":"a","type":"record","config":{"sobject":"Account","alias":"acc","count":3}}]}}'
# version 1 (graph) bodies are still accepted; the response then starts with a conversion warning
curl -s localhost:3999/api/orgs  # 503 + message if the sf CLI is not installed
```

Stop the server afterwards (kill the PID you started; don't `pkill -f` a pattern that also matches your own shell).

## Org flows

Inserting into a real org needs an authenticated `sf` CLI (`sf org list`). Never insert into an org during
testing unless the user named that org for it; `test/server.test.js` covers the insert path with a mocked client.
