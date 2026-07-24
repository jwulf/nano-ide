# C# throughput demo

A parallel producer flood + JobWorker on the official
[`Camunda.Orchestration.Sdk`](https://www.nuget.org/packages/Camunda.Orchestration.Sdk).
One code path runs against **Camunda 8** (plain REST) or **Nano** (the SDK
upgrades `CreateProcessInstanceAsync` to the credit-metered command stream and
the JobWorker to a streaming push subscription — transparently, via
`GET /v2/topology`).

## Run

**In the Nano IDE** — open this project and press **▶ Run** in the toolbar. The
C# lang-pack toolchain restores the SDK and builds automatically, and the target
framework tracks your installed .NET SDK.

**From a terminal** (outside the IDE):

```bash
dotnet run -c Release
```

`dotnet run` restores the SDK from NuGet and builds on first run. The project
targets whichever .NET SDK you have installed (e.g. .NET 10) — derived from the
running SDK — so no specific framework version needs to be preinstalled.

## What it does

1. Deploys `resources/processes/throughput.bpmn` (process `throughput-demo`, a
   single service task with job type `demo-job`).
2. Starts a `JobWorker` that completes each `demo-job`.
3. Floods `AwaitCompletion=false` creates from `PROD_CONNS` concurrent tasks.
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
