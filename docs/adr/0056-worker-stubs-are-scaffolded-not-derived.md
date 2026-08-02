# ADR 0056 — Worker handler stubs are scaffolded (write-once), not derived

Status: Accepted
Date: 2026-07
Relates to: ADR 0033 (typed worker bindings), ADR 0053 (derivation is a shared
library), ADR 0054 (one code-first stack). Depends on PR #71 (`AppJobHandler`
generics).

## Context

Model-first analysis established that, given a BPMN model, almost everything an
Urban app needs is *mechanically derivable*:

- the worker type map (`nano-generated/worker-io.d.ts`) — already derived by
  `deriveWorkerBindings` from the model's data-envelope contract (ADR 0033 §3);
- SQL migrations from the manifest `types` — already derived by
  `deriveMigrations`;
- surfaces, triggers, data access — projected by the runtime from the manifest.

The one thing that is **not** derivable is a service task's **handler body** — the
business logic a human writes. Today an author must, for each service task,
hand-create `workers/<slug>/worker.ts`, hand-wire it into `manifest.workers[]`,
and hand-import the right generated types. That boilerplate is mechanical, but
the *body* is not — so it is a scaffolding problem, not a derivation problem.

## Decision

Add a **write-once worker-stub scaffolder** (`urban stubs`) that, from the model,
creates a typed handler stub per un-wired service task and wires it into the
manifest — and then **never touches it again**.

The load-bearing distinction is **scaffold ≠ derive**:

| | `urban gen` (derive) | `urban stubs` (scaffold) |
|---|---|---|
| Output location | `nano-generated/` (gitignored) | `workers/<slug>/worker.ts` (committed) |
| Ownership | machine-owned | human-owned |
| On re-run | **overwrite always** | **write-if-absent, never clobber** |
| Drift-checked (`--check`) | yes (CI gate) | no |
| Default action | write | **dry-run** (`--write` to apply) |

Because a stub is human-owned and edited after creation, it must **not** flow
through the `Deriver`/`runGen`/`--check` path (which exists precisely to
overwrite and drift-gate the generated tree). It is a separate command with a
dry-run default.

### What a stub is

A stub matches a real hand-authored worker exactly (cf.
`workers/persist-round/worker.ts`): a default-exported `AppJobHandler` that
`throw`s "not implemented" so an un-implemented worker fails loudly rather than
silently acking. It carries the **types** from the model:

```ts
import type { AppJobHandler } from "@nanobpm/urban";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

const handler: AppJobHandler<WorkerInputs["pr.finalize"], WorkerOutputs["pr.finalize"]> =
  async (job, app) => {
    // job.variables is typed as WorkerInputs["pr.finalize"].
    throw new Error("worker not implemented: pr.finalize");
  };

export default handler;
```

The typing rides on the `AppJobHandler<In, Out>` generics added in PR #71:
`job.variables` is typed as `In`, the return as `Out`. A task's `in`/`out` is
"typed" iff its data-envelope value names a **declared** domain type
(`manifest.types`) — the same rule the worker-io deriver uses (`typeRefFor`), so
a stub is typed exactly when `worker-io.d.ts` has a key for it. Otherwise the
generic slot is omitted (open `Record<string, unknown>` default) and no generated
import is emitted. Keys use `JSON.stringify(taskType)` (indexed access), matching
the deriver's property keys.

> Prerequisite: the generic `AppJobHandler<In, Out>` ships in `@nanobpm/urban`
> ≥ 0.14.0 (PR #71). Generated stubs typecheck against that version.

### What is skipped (never stubbed)

- **Already-wired** task types (`manifest.workers[].taskType`) — the manifest
  wins; this also covers `llm`-bound workers, which live there.
- The **imperative orchestrator** task (`<workflowId>:__orchestrate`, ADR 0054 /
  `defineWorkflow`) — it is engine-internal, not an author handler.
- **Duplicates** — a task type appearing in several models is stubbed once.

### Manifest wiring

For every stubbed (or pre-existing but un-wired) task, `--write` appends
`{ taskType, handler }` to `manifest.workers[]` (creating the array if absent).
This reformats the manifest with 2-space indent — acceptable for a scaffolding
tool and only done under `--write`.

## Consequences

- The model remains the single source of truth for *structure and types*; humans
  own only the *bodies*. Re-running `urban stubs` after adding a task creates just
  the new stub and leaves edited ones untouched.
- Never generating bodies keeps the tool honest: it scaffolds the seam, it does
  not fabricate logic.
- Two commands with opposite semantics (`gen` overwrites+checks; `stubs`
  write-once) keep the human-owned tree away from the drift gate — a stub edit can
  never fail `urban gen --check`.
- Imperative `defineWorkflow` apps (single degenerate orchestrator task) are not a
  target: their logic is code, not model-shaped, so there is nothing to stub.
