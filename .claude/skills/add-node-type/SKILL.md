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
5. **UI** — colours and icon (design system, `docs/ui-design-system.md` §3.4, §5, §10; never hard-code colours in JS):
   - pick an OKLCH hue at least 35° away from the hues in use (not the accent or a status hue) and rerun the contrast + colour-blind check of design doc 0008;
   - in the token block of `client/css/app.css` add the primitives (`--<family>-50/100/600/700` for light, `-300/200` for dark), the four tokens `--step-<type>`, `--step-<type>-subtle`, `--step-<type>-strong`, `--step-<type>-text` in the light block **and in both dark blocks** (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`), and an icon `--ico-<type>` (24×24 SVG, stroke 2, as a `data:` URL);
   - below `/* ===== end tokens ===== */` add one `[data-type="<type>"]` rule setting `--c`, `--c-subtle`, `--c-strong`, `--c-text` and `--ico`. The JS only sets `data-type="<step.type>"` and inserts `icoTile()` (`client/js/dom.js`), which process view, palette, "+" menu and inspector already do;
   - update the tables in `docs/ui-design-system.md` (§2 primitives — `test/css-tokens.test.js` compares it with the CSS —, §3.4, §5, §8.1);
   - add a summary in `stepSummary` and a chip in `statChip` (`client/js/summary.js`). The process view draws frames and columns from `slots` automatically.
6. **Docs** — update the step table and semantics in `docs/workflow-schema.md`.
7. **Tests** — executor semantics and validation errors in `test/workflow.test.js`; `/api/meta` step list assertion in `test/server.test.js`. `test/css-tokens.test.js` fails until the new type has its tokens, icon and `[data-type]` rule in both themes and its colour pairs pass WCAG AA.
8. Run `npm test` and the `smoke-test` skill (add the step from the palette or a "+" point, configure it, preview).
