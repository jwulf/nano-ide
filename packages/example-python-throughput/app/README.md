# Python throughput demo

An async producer flood + JobWorker on the official
[`camunda-orchestration-sdk`](https://pypi.org/project/camunda-orchestration-sdk/).
One code path runs against **Camunda 8** (plain REST) or **Nano** (the SDK
upgrades `create_process_instance` to the credit-metered command stream and the
JobWorker to a streaming push subscription — transparently, via `GET /v2/topology`).

## Run

```bash
uv run main.py
```

`uv` provisions a Python 3.10+ interpreter and installs the SDK from
`pyproject.toml` on first run.

## What it does

1. Deploys `resources/processes/throughput.bpmn` (process `throughput-demo`, a
   single service task with job type `demo-job`).
2. Starts a `JobWorker` that completes each `demo-job`.
3. Floods `await_completion=False` creates from `PROD_CONNS` concurrent tasks.
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
