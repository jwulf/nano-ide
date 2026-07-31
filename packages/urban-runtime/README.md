# Urban runtime — `@nanobpm/urban-runtime`

> The decoupled interpreter that **runs** an Urban app from its `nano.app.json`
> manifest, on **both Node and Deno**. No console required. (ADR 0052.)

An Urban app is a directory with a `nano.app.json` manifest that names its
processes, forms, datasources and workers. This package reads that manifest and
runs the app: it selects a host, validates the manifest, wires an
`EngineClient`, starts the app's workers, and connects to a nano-bpm engine.

The runtime ships as source `.ts` (no build step, matching `connector-slack`).
It needs Node ≥ 22.6 (run tests/code with `--experimental-strip-types`) or Deno.

## Use

```ts
import { runFromEnv } from "@nanobpm/urban-runtime";

await runFromEnv(); // reads ./nano.app.json + env, starts the app
```

Or point it at a manifest and pick a transport explicitly:

```ts
import { loadManifest, validateManifest, RestEngineClient } from "@nanobpm/urban-runtime";

const manifest = validateManifest(await loadManifest("./nano.app.json"));
const engine = new RestEngineClient({ baseUrl: process.env.CAMUNDA_REST_ADDRESS! });
```

## Engine transport

The `EngineClient` is a thin seam with two implementations:

| Transport | When | How |
|---|---|---|
| `RestEngineClient` | default; dependency-free | Orchestration Cluster REST |
| `createNanoSdkEngineClient` | `CAMUNDA_TRANSPORT` ≠ `rest` | `@nanobpm/nano-sdk` — **Falcon** protocol on the instance-creation hot path, REST fallback for cold paths |

`@nanobpm/nano-sdk` is an **optional** dependency, imported lazily; if it is not
installed the runtime falls back to REST. Select it via `CAMUNDA_TRANSPORT` or
the `transport` option to `runFromEnv`.

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — Node test runner (strip-types)
- `npm run test:deno` — Deno test runner

## See also

- `@nanobpm/urban-toolkit` — derives the app's generated modules (ADR 0053)
- `@nanobpm/urban` — the CLI that drives this runtime (`urban run`/`dev`)
- `create-urban-app` — scaffolds a runnable app around this runtime
