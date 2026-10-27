---
name: smoke-test
description: Launch sf-data-generator and verify the editor works in a real browser (load, sample workflow, editing, preview, migration, theme switch, dark mode, insert confirmation), plus API checks with curl. Use after any client/ or API change, or when asked to run or screenshot the app.
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
   summary shows the Account count, and the sample has no validation errors. Screenshot `smoke-1440.png`.
4. **Alias rename.** Clearing the `acc` alias and typing `account` keeps focus in the input and the
   Lookup `ref` follows the rename (never lost on the empty value); undo restores `acc`.
5. **Delete toast.** After Delete, the toast's "Hoàn tác" button disappears as soon as another edit
   (Ctrl+D) happens, so it can only undo the delete.
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
    and the OS (light) scheme applies again.
11. **Narrow (390 px, touch).** No horizontal overflow (`smoke-390.png`); tapping a card opens the
    inspector bottom sheet (`smoke-390-sheet.png`) and "‹ Xong" closes it. Dark-scheme shot of the same
    page: `smoke-390-dark.png`.
12. **Dark scheme (`colorScheme: 'dark'`, 1440 px).** The dark background applies without `data-theme`;
    preview (`smoke-1440-dark.png`). With a mocked production org (`/api/orgs`), "⤒ Insert vào org" opens
    the confirmation with the production warning box and a solid red `.danger.solid` "Insert" button
    (`smoke-1440-dark-insert.png`); "Hủy" closes it. Any `/api/run` request with a `target` is aborted
    and fails the run, so the smoke test never writes to an org.

It also fails on any page error or a run over 10 s.
Screenshots (only when a directory is given): `smoke-1440.png`, `smoke-390.png`, `smoke-390-sheet.png`,
`smoke-390-dark.png`, `smoke-1440-dark.png`, `smoke-1440-dark-insert.png`.
Requires Playwright with Chromium (`require('playwright')`); exit code 2 means it is not installed.

Extend the script when you add a UI flow worth guarding (keep it fast, under ~10 s).

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
