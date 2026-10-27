---
name: smoke-test
description: Launch sf-data-generator and verify the editor works in a real browser (load, sample workflow, preview), plus API checks with curl. Use after any client/ or API change, or when asked to run or screenshot the app.
---

# Smoke test

## Automated UI check

```bash
node .claude/skills/smoke-test/smoke.cjs /path/to/screenshot-dir   # dir optional
```

It starts the server on a random port 3900–3989 and opens the editor ("Quy trình" view) in headless Chromium:
loads the "Account + Contact" sample, adds a Record with the "+" inside the inner loop body, moves it with
Alt+↑, deletes it and restores it with Ctrl+Z, previews with Ctrl+Enter (results table and stat chips on the
cards), checks that a v1 autosave is migrated without touching `sfdg.workflow.v1`, opens a v1 file with an
unconnected node (migration report dialog), and renders the 390 px layout with the inspector bottom sheet.
It exits non-zero on any page error, validation error on the sample, failed check, or a run over 10 s.
Screenshots: `smoke-1440.png`, `smoke-390.png`, `smoke-390-sheet.png`.
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
