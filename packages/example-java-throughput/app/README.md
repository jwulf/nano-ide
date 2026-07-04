# Java throughput demo

A complete, runnable example app for the Nano RAD IDE. Deploys a one-task process,
then runs a producer + `JobWorker` pair to measure create/complete throughput.
Requires JDK 17+ and Apache Maven (`mvn`); install the `java` lang pack.

**The point:** one Java code path, four transports. Change the Maven profile,
change the gateway, keep the code identical.

| # | Broker    | Transport | Command                                                  |
|---|-----------|-----------|----------------------------------------------------------|
| 1 | Camunda 8 | REST      | `mvn -Pstock -q exec:java`                               |
| 2 | Camunda 8 | gRPC      | `mvn -Pstock -q exec:java -Dexec.args=grpc`              |
| 3 | Nano      | REST      | `mvn -Pfalcon -q exec:java -Dexec.args=rest`             |
| 4 | Nano      | Falcon    | `mvn -Pfalcon -q exec:java`                              |

## Setup

- **For (1) and (2):** run [`c8run`](https://docs.camunda.io/docs/self-managed/setup/deploy/local/c8run/)
  on `localhost` (REST on `:8080`, gRPC on `:26500`). No auth.
- **For (3) and (4):** run a Nano gateway on `localhost:8080` (Falcon WS at
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

Compare the same run across the four rows in the table above — that's the
apples-to-apples comparison of C8 REST/gRPC vs Nano REST/Falcon on the same
Java code, driven as hard as your machine will go.
