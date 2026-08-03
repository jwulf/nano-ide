# `@nanobpm/nano-ide-app-urban`

The **Urban app** pack for the Nano RAD IDE (Nano Studio).

Installing this pack teaches Studio to scaffold and run full-stack **Urban**
apps — a `nano.app.json` manifest plus processes, forms, a database and
workers — using the out-of-process [`@nanobpm/urban`](https://www.npmjs.com/package/@nanobpm/urban)
toolkit (the `urban` CLI and the `create-urban-app` scaffolder), which run on
both Node and Deno (ADR 0052).

## What it contributes

Two **New Project** templates:

- **Urban app (model-first)** — the process is an authored `processes/*.bpmn`
  (opens in the modeller) with forms, run by `urban run`.
- **Urban app (code-first)** — the process is authored in TypeScript with
  `defineFlow`; `@nanobpm/urban` derives the executable model.

## Why it declares `installDeps`

Unlike a template pack that bundles static files, this pack *fronts npm CLIs*:
its `urban` and `create-urban-app` binaries live in its dependencies. An
`npm pack` tarball ships `package.json` but **not** `node_modules`, so the pack
sets `"installDeps": true` in its `nano-ide.ext.json`. Studio's marketplace
installer honours that flag by running a guarded `npm install` inside the pack
after fetching it, materialising `node_modules/.bin/{urban,create-urban-app}`.
The host resolves the `urban` CLI from exactly that path (the pack-first
resolver), so the toolkit is present *before* a project is created
("install-before-create").

The install is guarded: `--omit=dev` (no dev dependencies) and
`--ignore-scripts` until you trust the pack.

## License

Apache-2.0
