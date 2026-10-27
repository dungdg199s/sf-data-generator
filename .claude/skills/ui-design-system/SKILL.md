---
name: ui-design-system
description: Method and deliverables for defining or changing the visual design system of sf-data-generator (colour tokens, typography, spacing, radius, elevation, icons, component states, light/dark themes, accessibility). Use when restyling the UI, adding a component that needs new visual rules, or checking that screen elements are distinguishable.
---

# UI design system

The single source of visual truth is `docs/ui-design-system.md` (Vietnamese) and the CSS custom properties at the top of `client/css/app.css`, which must match it 1:1.

## 1. Audit first
- Inventory every colour, font size, weight, spacing, radius and shadow literal in `client/css/app.css` and inline styles in `client/js/*.js` (`grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|px' ...`). Count distinct values; most should collapse into tokens.
- Screenshot light/dark × 1440/390 for: empty workflow, the sample workflow with a selected step, validation errors, a preview result, the insert confirmation dialog, the migration dialog.
- List problems by severity: meaning collisions (e.g. a step-type colour equal to the accent or to a semantic colour), contrast failures, look-alike states, inconsistent sizes.

## 2. Tokens (two layers)
- **Primitive**: neutral scale (e.g. `--gray-0…--gray-950`), brand/accent scale, semantic hues, category hues. Only primitives contain raw colour values.
- **Semantic** (what components use): `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-accent-contrast`, `--color-focus-ring`, `--color-danger|warning|success|info` (+ `-subtle` backgrounds, `-text`), category tokens per step type and per data kind (`--step-record`, `--step-loop`, `--step-branch`, future `--step-query`, `--step-pick`; variable chips by type).
- Scales: spacing (4 px base: 4/8/12/16/24/32), radius (e.g. 4/6/10/999), font sizes (≤6 steps, rem-based), weights (400/500/600), line heights, elevation (≤3 shadows), z-index layers, motion durations (and `prefers-reduced-motion`).
- Dark theme = remapping of semantic tokens only; components never branch on theme.

## 3. Distinguishability rules
- One meaning per colour. Accent = interactive/selected; semantic colours = status only; category colours = step/data type only. No overlap between these sets.
- Every category is distinguishable without colour: icon + label (+ optional shape/border style). Errors/warnings also carry an icon and text.
- Categorical colours must remain distinguishable under deuteranopia/protanopia (check with a simulation; ΔE or visual check documented).
- States: default, hover, active, focus-visible (always a visible ring ≥ 3:1 against neighbours), selected, disabled, error, warning, dragging/drop-target, "turned off" (disabled step). Each state must differ from the others in at least two channels (colour, border, icon, weight, opacity).

## 4. Accessibility targets
- WCAG 2.2 AA: text ≥ 4.5:1 (≥ 3:1 for ≥ 18.66 px bold / 24 px), UI boundaries and focus rings ≥ 3:1. Put a computed contrast table in the doc for both themes.
- Hit targets ≥ 24×24 px (≥ 44 px on touch layouts).
- Respect `prefers-color-scheme`, `prefers-reduced-motion`, and allow `[data-theme]` override if the design adds a theme switch.

## 5. Component specs
For each component (buttons: primary/secondary/danger/ghost/icon; inputs/selects/textarea; step card; container frame (loop/branch columns); add-point "+"; palette item; inspector sections; field card; chips/badges/stat chips; tabs; tables; dialogs; toasts; issues list; empty states) give: anatomy, tokens used, sizes, and every state. Keep it a table, not prose.

## 6. Deliverables
1. `docs/design/NNNN-*.md` following the design-doc skill (problem with screenshots, options considered, checklist, implementation plan naming files, migration of existing CSS).
2. `docs/ui-design-system.md`: the token tables (light/dark values), scales, component state tables, icon list, do/don't examples.
3. Implementation plan steps small enough for `implementer`: (1) introduce tokens + map old variables, (2) migrate components one group at a time, (3) remove literals, (4) smoke-test screenshots before/after. Add a check (test or script) that fails when raw colour literals appear outside the primitive token block.
