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

Requires Node ≥ 22.6 or Deno. It ships as compiled JavaScript with `.d.ts` type
declarations: Node can't strip types under `node_modules`, so the published package
carries `dist/` and needs no build step or `--experimental-strip-types` flag to run.
Deno users can still import the TypeScript source directly via the `./source` export.

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
`http://localhost:8080/v2`). Transport comes from `$CAMUNDA_TRANSPORT` (default
`auto`): the `@nanobpm/nano-sdk` client upgrades instance creation and job
serving to Falcon on a Nano server and falls back to REST elsewhere. Set it to
`rest`, `falcon`, or `embedded` to pin a specific transport.

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
surfaces and webhook + cron triggers), and installs SIGINT/SIGTERM handlers for a
graceful shutdown. For full control, assemble the pieces yourself:

```ts
import { createUrbanApp, selectHost, createNanoSdkEngineClient } from "@nanobpm/urban";

const host = selectHost();                       // picks the Node or Deno adapter
const engine = await createNanoSdkEngineClient({
  restAddress: process.env.CAMUNDA_REST_ADDRESS!,
  transport: process.env.CAMUNDA_TRANSPORT,      // "auto" (default) | "rest" | "falcon" | "embedded"
});
const app = await createUrbanApp({ host, engine, root: "." });
await app.start();
// ... later:
await app.stop();                                // releases workers, server, datasources
```

The runtime has a single engine client, `SdkEngineClient`, backed by one
`@nanobpm/nano-sdk` client (a direct dependency). `createNanoSdkEngineClient`
selects the wire transport via `CAMUNDA_TRANSPORT`: `auto` (default) upgrades to
Falcon on a Nano server and falls back to REST elsewhere.

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

### Triggers — the inbound I/O edge

Declare `triggers[]` in the app manifest to turn outside events into engine
calls (start a process or publish a message). Two source kinds are built in:

- **`webhook`** — mounts an HTTP `POST` route (`/hooks/<id>` by default), with
  optional `hmac:<connection>` signature verification and delivery-id
  idempotency.
- **`cron`** — arms a background timer from a 5-field crontab `spec` (evaluated
  in **UTC**), firing its `action` on schedule and rescheduling itself.

```jsonc
{
  "triggers": [
    { "id": "nightly", "type": "cron", "spec": "0 6 * * *",
      "action": { "start": "daily-report" } },
    { "id": "gh", "type": "webhook", "auth": "hmac:github",
      "action": { "message": "pr-opened", "correlationKey": "= body.number" } }
  ]
}
```

Cron scheduling is **app-side**: per-replica, in-memory, and it stops when the
process stops — glue for invoking handlers on a clock, not a durable clustered
scheduler. It therefore only honours `onMissed: "skip"` (the default); a declared
`"once"`/`"all"` catch-up needs a persisted last-fire the runtime does not keep,
so it warns and degrades to `skip`. For **durable, clustered** scheduling that
survives restarts, model a timer **start**/**intermediate** event instead with
`w.startOn(...)` / `w.timer(...)` from [`@nanobpm/workflow`](../workflow) — the
engine owns those.

## Related packages

- [`@nanobpm/workflow`](../workflow) — the code-first process surface (`defineFlow`).
- [`create-urban-app`](../create-urban-app) — the scaffolder behind `urban new`.
