# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Salesforce test-data generator. Users build a workflow of nested steps in the browser (the "Quy trình" view: Record / Loop / Branch steps, Power Automate style), the UI POSTs the **workflow JSON** to a Node.js server, and the server generates Salesforce-typed values and can insert them into an org. Org credentials come from the **locally installed, authenticated `sf` CLI**, and are never stored.

Stack constraint: Node.js and plain HTML/JS (ES modules, no build step). Add React or Tailwind only if they are really needed. The only runtime dependency is **jsforce** (Salesforce API), so run `npm install` once.

## Commands

```bash
npm start                                  # server + UI on http://127.0.0.1:3000 (PORT, HOST env vars)
npm run dev                                # node --watch
npm test                                   # node:test, all test/**/*.test.js
node --test test/workflow.test.js          # one file
node --test --test-name-pattern="nested loops" 'test/**/*.test.js'   # one test
node .claude/skills/smoke-test/smoke.cjs   # headless-Chromium UI smoke test (needs Playwright)
```

There is no linter or formatter configured. Match the existing style (2-space indent, single quotes, semicolons).

## Architecture (read docs/architecture.md for detail)

- **The workflow JSON is the contract** between client and server (`docs/workflow-schema.md`). It is a tree since design 0003: `version: 2`, `steps[]`, child sequences in `slots` (loop `body`; branch `true`/`false`), optional `disabled`; no edges or positions. A change to step types, slots, config keys, field types or option schemas must update `server/workflow/nodes.js` or `server/generators/*`, `server/workflow/schema.js`, the executor, docs and tests together. The table in `.claude/agents/implementer.md` lists every layer.
- **The server is the single source of truth for options.** Generators (`server/generators/`) and step types (`server/workflow/nodes.js`: `slots`, `category`, `options`) declare their schemas. `GET /api/meta` serves them, and `client/js/forms.js` renders the forms from them. Don't hard-code per-type options in the client.
- **The executor (`server/workflow/executor.js`) is pure.** `runSteps` walks `steps` top to bottom. Loop runs `slots.body` N times, Branch runs `slots.true` or `slots.false`, and both then continue with the next step. `disabled` steps (and their children) are skipped without touching the rng. Results include `stats.byStep`. Record pools (`scope.current/all`) are global to the run; loop vars (`scope.vars`) are lexical.
- **Shared modules (`shared/`)** are pure ES modules used by both server and browser (served at `/shared/`): `workflow-tree.js` (tree operations), `migrate-v1.js` (v1 graph → v2 tree), `scope.js` (which record aliases are usable at a step, for Lookup `ref`; 0005's `analyzeScope` will replace it). The server still accepts v1 workflows and migrates them before validating; the client migrates v1 autosaves/files and never overwrites `sfdg.workflow.v1`.
- **Determinism:** all randomness goes through the seeded `ctx.rng` (`server/random.js`), and all time through `ctx.now`. Never use `Math.random` or `Date.now` in generators or the executor, because preview-then-insert with the same seed relies on it.
- **Org access is split in two:** `server/sf/cli.js` only shells out to `sf org list` / `sf org display` to get orgs, an access token and an instance URL. Every Salesforce API call goes through a **jsforce `Connection`** in `server/sf/client.js` (one per org). Its `refreshFn` asks the CLI for a fresh token when Salesforce returns `INVALID_SESSION_ID`. Add new API features (query, Bulk 2.0, delete) on that connection, not with hand-written `fetch` calls.
- **Lookups** are emitted as `{ "$ref": "alias#n" }`. `server/sf/insert.js` resolves them by inserting in dependency "waves" through `conn.sobject(type).create(records, { allOrNone: false })` (sObject Collections, at most 200 records per call).
- **Validation issues always carry `nodeId` and `field`** (`nodeId` is the step id; `field` is an option key, `fields.<Name>` or `slots.<key>`), so the UI can badge the step and outline the field or slot. The UI says "bước", not "node". User-facing strings are Vietnamese and should say how to fix the problem.
- **Client state** is in `client/js/store.js`: undo/redo, localStorage autosave, and events tagged with a `source`. The inspector ignores its own `source: 'inspector'` events so typing doesn't lose focus. Structural edits use `'inspector-structure'`. Step operations live in `client/js/ops.js`, the view in `client/js/process.js`, card summaries in `client/js/summary.js`; collapsed frames are UI state (`sfdg.collapsed`, no undo).
- **Safety:** the server binds `127.0.0.1` by default because it acts with the local sf CLI's org access. Org writes happen only via `/api/run` with `target.kind === 'org'`, behind a UI confirmation. `LIMITS` in `server/workflow/nodes.js` caps records, executed steps and nesting depth (`maxDepth`).

## Agents, skills, docs

- Feature work starts with the **`planner`** agent. It focuses on usability and writes a design doc to `docs/design/NNNN-*.md` (skill `design-doc`), checked against the usability principles in `docs/design/README.md`. **`implementer`** builds it, **`field-type-author`** handles generators, and **`reviewer`** checks the diff (read-only).
- Skills: `design-doc`, `add-field-type`, `add-node-type`, `smoke-test` (in `.claude/skills/`).
- `docs/` is written in **Vietnamese**; code, identifiers and this file are in English. When behaviour changes, update the matching doc (`workflow-schema.md`, `field-types.md`, `org-connection.md`) and the design doc's "Đã làm" section.
- The test environment may lack the `sf` CLI. `/api/orgs` then returns 503, and tests mock `cli.run` and the client (`createConnection` is injectable). `test/jsforce.test.js` runs real jsforce against a fake Salesforce on localhost. jsforce ignores `NO_PROXY`, so that file clears the proxy variables before importing it. Never insert into a real org while testing unless the user named that org.
