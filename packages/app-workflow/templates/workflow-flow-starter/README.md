# Nano workflow app — workflow-flow-starter

A **code-first _declarative_ durable workflow** project (ADR 0044/0045). You
declare an ordered list of steps; [`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow)
derives the executable BPMN model, the job types, and the message/correlation
wiring, and hosts a generic worker against a running Nano gateway.

Unlike the imperative starter, a declarative flow can **`signal`** — a durable
wait for an external or human event. This example parks at a `humanApproval`
signal and resumes when a correlated message arrives.

## Run

```sh
deno task start
```

The demo deploys the flow, starts an instance, waits until it parks at
`humanApproval`, then sends the approval and runs to completion. Point at a
non-default gateway with `NANOBPMN_BASE_URL`.

`deno.json` is the single source of truth for the `@nanobpm/workflow` version.

## Author

- `workflows/pr-review-flow.ts` — an example declarative flow. Declare steps with
  `defineFlow(id, (w) => { w.run(name, fn); w.signal(name, { correlationKey }); })`
  and list the flow in `main.ts`.
- **`w.run(name, fn)`** is a durable activity (a BPMN service task) served by the
  worker. Jobs are **at-least-once** — keep each handler idempotent.
- **`w.signal(name, { correlationKey })`** is a durable wait (a BPMN message catch
  event). The instance parks until `client.signal(flow, name, correlationKeyValue,
  vars)` correlates a message on the named process variable (here `prId`). The
  signal's `vars` are merged into the instance, so later steps can read them.
- For a pure imperative loop with replay (no human wait), use the
  `workflow-starter` template instead (`defineWorkflow(id, async (ctx) => …)`).

## What gets derived

`WorkflowClient.deploy(flow)` deploys the BPMN that `@nanobpm/workflow` emits from
your code (a `serviceTask` per `run`, an `intermediateCatchEvent` +
`<bpmn:message>` + `zeebe:subscription correlationKey` per `signal`); the `Worker`
routes the derived job types (`{id}:step`) back to your step bodies. Inspect the
derived model with `toBpmn(flow)` — the Nano console shows it in a read-only
**Model** view for this project.
