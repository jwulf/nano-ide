# `@nanobpm/urban-runtime`

Run an Urban app from its `nano.app.json` manifest — on **Node or Deno**, with no
console or IDE required.

An Urban app is a directory with a `nano.app.json` manifest that declares its
processes, forms, datasources, workers, HTTP surfaces and triggers. This package
reads that manifest and brings the app to life: it validates the manifest,
connects to a nano-bpm engine, deploys the models, provisions the datasources,
starts the workers, and serves the app's HTTP surfaces and webhook triggers.

Requires Node ≥ 22.6 (with `--experimental-strip-types`) or Deno. It ships as
TypeScript source with no build step.

## Install

```bash
npm i @nanobpm/urban-runtime
```

## Quick start

Run the app in the current directory:

```ts
import { runFromEnv } from "@nanobpm/urban-runtime";

const app = await runFromEnv();          // reads ./nano.app.json and the environment
console.log(app.inspect());              // { app, name, httpPort, ... }
```

`runFromEnv` reads the engine address and transport from the environment, starts
the app, and installs SIGINT/SIGTERM handlers for a graceful shutdown. Useful
options:

```ts
await runFromEnv({
  root: "./my-app",        // app directory (default ".")
  port: 3000,              // HTTP port for surfaces/triggers (default $PORT or 8090)
  restAddress: "http://localhost:8080/v2",
  handleSignals: false,    // manage the lifecycle yourself
});
```

## Building an app by hand

For full control, assemble the pieces yourself:

```ts
import {
  createUrbanApp,
  selectHost,
  RestEngineClient,
} from "@nanobpm/urban-runtime";

const host = selectHost();                       // picks the Node or Deno adapter
const engine = new RestEngineClient({ baseUrl: process.env.CAMUNDA_REST_ADDRESS! });

const app = await createUrbanApp({ host, engine, root: "." });
await app.start();
// ... later:
await app.stop();                                // releases workers, server, datasources
```

`createUrbanApp` returns an `UrbanApp` with `start()`, `stop()`, `inspect()`, and
accessors for `data`, `security` and `httpPort`. A failed `start()` tears down
anything it mounted and resets state, so the app can be started again.

## Connecting to the engine

The runtime talks to a nano-bpm engine through an `EngineClient`. Two are built in:

| Transport | When it is used | What it does |
|---|---|---|
| REST (`RestEngineClient`) | default; no extra dependencies | Orchestration Cluster REST API |
| nano-sdk (`createNanoSdkEngineClient`) | `CAMUNDA_TRANSPORT` set to anything other than `rest` | uses `@nanobpm/nano-sdk` (Falcon protocol) for instance creation, falling back to REST for everything else |

`@nanobpm/nano-sdk` is an optional dependency, imported only when requested. If it
is not installed, the runtime uses REST.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `CAMUNDA_REST_ADDRESS` | engine REST base URL | `http://localhost:8080/v2` |
| `CAMUNDA_TRANSPORT` | `rest`, or any other value to use the nano-sdk transport | `rest` |
| `CAMUNDA_TOKEN` | bearer token for the engine, if required | — |
| `PORT` | HTTP port for surfaces and triggers | `8090` |

## Related packages

- [`@nanobpm/urban`](../urban-cli) — a CLI that scaffolds, checks, derives and runs Urban apps.
- [`@nanobpm/urban-toolkit`](../urban-toolkit) — derives an app's generated artifacts (migrations, worker I/O, BPMN).
- [`create-urban-app`](../create-urban-app) — scaffolds a new, runnable Urban app.
