# Throughput demo — same code, four transports

One Java file, one BPMN, one Maven project. Two knobs:

- **Server switch** — set `CAMUNDA_REST_ADDRESS` / `CAMUNDA_GRPC_ADDRESS`.
  No source change, no dependency change. Same jar runs against Camunda 8
  or Nano.
- **Transport switch** — activate the `-Pfalcon` Maven profile. Same
  source, different jar on the classpath. The Falcon fork adds Nano
  Falcon protocol via auto-detection; against Camunda 8 it behaves
  identically to the upstream jar.

`ThroughputDemo.java` uses only `io.camunda.client.*`. It prints the
resolved jar in the report banner, so results are self-documenting.

## The four permutations

| Server | SDK jar (Maven profile)                                      | Transport used                       |
|--------|--------------------------------------------------------------|--------------------------------------|
| C8     | default (`io.camunda:camunda-client-java`)                   | REST or gRPC (`CAMUNDA_PREFER_REST_OVER_GRPC`) |
| Nano   | default (`io.camunda:camunda-client-java`)                   | REST (no Falcon)                     |
| Nano   | `-Pfalcon` (`io.github.jwulf:camunda-client-java-falcon`)    | **Falcon** (WebSocket, auto-detected) |
| Nano   | `-Pfalcon` + `CAMUNDA_FORCE_REST=1`                          | REST                                 |

## Running

Prerequisites: Java 21+, Maven 3.9+, a running Camunda 8 or Nano cluster
reachable at the address you configure.

```bash
# --- 1. Same jar, change server (no code change) ---

# Against Camunda 8, REST:
CAMUNDA_REST_ADDRESS=http://localhost:8080 \
CAMUNDA_PREFER_REST_OVER_GRPC=true \
  mvn -q -f app/pom.xml exec:java

# Against Camunda 8, gRPC:
CAMUNDA_GRPC_ADDRESS=http://localhost:26500 \
CAMUNDA_PREFER_REST_OVER_GRPC=false \
  mvn -q -f app/pom.xml exec:java

# Against Nano, REST (same jar, just different address):
CAMUNDA_REST_ADDRESS=http://localhost:8080 \
CAMUNDA_PREFER_REST_OVER_GRPC=true \
  mvn -q -f app/pom.xml exec:java

# --- 2. Same code, change transport (dependency change only) ---

# Against Nano, Falcon (drop-in fork of the upstream jar):
CAMUNDA_REST_ADDRESS=http://localhost:8080 \
  mvn -q -Pfalcon -f app/pom.xml exec:java
```

The banner printed at start shows exactly which jar loaded and which env
vars are in effect.

## Tuning

| Env var                | Default | Meaning                                                    |
|------------------------|---------|------------------------------------------------------------|
| `WORKLOAD_DURATION_S`  | 30      | Length of the measured window.                             |
| `WARMUP_S`             | 5       | Warm-up before measurement (JIT, engine caches).           |
| `WORKLOAD_CONCURRENCY` | 32      | Parallel producer threads (each issues create-with-result).|
| `WORKER_CONCURRENCY`   | 8       | Job worker threads / max jobs active tuning.               |

Anything else the C8 SDK reads (auth, TLS, tenant, keep-alive, timeouts,
etc.) works too — the client is built with
`applyEnvironmentVariableOverrides(true)`.

## What it measures

Each producer thread runs `createProcessInstance(...).withResult()` in a
tight loop for the measured window. The `withResult()` future completes
when the process instance ends, so the recorded latency is the full
client → gateway → engine → worker → engine → client round trip. The
worker is a no-op (immediate complete) so throughput reflects the
transport + engine, not user code.

The report prints:

- **PIs/s** — completed instances divided by wall-clock window.
- **p50 / p95 / p99 / p99.9 / max** completion latency in ms, via
  HdrHistogram (fixed memory, no reservoir bias).
- The **client artifact** actually loaded, so results are attributable.

## What it does NOT do

- No K8s manifests or GH Actions harness — this is a `mvn exec:java` demo.
- No auth wiring beyond what the env vars provide. Use standard C8 env
  vars for tokens.
- No historical result storage. Print the console, paste the numbers
  wherever you want.
- No JMH; we deliberately drive a real client for a real end-to-end
  round-trip, not a micro-benchmark.
