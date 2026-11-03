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
without `sf` (503 `smoke: …`, checked at start), so no flow can reach a real org. Its insert history (design 0011) and the files
the flows open live in one temporary directory (`sfdg-smoke-*` under the OS temp dir) removed at the end, never the user's
data directory. It drives headless Chromium through these
flows
(failed checks are collected and reported together; a timed-out wait aborts that flow, the others finish).

**Speed (since design 0009).** The flows are grouped into seven independent functions that run **in parallel**, each in
its own browser context (so storage, routes and dialogs never leak between them): `flowEditing` (1–5), `flowPicker`
(5b), `flowFiles` (5c–10), `flowDark` (12), `flowLayoutWide` and `flowLayoutNarrow` (11, 13), `flowEach` (14), `flowCanvas` and `flowCanvasPhone` (15), `flowHistoryWide` (16 then the wide part of 11/13, one context), `flowVarsLoops` (17),
`flowProductivity`, `flowProductivityRun` and `flowLibrary` (18, 18b, 18c). Since the review of 0012 they run longest first, at
most 2 × CPUs at once; a page of a flow can share its context (`newPage(label, { shared: true })`); a reload that only reset the
workflow is `smokeOpen(wf)` (opens it as a library item) instead. The browser launches
while the server starts; a fresh context starts with empty storage, so no `localStorage.clear()` + reload; storage a flow
needs before its first load is written by `addInitScript` (once, guarded by a marker key, so reloads keep it); layout
checks resize one page (`setViewportSize`) instead of opening a context per width; waits for the sheet or toast
transition use `document.getAnimations()` instead of fixed timeouts. A run went from ~10 s (sequential) to ~5.5 s with
flow 13 added. When you add a flow, put it in the function it depends on, or in a new function if it needs nothing from
the others; never add a fixed `waitForTimeout`.

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
   "Đang sinh dữ liệu" (the check waits for the held request to reach the route and for that text, review 0011: one snapshot
   was racy under CPU load), the download buttons give their place to **Dừng**, and the `<progress>` is a ≤ 3 px
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
6. **v1 and v2 autosaves (design 0012 A).** A `sfdg.workflow.v1` autosave is migrated on load (toast) into one item of the
   library (`sfdg.library`, `sfdg.wf.<id>`); `sfdg.workflow.v2` is **not** written and the v1 key is left untouched. A
   `sfdg.workflow.v2` autosave becomes the first item (toast "… đã được đưa vào Thư viện"); after an edit (saved to the item)
   the v2 key is unchanged byte for byte. Flows read what was saved with `smokeStored()` (the tab's open item) and start again
   from an autosave with `smokeSetAutosave(wf)` (library keys removed), both defined by `newPage`.
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
      from the chip returns focus to the chip; Tab and Shift+Tab close the menu onto ⋯. At 800 px the menu has the groups Chạy
      (only "Lịch sử insert", 0011) and Mẫu. Inside `role=menu` there is no
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

16. **Insert history and delete (design 0011), `flowHistory`, own context.** Every org-facing call is answered by one
    `page.route('**/api/**')` dispatcher (orgs `dev-sb` [sandbox] and `dev-prod` [production], `/limits` with 30 calls left,
    a canned preview of 12 005 records with `con` = 12 000, canned inserts, history list / run / delete / forget); nothing
    reaches the server's stub CLI or an org.
    - **16a** Insert confirmation: the Bulk checkbox is ticked, the line `con (Contact) 12 000: 200 bản ghi đầu gửi thử bằng
      sObject Collections, phần còn lại 2 job Bulk.`, "Org còn …" without a warning (26 calls fit); unticking raises the call
      count and shows the `.limits-warn` box (61 > 30); the request sends `target.bulk: "off"`; the summary gets the
      **Tải Id** and **Lịch sử** links and the toast **Xóa dữ liệu này…**.
    - **16b** That toast button opens the delete confirmation with focus on **Hủy** and `Xóa 12 005 bản ghi` (`.danger.solid`);
      the request carries `confirm.username` and `confirm.count` = 12 005; the cascade warning is shown although the run has
      no parent steps (review S5) (`smoke-1440-delete.png`).
    - **16d (1440)** The **Lịch sử** button opens the dialog filtered on `dev-sb` (`smoke-1440-history.png`); the interrupted run
      has the "Server dừng giữa lúc insert…" title; ⋯ → "Quên lần insert này" asks first (nothing in the org) and then sends
      `forget`.
    - **16c** With the filter off, the `dev-prod` run's delete stays locked until `dev-prod` is typed (a wrong name keeps it
      locked); the request carries `typedOrg`. Its (mocked) result has one failure on a step no longer in the workflow: the
      "Lỗi xóa (1)" tab opens and that row is not a button (review nit).
    - **16d (390)** The dialog is full screen with no horizontal overflow (`smoke-390-history.png`).

17. **Biến và vòng lặp (design 0013), `flowVarsLoops`, own context.** A seeded workflow (Query `accs`, Query `cons`, Record
    `opp`, Lặp `each` `acc` → Lặp `each` `con` → Task, a fixed Lặp `lf` with a Lead, a compare Rẽ nhánh), no org (sample rows).
    "Số lần lặp" of `lf` is a numeric text field; {x} lists only Số / org-field variables and the line "Chỉ hiện biến kiểu Số…";
    `accs.$c` + Enter stores `{{accs.$count}}` with a chip, and the card reads `{{accs.$count}} lần · {{loop.index}}`. On the
    inner each-loop, "Lọc" → "Chỉ bản ghi thỏa điều kiện" fills `AccountId` / `{{acc.Id}}` with the "Đã điền điều kiện…" toast;
    one ↶ undoes the filter and the fill together. Xáo trộn + Tối đa 2 → summary `… · xáo trộn · tối đa 2 · {{loop2.index}}`;
    Ctrl+Enter → chip `10 lần lặp` and `Lead: 5`. With the filter on, "Lặp theo" = fixed hides every filter, order and limit
    row (chained showIf). In a Task template, the picker's `run.seed` sample is the preview's seed. {x} at the branch's
    "So với" inserts `{{opp.Amount}}`. A new Lặp switched to "Mỗi giá trị trong danh sách" has the `Hot/Warm/Cold`
    placeholder, an outlined list and the valuesEmpty message; typing `Hot⏎Warm⏎Cold` gives `3 giá trị: Hot, Warm, Cold ·
    {{loop.value}}`.
18. **Năng suất soạn thảo (design 0012), `flowProductivity`, own context.** "Account + Contact": `con` shows `≈ n bản ghi`
    (`.stat.est`) and the Start card `≈ n bản ghi · ≤ …` before any run (H); hovering `AccountId → acc` outlines `acc`
    (`.is-ref-target`), leaving removes it (I); the Industry options end with `Ví dụ: "…" · "…" · "…"`, and changing the values
    renews it (waits for the `/api/field-samples` response whose body has the new value, E). Shift+click `acc`, `loopCon` →
    two `aria-selected`, `aria-multiselectable`, "2 bước đã chọn"; Bọc trong Lặp, one ↶ restores; Ctrl+C / Ctrl+V pastes them
    selected as `acc2` / `loop` with the rename toast; Ctrl+/ turns both off (B). `▾` → `+ Workflow mới` adds an item (A); a
    Record switched to Task gets `Subject`, renamed `Name` it gets the `Đổi thành Subject` fix, which clears the warning (G);
    Ctrl+O back to the first item, where ↶ has nothing to undo; a sample opens as a third item, the others kept (A).
18c. **`flowLibrary`, own context (review 0012 B1, S2, S5).** The library and G steps moved out of 18 (they wait for the
    `/api/validate` response of the edited workflow, then the default timeout). A second tab edits the open workflow: the first
    shows `Tạm dừng lưu` (`#btn-unsaved`); with a held preview, "Dùng bản ở tab kia" says "Đang chạy" and leaves the workflow
    alone; `+ Workflow mới` ends the pause and its edits are saved.
18b. **`flowProductivityRun`, own context, alongside 18.** With a mocked org and a page-side fake NDJSON stream for the insert
    (nothing reaches an org): `insert 3/n` (`.stat.live`, inserted only) and `lỗi 2` (`.tag-insert-err`) on `con` while inserting; after
    `done` the tag opens "Lỗi insert" with the step's group `.current` (D). "Contact cho Account có sẵn": `{{acc.Industry}}` in
    con's Title → `Thêm Industry vào SELECT của "accs"` adds it to the Query and the error goes (F1); ⋯ → Bọc trong Lặp qua
    từng bản ghi → a Lặp `each` over `accs` around `con`, and the toast's [Đổi] points the Lookup at the record looped over (C).
    At 390 px: ⋯ → Chọn nhiều bước shows `.select-bar`, a tap gives `2 đã chọn` without opening the sheet, Xong leaves.

It also fails on any page error or a run over the time budget, `SMOKE_BUDGET_MS` (default 20 000 ms; raised from 12 000 after 0012 added two flows, since the run is CPU-bound,
about 11–15 s on 4 CPUs; raise it further on a loaded machine, e.g. `SMOKE_BUDGET_MS=30000`). When a flow throws (a timed-out
wait), its open pages are saved as full-page screenshots plus a `<flow>.txt` with the selector it was waiting for and the
stack, under `failures/` in the smoke temp dir (kept when that happens); the paths are printed after `failure artefacts:`.
Waits never race a previous state: after Ctrl+Enter wait for the new result before clicking its tab, wait for a mocked
request's response before reading what it recorded, and match a request by its body (e.g. the workflow name) rather than
take the first one (review 0013 S3). Typical durations: ~5.5–6.5 s since the flows run in parallel, flow 14 included, ~7–8.5 s with flow 15 on a 4-CPU machine, ~8–9.5 s with flow 16, ~9–10 s with flow 17, ~10.5–11 s with flows 18 / 18b (the same machine ran the 0013 suite in ~9.5–10 s); ~10 s before;
~7–8 s with two CPU-bound processes running alongside).
Screenshots (only when a directory is given): `smoke-1440.png`, `smoke-390.png`, `smoke-390-sheet.png`,
`smoke-390-dark.png`, `smoke-390-topbar.png`, `smoke-1280-issues.png`, `smoke-1440-dark.png`, `smoke-1440-dark-insert.png`,
`smoke-1440-canvas.png`, `smoke-1440-canvas-dark.png`, `smoke-390-canvas.png`, `smoke-1440-history.png`, `smoke-1440-delete.png`,
`smoke-390-history.png`.
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
