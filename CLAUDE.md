# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

The repository is empty apart from this file: no code, `package.json`, build, lint or test setup exists yet. Everything below describes the **intended** design from the project brief. When you add tooling (npm scripts, test runner, linter), add the real commands here, including how to run a single test, and remove the "planned" wording from anything that now exists.

## What this project is

A test-data generator for Salesforce. It produces values that satisfy Salesforce field data types, each with its own configurable options, and can push the generated records into a Salesforce org.

- **Workflow UI:** users build the generation as a node graph (like a workflow editor). Nodes can **loop** (repeat a sub-flow N times or per item) and **branch** (route by a condition).
- **Run model:** on Run, the browser serializes the whole graph to **workflow JSON** and POSTs it to the Node.js server. The server interprets the workflow and generates the data. The UI holds no generation logic, so the server owns the type generators and the executor.
- **Org connection:** org credentials come from the **Salesforce CLI (`sf`) already installed and authenticated on the user's machine** (for example `sf org list --json` and `sf org display --target-org <alias> --json` for the access token and instance URL). The app does not run its own OAuth flow for now, and it must not store credentials itself.

## Stack constraints

- Server: Node.js.
- Client: plain HTML and JavaScript. Add React or Tailwind only when they are really needed; don't bring in heavy frameworks by default.

## Intended architecture

The pieces below have to agree on one contract, the workflow JSON schema, so define it in one place and validate it on the server before execution.

1. **Workflow JSON schema:** nodes (id, type, config) plus edges. Loop and branch nodes carry their own config (iteration count or source, condition expression). The UI produces it and the server consumes it.
2. **Field-type generators (server):** one generator per Salesforce data type (Text, TextArea, Long/Rich Text, Email, Phone, URL, Number, Currency, Percent, Checkbox, Date, DateTime, Time, Picklist, Multi-Select Picklist, Lookup/Master-Detail reference, Geolocation, Auto Number, and so on). Each generator declares its option schema (length, precision/scale, min/max, picklist values, null ratio, uniqueness, and similar), and the UI should render its config forms from that declaration rather than duplicate it.
3. **Workflow executor (server):** walks the graph, keeps a context for each iteration so later nodes can reference earlier generated records (needed for lookups and parent/child data), and evaluates loops and branches.
4. **Org integration (server):** shells out to `sf` for the connection, optionally describes sObjects to pre-fill field types and options, and inserts the generated records, using the Bulk API for large volumes.
5. **UI (client):** node canvas, per-node config panels, and the Run action that sends the workflow JSON and shows the results or errors.
