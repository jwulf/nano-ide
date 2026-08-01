# `@nanobpm/urban-toolkit`

Generate an Urban app's derived artifacts — SQL migrations, worker I/O types and
BPMN — from its manifest and models. Pure functions plus a small file-IO
orchestrator that runs the same on **Node and Deno**.

Use it two ways: call `runGen` to (re)generate the whole `nano-generated/`
directory for an app, or call an individual deriver to turn one input into
artifacts in memory.

## Install

```bash
npm i @nanobpm/urban-toolkit
```

## Generate an app's artifacts

```ts
import { runGen, createNodeGenIO } from "@nanobpm/urban-toolkit";

const io = createNodeGenIO();
await runGen({ root: ".", io });          // writes nano-generated/
```

Check for drift instead of writing — regenerates in memory and reports the paths
that differ from what's on disk (empty ⇒ up to date):

```ts
const { drift } = await runGen({ root: ".", io, check: true });
if (drift.length) throw new Error(`out of date: ${drift.join(", ")}`);
```

## Derivers

Each deriver is a pure `(input) → artifacts` function you can call directly, with
no file IO:

| Deriver | Input | Output |
|---|---|---|
| `deriveMigrations` | the manifest's datasource types | `nano-generated/<source>.schema.sql` (`CREATE TABLE` per type) |
| `deriveWorkerBindings` | BPMN service tasks + their data-envelope I/O | `nano-generated/worker-io.d.ts` (typed worker input/output) |
| `deriveModelFromFlow` | a code-first flow definition | `nano-generated/processes/<id>.bpmn` (BPMN with auto-layout) |

```ts
import { deriveMigrations } from "@nanobpm/urban-toolkit";

const artifacts = deriveMigrations(manifest);   // DerivedArtifact[] — { path, content }
```

Derivers are deterministic: the same input always produces byte-identical output,
so generated files are safe to commit and to gate in CI.

## Running on Deno

All IO goes through a small `GenIO` port. `createNodeGenIO()` implements it with
`node:fs/promises`, which both Node and Deno provide, so a single implementation
serves both runtimes. Supply your own `GenIO` to generate against an in-memory or
virtual filesystem.

## Related packages

- [`@nanobpm/urban`](../urban-cli) — the CLI whose `urban gen` command wraps this toolkit.
- [`@nanobpm/urban-runtime`](../urban-runtime) — runs the app the artifacts belong to.
