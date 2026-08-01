# `@nanobpm/urban`

Build and run **code-first apps on Nano** — the runtime, the derivation toolkit,
and the `urban` CLI in one package, on **Node or Deno**.

An Urban app is a directory with a `nano.app.json` manifest that declares its
processes, forms, datasources, workers, HTTP surfaces and triggers. This package
brings it to life and gives you a library API to embed or extend it. Author your
durable processes in code with [`@nanobpm/workflow`](../workflow)
(`defineFlow`) — re-exported from here for convenience.

## Install

```bash
npm i -g @nanobpm/urban      # install the `urban` command
# or run without installing:
npx @nanobpm/urban new my-app
# or on Deno:
deno run -A npm:@nanobpm/urban run
```

Requires Node ≥ 22.6 or Deno. It ships as TypeScript source with no build step;
on Node < 23.6 the `urban` command re-executes with `--experimental-strip-types`.

## The `urban` CLI

| Command | What it does |
|---|---|
| `urban new <name>` | scaffold a new app in a new directory |
| `urban check` | validate the app's `nano.app.json` manifest |
| `urban gen` | generate the `nano-generated/` artifacts (migrations, worker I/O) |
| `urban gen --check` | fail if the generated artifacts are out of date (a CI drift gate) |
| `urban run` | generate, then run the app — starts its workers and serves its surfaces |
| `urban dev` | run the app (hot-reload is not yet implemented) |
| `urban deploy` | deploy the app's models to the engine, then exit |

### Options

| Flag | Purpose | Default |
|---|---|---|
| `--root <dir>` | app directory | `.` |
| `--manifest <file>` | manifest filename | `nano.app.json` |
| `--port <n>` | HTTP port for surfaces and triggers (integer 0–65535) | `$PORT` or `8090` |
| `-h`, `--help` | show help | |
| `-v`, `--version` | print the version | |

The engine address comes from `$CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`). Set `$CAMUNDA_TRANSPORT` to a non-`rest` value to use
the `@nanobpm/nano-sdk` transport when it is installed.

### A typical session

```bash
urban new invoices && cd invoices
urban gen        # generate nano-generated/
urban check      # validate the manifest
urban run        # start workers and serve surfaces
```

## Library API

Everything the CLI does is available programmatically. Import the whole surface
from `@nanobpm/urban`, or the focused subpaths `@nanobpm/urban/runtime` and
`@nanobpm/urban/toolkit`.

### Runtime — run an app

```ts
import { runFromEnv } from "@nanobpm/urban";

const app = await runFromEnv();          // reads ./nano.app.json and the environment
console.log(app.inspect());              // { app, name, httpPort, ... }
```

`runFromEnv` reads the engine address and transport from the environment, starts
the app (validate → deploy → provision datasources → start workers → serve
surfaces and webhook triggers), and installs SIGINT/SIGTERM handlers for a
graceful shutdown. For full control, assemble the pieces yourself:

```ts
import { createUrbanApp, selectHost, RestEngineClient } from "@nanobpm/urban";

const host = selectHost();                       // picks the Node or Deno adapter
const engine = new RestEngineClient({ baseUrl: process.env.CAMUNDA_REST_ADDRESS! });
const app = await createUrbanApp({ host, engine, root: "." });
await app.start();
// ... later:
await app.stop();                                // releases workers, server, datasources
```

Two engine transports are built in: `RestEngineClient` (default, no extra
dependencies) and `createNanoSdkEngineClient` (used when `CAMUNDA_TRANSPORT` is
anything other than `rest`; needs the optional `@nanobpm/nano-sdk`).

### Toolkit — derive artifacts (`urban gen`)

```ts
import { runGen, createNodeGenIO } from "@nanobpm/urban";

const io = createNodeGenIO();
await runGen({ root: ".", io });                 // writes nano-generated/
const { drift } = await runGen({ root: ".", io, check: true });  // CI drift gate
```

Each deriver is a pure `(input) → artifacts` function you can also call directly:

| Deriver | Input | Output |
|---|---|---|
| `deriveMigrations` | the manifest's datasource types | `nano-generated/<source>.schema.sql` (`CREATE TABLE` per type) |
| `deriveWorkerBindings` | BPMN service tasks + their data-envelope I/O | `nano-generated/worker-io.d.ts` (typed worker input/output) |

Derivers are deterministic — the same input produces byte-identical output — so
generated files are safe to commit and to gate in CI.

### Code-first processes

Author durable processes in code with `defineFlow`, re-exported from
[`@nanobpm/workflow`](../workflow):

```ts
import { defineFlow, WorkflowClient, Worker } from "@nanobpm/urban";

const flow = defineFlow("pr-review", (w) => {
  w.run("fetchDiff", async (job) => ({ files: 3 }));
  w.signal("humanApproval", { correlationKey: "prId" }); // durable human wait
  w.run("merge", async (job) => ({ merged: true }));
});
```

The SDK derives the executable BPMN, the job types, and the message/correlation
wiring; `WorkflowClient` deploys and starts, `Worker` hosts your `run` steps.
`deploy` emits an auto-generated diagram (DI) so the deployed model is
inspectable in a modeller/Operate — `@nanobpm/urban` bundles `bpmn-auto-layout`
so this works out of the box.

## Related packages

- [`@nanobpm/workflow`](../workflow) — the code-first process surface (`defineFlow`).
- [`create-urban-app`](../create-urban-app) — the scaffolder behind `urban new`.
