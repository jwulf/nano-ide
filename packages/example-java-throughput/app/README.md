# Java throughput demo

A complete, runnable example app for the Nano RAD IDE. Deploys a one-task process,
then runs a producer + `JobWorker` pair to measure create/complete throughput.
Requires JDK 17+ and Apache Maven (`mvn`); install the `java` lang pack.

**The point:** one Java code path, three transports. Change the Maven profile,
change the gateway, keep the code identical.

| # | Broker    | Transport | Command                                                  |
|---|-----------|-----------|----------------------------------------------------------|
| 1 | Camunda 8 | REST      | `mvn -Pstock -q exec:java`                               |
| 2 | Camunda 8 | gRPC      | `mvn -Pstock -q exec:java -Dexec.args=grpc`              |
| 3 | Nano      | Falcon    | `mvn -Pfalcon -q exec:java`                              |

(Nano also implements the same REST API as Camunda 8, so `-Pstock` with
the REST transport works against a Nano gateway too — just point your
project's Deploy Target at it. No separate Maven profile needed.)

## Setup

- **For (1) and (2):** run [`c8run`](https://docs.camunda.io/docs/self-managed/setup/deploy/local/c8run/)
  on `localhost` (REST on `:8080`, gRPC on `:26500`). No auth.
- **For (3):** run a Nano gateway on `localhost:8080` (Falcon WS at
  `ws://localhost:8080/falcon`, same port).

Both share the exact same `CAMUNDA_REST_ADDRESS`/`CAMUNDA_GRPC_ADDRESS` env vars.

## What the profile switch does

The **only difference** between `-Pstock` and `-Pfalcon` is the dependency
Maven pulls in:

- `-Pstock`  → `io.camunda:camunda-client-java`
- `-Pfalcon` → `io.github.jwulf:camunda-client-java-falcon` (drop-in shim)

Both expose the identical `io.camunda.client.CamundaClient` API. The Falcon
build calls `GET /v2/topology` on start and, if it sees a Nano gateway,
transparently upgrades `createProcessInstance` and the `JobWorker` to the
Falcon WebSocket. If the WebSocket handshake fails (corporate proxy blocking
WS, TLS mismatch, etc.) it logs a warning and falls back to REST. To force
REST regardless, set `CAMUNDA_FORCE_REST=true` (or pass `rest` as the arg).

## Tunables (env)

| Var                     | Default                    | Meaning                                      |
|-------------------------|----------------------------|----------------------------------------------|
| `CAMUNDA_REST_ADDRESS`  | `http://localhost:8080`    | REST gateway                                 |
| `CAMUNDA_GRPC_ADDRESS`  | `http://localhost:26500`   | gRPC gateway (C8 only)                       |
| `PROD_CONNS`            | `256`                      | Concurrent producer threads                  |
| `PIPELINE_DEPTH`        | `32`                       | In-flight createInstance calls per producer  |
| `WORKER_CONCURRENCY`    | `100`                      | `maxJobsActive` for the JobWorker            |
| `DURATION_SECS`         | `15`                       | Run length                                   |
| `PID`                   | `throughput-demo`          | BPMN process id                              |
| `JOB_TYPE`              | `demo-job`                 | Job type on the service task                 |
| `CAMUNDA_FORCE_REST`    | *(unset)*                  | Falcon build only — force REST transport     |

## Reading the output

Per-second progress line:

```
t= 5s  created 42317 (+8631/s)  completed 41102 (+8547/s)  errors 0
```

Final summary line reports totals and per-second averages over the whole run.

Compare the same run across the three rows in the table above — that's the
apples-to-apples comparison of C8 REST/gRPC vs Nano Falcon on the same
Java code, driven as hard as your machine will go.

### Why `PIPELINE_DEPTH` matters

The default `PIPELINE_DEPTH=32` lets each producer thread keep 32
`createInstance` requests in flight concurrently. With depth `1` (the naïve
`.send().join()` pattern) every producer thread stalls for a full network
round-trip per create, so the aggregate rate is capped at roughly
`PROD_CONNS / RTT` — the *client* runs out of steam long before either server
does, and Nano and Camunda 8 end up looking indistinguishable. Raise
`PIPELINE_DEPTH` to push past that ceiling; the differences between servers
only show up once the client is actually saturating the commit path.

## Switching what the IDE Run button does

The pack ships **three named run configurations** — pick one in the IDE's
Run dropdown (next to the Run button); the selection is persisted in the
project's `nanobpm.project.json` as `toolchain.activeRunConfig`.

| id            | Label            | What it runs                                                    |
|---------------|------------------|-----------------------------------------------------------------|
| `stock-rest`  | Camunda 8 · REST | `mvn -Pstock exec:java -Dexec.args=rest`  *(default)*           |
| `stock-grpc`  | Camunda 8 · gRPC | `mvn -Pstock exec:java -Dexec.args=grpc`                        |
| `falcon-nano` | Nano · Falcon    | `mvn -Pfalcon exec:java -Dexec.args=falcon`                     |

(The stock C8 REST client speaks the same REST API Nano implements, so
pointing `stock-rest` at a Nano gateway via the project's Deploy Target
also works — no separate Maven profile needed.)

Each config carries its own `compile` argv, so pack/profile-specific jars
are rebuilt correctly when you switch. Edits directly in
`nanobpm.project.json` — either to `run`/`compile` argv or to add new
configs — are respected too. The runtime banner
(`=== runtime: server=… wire=… ===`) confirms which combo you're actually
speaking to.

Requires a nanobpm-gateway release with first-class `runConfigs` support;
older gateways ignore the `runConfigs` block and always run the default
`stock-rest` command.
