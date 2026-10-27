---
name: add-field-type
description: Step-by-step checklist for adding a new Salesforce field-type generator (or a new option on an existing one) in sf-data-generator, including UI exposure, describe mapping, tests and docs.
---

# Add a field type

The UI renders field types and their options from `GET /api/meta`, so a new generator needs **no client code** unless it introduces a new option `kind`.

1. **Pick the module** in `server/generators/` by category (`text.js`, `number.js`, `choice.js`, `date.js`, `reference.js`, `misc.js`), or create a new module if none fits.
2. **Write the generator object** following the contract in `docs/field-types.md`:
   - `type` (lowercase, no spaces — it is stored in saved workflows, never rename it), `label`, `category`, `sfTypes`.
   - `nullable: false` if Salesforce never stores null for this type; `uniqueable: true` if uniqueness makes sense.
   - `options` via `opt(key, labelVi, kind, default, { min, max, step, choices, help, showIf })`. Defaults must give valid data with zero configuration.
   - `generate(o, ctx)`: use `ctx.rng` for randomness and `ctx.now` for time. Respect Salesforce limits (length, precision/scale, REST value format). Throw `Error` with a Vietnamese message that says how to fix the config; the executor attaches `nodeId`/`field`.
3. **Register** it in the `GENERATORS` array in `server/generators/index.js` (order = order in the UI dropdown within its category).
4. **Describe mapping**: in `server/sf/describe-map.js`, map the describe `type` (and hints like `extraTypeInfo`, `length`, `precision`, `scale`, `picklistValues`) to the new type with sensible options.
5. **Insert format**: if the value is not a plain scalar (like geolocation's `{ latitude, longitude }`), convert it in `toSObject` in `server/sf/insert.js`.
6. **New option kind?** Only then edit `renderControl` in `client/js/forms.js` and `coerce` in `server/generators/common.js`, and add the kind to the list in `docs/field-types.md`.
7. **Tests** in `test/generators.test.js`: defaults work (covered by the "every generator" test automatically), each option's effect, edge cases (min > max, empty lists), seed reproducibility. Describe mapping test in `test/sf.test.js`.
8. **Docs**: add a row to the table in `docs/field-types.md`.
9. Run `npm test`. For visible changes, run the `smoke-test` skill and check the type appears in the field-type dropdown with its options.
