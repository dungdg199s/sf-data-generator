---
name: add-node-type
description: Checklist for adding or changing a workflow step type (slots, config, execution semantics) in sf-data-generator while keeping the workflow JSON contract consistent across server, shared modules, UI, tests and docs.
---

# Add or change a step type

Step types are part of the saved workflow format (`version: 2`, a tree of steps; see `docs/workflow-schema.md`). Never rename an existing `type`, slot key or config key without a migration.

1. **Catalogue** — add the entry to `NODE_TYPES` in `server/workflow/nodes.js`: `type`, Vietnamese `label` and `description`, `category` (`data` or `control`, labels in `STEP_CATEGORIES`), `slots` (`[]` for a plain step; for a container `[{ key, label, empty?, hint? }]` in reading order — the first empty slot is where the default insert rule puts new steps), and `options` in the generator option format (defaults required). Mark the options that describe the step with `summary: true` if it has no dedicated summary.
2. **Validation** — in `server/workflow/schema.js` validate every config key; push issues with `nodeId` (step id) and `field` (option key, `fields.<Name>` or `slots.<key>`) and a message saying how to fix it. Add a warning (not an error) for legal-but-probably-unintended states (e.g. an empty slot). Turned-off steps are not checked. Anything about "is this alias usable here" goes through `shared/scope.js`.
3. **Execution** — add a `case` in `runSteps` in `server/workflow/executor.js`. Keep the executor pure (no I/O). Use `rng` for any randomness and keep the rng call order stable. Respect `LIMITS` and count steps. Lexically scoped variables go in `scope.vars`; record pools (`scope.current`, `scope.all`) are global for the run. Fill `stats.byStep[step.id]`.
4. **Shared** — if the step is a container with special semantics (not "slots are alternatives" like a branch), teach `shared/scope.js` about it. `shared/workflow-tree.js` works from the slot list in meta and normally needs no change.
5. **UI** — add a colour in `NODE_COLORS` (`client/js/store.js`) and a CSS variable in `client/css/app.css` (light and dark); add a summary in `stepSummary` and a chip in `statChip` (`client/js/summary.js`). The process view draws frames and columns from `slots` automatically.
6. **Docs** — update the step table and semantics in `docs/workflow-schema.md`.
7. **Tests** — executor semantics and validation errors in `test/workflow.test.js`; `/api/meta` step list assertion in `test/server.test.js`.
8. Run `npm test` and the `smoke-test` skill (add the step from the palette or a "+" point, configure it, preview).
