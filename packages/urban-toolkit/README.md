# Urban toolkit — `@nanobpm/urban-toolkit`

> Derivation as a **library**, not an IDE feature. Pure, deterministic
> `derive(inputs) → artifacts` functions that both the IDE and the `urban gen`
> CLI call, producing the console's `nano-generated/` output as a drop-in.
> (ADR 0053, extends ADR 0052.)

An Urban app is not only *run* — it is *derived*. The console currently derives
typed modules from the model and the database into `nano-generated/` as a side
effect of the IDE running. This package lifts that derivation into a shared,
decoupled library so agents, CI and standalone users can regenerate outside the
console, with a **drift gate**.

## Invariants

1. **Derivers are pure and deterministic** — `(input) → DerivedArtifact[]`, no
   IO, byte-identical output for identical input.
2. **All IO is confined** to the `gen` orchestrator behind a tiny FS port
   (`GenIO`), so the same code runs on Node and Deno.
3. **Output is a drop-in** for the console: same `nano-generated/` directory,
   same filenames, same `@nanobpm/*` specifiers.
4. **The model is authoritative; artifacts are a cache** — `urban gen --check`
   regenerates in memory and fails on drift.

## Derivers (first cut)

| Deriver | Input | Output |
|---|---|---|
| `deriveMigrations` | datasource types | `nano-generated/<source>.schema.sql` (CREATE TABLE) |
| `deriveWorkerBindings` | BPMN service tasks + data-envelope io | `nano-generated/worker-io.d.ts` — a **byte-compatible port** of the console's `emitWorkerBindings` (ADR 0033 §3) |
| `deriveModelFromFlow` | a code-first flow | `nano-generated/processes/<id>.bpmn` (BPMN + DI, auto-layout) |

## Use

```ts
import { runGen, createNodeGenIO } from "@nanobpm/urban-toolkit";

const io = createNodeGenIO();
await runGen({ root: ".", io });               // write nano-generated/
await runGen({ root: ".", io, check: true });  // drift gate — throws on mismatch
```

Or call a deriver directly (pure, no IO) and inspect the artifacts.

## Migration path

The console migrates onto the toolkit **emitter-by-emitter**, lowest-risk first
(`worker-io` → `messages`/`meta` → `domain`), with `urban gen --check` proving
parity at each step. See ADR 0053.

## Scripts

- `npm run typecheck`
- `npm test` (Node, strip-types) · `npm run test:deno`
