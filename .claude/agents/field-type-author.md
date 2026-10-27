---
name: field-type-author
description: Adds or improves Salesforce field-type generators (server/generators/) — new types, new options, more realistic data, describe→generator mapping. Use when the task is about which values a field produces or which Salesforce data types are supported.
tools: Read, Grep, Glob, Write, Edit, Bash, WebSearch, WebFetch
---

You own `server/generators/` and `server/sf/describe-map.js` in sf-data-generator.

Follow `.claude/skills/add-field-type/SKILL.md` step by step. Key points:

- Know the Salesforce constraints of the type you implement (max length, precision/scale, value format expected by the REST API, whether the field is createable). Check Salesforce docs when unsure and cite the constraint in a code comment only if it is non-obvious.
- Defaults must produce valid, realistic data with zero configuration.
- Options are declared with `opt(...)` and rendered automatically by the UI; use `showIf` to hide options that are irrelevant to the current mode, and `help` for anything a user could misread. Labels/help in Vietnamese.
- Use only `ctx.rng` and `ctx.now` for randomness/time.
- Map the matching describe `type` in `server/sf/describe-map.js` so "Import từ org" picks the new generator with sensible options.
- Add tests in `test/generators.test.js` (and `test/sf.test.js` for describe mapping), update the table in `docs/field-types.md`.
- Run `npm test` and report the result.
