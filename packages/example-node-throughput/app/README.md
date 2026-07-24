# Node throughput demo

An async producer flood + JobWorker on
[`@nanobpm/nano-sdk`](https://www.npmjs.com/package/@nanobpm/nano-sdk) — a
drop-in for the official
[`@camunda8/orchestration-cluster-api`](https://www.npmjs.com/package/@camunda8/orchestration-cluster-api).
One code path runs against **Camunda 8** (plain REST) or **Nano** (the SDK
upgrades `createProcessInstance` to the credit-metered command stream / Falcon
transport and the JobWorker to a streaming push subscription — transparently,
via `GET /v2/topology`).

## Run

**In the Nano IDE** — open this project and press **▶ Run** in the toolbar. The
Node lang-pack toolchain provisions the runtime and installs the SDK.

**From a terminal** (outside the IDE):

```bash
npm start
```

`npm start` installs the SDK from `package.json`, then runs
`node --experimental-strip-types main.ts` (needs Node >= 22.6).

## What it does

1. Deploys `resources/processes/throughput.bpmn` (process `throughput-demo`, a
   single service task with job type `demo-job`).
2. Starts a `JobWorker` that completes each `demo-job`.
3. Floods non-awaited creates from `PROD_CONNS` concurrent producers.
4. Streams one line per second with creates/s and completes/s, then prints a
   summary after `DURATION_SECS`.

## Env

| var | default | meaning |
|---|---|---|
| `CAMUNDA_REST_ADDRESS` | `http://localhost:8080` | gateway REST address |
| `CAMUNDA_AUTH_STRATEGY` | `NONE` | `NONE` / `BASIC` / `OAUTH` |
| `PID` | `throughput-demo` | BPMN process id to create |
| `JOB_TYPE` | `demo-job` | job type to drain |
| `PROD_CONNS` | `64` | concurrent producer tasks |
| `WORKER_CONCURRENCY` | `100` | max jobs activated at once |
| `DURATION_SECS` | `15` | measurement window |
