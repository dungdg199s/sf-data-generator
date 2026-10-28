---
name: smoke-test
description: Launch sf-data-generator and verify the editor works in a real browser (load, sample workflow, editing, preview, variable picker, migration, theme switch, dark mode, insert confirmation), plus API checks with curl. Use after any client/ or API change, or when asked to run or screenshot the app.
---

# Smoke test

## Automated UI check

```bash
node .claude/skills/smoke-test/smoke.cjs /path/to/screenshot-dir   # dir optional
```

It starts the server on a random port 3900–3989 and drives headless Chromium through these flows
(failed checks are collected and reported together; a timed-out wait aborts the run):

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
    page: `smoke-390-dark.png`.
12. **Dark scheme (`colorScheme: 'dark'`, 1440 px).** The dark background applies without `data-theme`;
    "Sáng" overrides it (light background, `data-theme="light"`), still after a reload, and "Theo hệ
    thống" returns to the dark background and clears the key. `/api/orgs/**` (describe) is answered 404 so
    the mocked org never reaches the sf CLI; preview (`smoke-1440-dark.png`). With a mocked production org (`/api/orgs`), "⤒ Insert vào org" opens
    the confirmation with the production warning box and a solid red `.danger.solid` "Insert" button
    (`smoke-1440-dark-insert.png`); "Hủy" closes it. Any `/api/run` request with a `target` is aborted
    and fails the run, so the smoke test never writes to an org. Then, with a canned preview of the Query sample that
    read the (mocked) org, the confirmation lists "Đọc từ org, không ghi: Account 2 (accs, đọc lúc …)" and says the
    rows are re-read only after 10 minutes or with "⟳ Đọc lại" (no over-promise, no "null").

It also fails on any page error or a run over 12 s (typically ~8 s; raised from 10 s with the 0006 flows, which left no margin on a loaded machine).
Screenshots (only when a directory is given): `smoke-1440.png`, `smoke-390.png`, `smoke-390-sheet.png`,
`smoke-390-dark.png`, `smoke-1440-dark.png`, `smoke-1440-dark-insert.png`.
Requires Playwright with Chromium (`require('playwright')`); exit code 2 means it is not installed.

Extend the script when you add a UI flow worth guarding (keep it fast, under ~12 s).

## Manual API checks

```bash
PORT=3999 npm start &            # binds 127.0.0.1
curl -s localhost:3999/api/meta | head -c 400
curl -s -X POST localhost:3999/api/run -H 'Content-Type: application/json' \
  -d '{"seed":1,"workflow":{"version":2,"steps":[{"id":"l","type":"loop","config":{"count":2},"slots":{"body":[{"id":"a","type":"record","config":{"sobject":"Account","alias":"acc","count":3,"fields":[{"name":"Name","type":"text","options":{"mode":"company"}}]}}]}}]}}'
# version 1 (graph) bodies are still accepted; the response then starts with a conversion warning
curl -s localhost:3999/api/orgs  # 503 + message if the sf CLI is not installed
```

Stop the server afterwards (kill the PID you started; don't `pkill -f` a pattern that also matches your own shell).

## Org flows

Inserting into a real org needs an authenticated `sf` CLI (`sf org list`). Never insert into an org during
testing unless the user named that org for it; `test/server.test.js` covers the insert path with a mocked client.
