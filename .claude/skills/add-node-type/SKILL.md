---
name: add-node-type
description: Checklist for adding or changing a workflow node type (ports, config, execution semantics) in sf-data-generator while keeping the workflow JSON contract consistent across server, UI, tests and docs.
---

# Add or change a node type

Node types are part of the saved workflow format (`version: 1`). Never rename an existing `type`, port or config key without a migration.

1. **Catalogue** — add the entry to `NODE_TYPES` in `server/workflow/nodes.js`: `type`, Vietnamese `label` and `description`, `inputs`, `outputs` (`port` + short Vietnamese `label`; the first output is the one palette auto-connect uses), and `options` in the generator option format (defaults required).
2. **Validation** — in `server/workflow/schema.js` validate every config key; push issues with `nodeId` and `field` (= option key) and a message saying how to fix it. Add a warning (not an error) for states that are legal but probably unintended (e.g. an unconnected important port).
3. **Execution** — add a `case` in `runChain` in `server/workflow/executor.js`. Keep the executor pure (no I/O). Use `rng` for any randomness. Respect `LIMITS` and count steps. Lexically scoped variables go in `scope.vars`; record pools (`scope.current`, `scope.all`) are global for the run.
4. **Canvas** — add a colour in `NODE_COLORS` (`client/js/store.js`) and a CSS variable in `client/css/app.css` (light and dark); add a one-line summary in `nodeSummary` in `client/js/canvas.js`. Port positions are computed from the number of outputs automatically.
5. **Docs** — update the node table and semantics in `docs/workflow-schema.md`.
6. **Tests** — executor semantics and validation errors in `test/workflow.test.js`; `/api/meta` node list assertion in `test/server.test.js`.
7. Run `npm test` and the `smoke-test` skill (add the node from the palette, configure it, preview).
