---
name: design-doc
description: Write or update a usability-focused design doc in docs/design/ for a sf-data-generator feature. Use when planning a feature, when the user asks for a design/plan to be recorded, or when a shipped feature's design doc needs its "Đã làm" section updated.
---

# Design doc

Design docs live in `docs/design/` and are written in Vietnamese (identifiers stay English).

## New design doc

1. Pick the next number: look at `docs/design/` and use the highest `NNNN` + 1, zero-padded to 4 digits. File name `NNNN-short-kebab-title.md`.
2. Copy `docs/design/TEMPLATE.md` and fill every section. Delete a section only if it truly does not apply, and say why in one line.
3. **Luồng người dùng**: write the main path as numbered steps and put the action count in parentheses per step, as in `0001-workflow-editor-ux.md`. If the main path needs more than ~5 actions, look for defaults, auto-fill from org describe, or auto-connect to remove steps.
4. **Thiết kế UI**: give exact labels, default values, placement, keyboard shortcuts, and the exact error/warning messages (Vietnamese, telling the user how to fix it).
5. **Thay đổi dữ liệu / API**: show JSON before/after for workflow schema changes; state backward compatibility with saved `version: 2` workflows (and `version: 1`, which is migrated); prefer adding option definitions (`kind`, `default`, `showIf`, `help`) on the server over UI-specific code.
6. **Checklist tiện dụng**: tick each of the 9 principles from `docs/design/README.md`; for any unticked item write the reason.
7. **Phương án đã cân nhắc**: at least two options with trade-offs, mark the chosen one.
8. **Kế hoạch thực hiện**: small steps, each naming the files touched and how it is verified (test name or smoke-test step). Follow the contract-sync table in `.claude/agents/implementer.md`.
9. Add a row to the index table in `docs/design/README.md` with status `Nháp`.

## Updating after implementation

- Fill "Đã làm" with the commit/PR and any deviation from the design (and why).
- Change status to `Đã làm` in both the doc and the index.
- Make sure reference docs (`workflow-schema.md`, `field-types.md`, `org-connection.md`, `architecture.md`) no longer mark the feature "(dự kiến)".

## Quality bar

- Concrete over generic: "Bấm Record khi đang chọn bước Lặp có thân rỗng → bước mới vào thân vòng lặp" not "dễ sử dụng".
- Every org write has a confirmation that names the org and record counts.
- No design may require configuration before the first preview produces data.
