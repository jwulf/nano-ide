# Nano workflow app — workflow-starter

A **code-first durable workflow** project (ADR 0044/0045). You write ordinary
async code; [`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow)
derives the executable BPMN model, the job types and the wiring, and hosts a
generic worker against a running Nano gateway.

## Run

```sh
deno task start
```

Point at a non-default gateway with `NANOBPMN_BASE_URL`.

`deno.json` is the single source of truth for the `@nanobpm/workflow` version.

## Author

- `workflows/pr-review.ts` — an example imperative workflow. Add more with
  `defineWorkflow(id, async (ctx) => { ... })` and list them in `main.ts`.
- Every side effect goes inside a `ctx.run(name, fn)` step. On an engine crash a
  completed step is **replayed from the journal** (its `fn` is not re-run) and
  only the frontier step executes — so the workflow resumes without repeating
  work. Jobs are **at-least-once**: keep step handlers idempotent.
- For a human-in-the-loop wait, use the declarative surface (`defineFlow` with
  `w.run` / `w.signal`) instead.

## What gets derived

`WorkflowClient.deploy(wf)` deploys the BPMN that `@nanobpm/workflow` emits from
your code; the `Worker` routes the derived job types (`{id}:step`) back to your
step bodies. Inspect the derived model with `toBpmn(wf)` — the Nano console shows
it in a read-only **Model** view for this project.
