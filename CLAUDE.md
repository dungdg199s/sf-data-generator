# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Salesforce test-data generator. Users build a node workflow in the browser (Record / Loop / Branch nodes), the UI POSTs the **workflow JSON** to a Node.js server, and the server generates Salesforce-typed values and can insert them into an org. Org credentials come from the **locally installed, authenticated `sf` CLI**, and are never stored.

Stack constraint: Node.js and plain HTML/JS (ES modules, no build step). Add React or Tailwind only if they are really needed. There are currently **zero runtime dependencies**, so `npm install` is not needed.

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

- **The workflow JSON is the contract** between client and server (`docs/workflow-schema.md`). A change to node types, ports, config keys, field types or option schemas must update `server/workflow/nodes.js` or `server/generators/*`, `server/workflow/schema.js`, the executor, docs and tests together. The table in `.claude/agents/implementer.md` lists every layer.
- **The server is the single source of truth for options.** Generators (`server/generators/`) and node types (`server/workflow/nodes.js`) declare their option schemas. `GET /api/meta` serves them, and `client/js/forms.js` renders the forms from them. Don't hard-code per-type options in the client.
- **The executor (`server/workflow/executor.js`) is pure.** It follows edges from Start, and each output port has at most one edge. Loop runs the `body` chain N times, then `done`. Branch picks `true` or `false`. Record pools (`scope.current/all`) are global to the run; loop vars (`scope.vars`) are lexical.
- **Determinism:** all randomness goes through the seeded `ctx.rng` (`server/random.js`), and all time through `ctx.now`. Never use `Math.random` or `Date.now` in generators or the executor, because preview-then-insert with the same seed relies on it.
- **Lookups** are emitted as `{ "$ref": "alias#n" }`. `server/sf/insert.js` resolves them by inserting in dependency "waves" through sObject Collections (200 records per call).
- **Validation issues always carry `nodeId` and `field`** (an option key or `fields.<Name>`), so the UI can badge the node and outline the field. User-facing strings are Vietnamese and should say how to fix the problem.
- **Client state** is in `client/js/store.js`: undo/redo, localStorage autosave, and events tagged with a `source`. The inspector ignores its own `source: 'inspector'` events so typing doesn't lose focus. Structural edits use `'inspector-structure'`.
- **Safety:** the server binds `127.0.0.1` by default because it acts with the local sf CLI's org access. Org writes happen only via `/api/run` with `target.kind === 'org'`, behind a UI confirmation. `LIMITS` in `server/workflow/nodes.js` caps records and steps.

## Agents, skills, docs

- Feature work starts with the **`planner`** agent. It focuses on usability and writes a design doc to `docs/design/NNNN-*.md` (skill `design-doc`), checked against the usability principles in `docs/design/README.md`. **`implementer`** builds it, **`field-type-author`** handles generators, and **`reviewer`** checks the diff (read-only).
- Skills: `design-doc`, `add-field-type`, `add-node-type`, `smoke-test` (in `.claude/skills/`).
- `docs/` is written in **Vietnamese**; code, identifiers and this file are in English. When behaviour changes, update the matching doc (`workflow-schema.md`, `field-types.md`, `org-connection.md`) and the design doc's "Đã làm" section.
- The test environment may lack the `sf` CLI. `/api/orgs` then returns 503, and tests mock `cli.run` and the REST client. Never insert into a real org while testing unless the user named that org.
