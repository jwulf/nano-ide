# Embedded Nano JVM — KYC microservice starter

A working demonstration of **orchestration-of-orchestration** on Nano:

```
Nano IDE gateway                          This microservice (JVM)
┌──────────────────────┐                 ┌──────────────────────────┐
│ models/              │                 │ microservice/            │
│ └─ onboarding.bpmn   │◄── Falcon ─────►│  Bernd (embedded engine) │
│    (auto-deployed)   │  verify_kyc     │   └─ kyc.bpmn            │
└──────────────────────┘                 └──────────────────────────┘
       outer flow                              inner flow
   (onboarding team)                        (compliance team)
```

Two engines. Two audit trails. One team owns each file.

## What's in this project

- `models/onboarding.bpmn` — the **outer** customer-onboarding process.
  Deploys automatically when Nano IDE picks up files in `models/`. Has one
  service task `verify_kyc` and an exclusive gateway that branches to
  Approve / Manual review / Reject.
- `microservice/` — a JVM project.
  - `src/main/resources/kyc/kyc.bpmn` — the **inner** KYC flow (check ID,
    screen sanctions, PEP check, risk score). Packaged into the jar.
  - `src/main/java/com/example/KycMicroservice.java` — subscribes to the
    outer `verify_kyc` job over Falcon, runs `kyc.bpmn` on an in-process
    Bernd engine for each activation, aggregates the check results, and
    completes the outer job with a `decision` variable.

## Run

1. **Start the Nano IDE** — it deploys `models/onboarding.bpmn` on save.
2. **Start the microservice**:
   ```sh
   cd microservice
   mvn -q exec:java
   ```
   You'll see: `[boot] Bernd engine up; kyc.bpmn deployed (v1)` then
   `[ready] subscribed to verify_kyc`.
3. **Kick off an onboarding instance** from the IDE (or `curl` the
   gateway's `/v2/process-instances`), passing a `customerId` variable.
   Try `customer-42` (approved) and `vip-alice` (manual review).

Console output shows each inner step firing in real time:

```
═══════════════════════════════════════════════════════════════
[outer] verify_kyc activated (jobKey=..., customer=vip-alice)
[inner] starting kyc.bpmn instance for vip-alice
[inner] instance 12 running
  [inner:check_id] ID document verified ✓
  [inner:screen_sanctions] OFAC + UN lists clear ✓
  [inner:check_pep] PEP list MATCH ⚠
  [inner:risk_score] score = 75
[inner] kyc.bpmn done — decision: manual_review
[outer] completing verify_kyc with decision=manual_review
═══════════════════════════════════════════════════════════════
```

The outer instance in the IDE then routes to `queue_for_ops`.

## How it works

- The microservice uses **one client jar** — `camunda-client-java-falcon`
  — with **two transports** from the same API:
  - `NanoTransport.falcon(URI)` → outer gateway over WebSocket
  - internal `EmbeddedEngine` calls → in-process wasm engine (Bernd,
    `io.github.jwulf:nano-bernd`)
- The inner flow ships **inside the microservice jar** — Maven's default
  resource plugin packages `src/main/resources/kyc/kyc.bpmn`, and
  `KycMicroservice` reads it via `ClassLoader.getResourceAsStream` on
  boot. Compliance edits `kyc.bpmn`, bumps the jar, ships. Onboarding
  team's outer flow doesn't change.

## Swap remote-vs-embedded (dev doubles)

For local integration tests, replace the Falcon transport with a second
embedded engine that holds `onboarding.bpmn`:

```java
var outerEngine = EmbeddedEngine.create();
outerEngine.deploy(loadResource("/models/onboarding.bpmn"));
var outer = NanoTransport.embedded(outerEngine);
```

Same worker code runs — no gateway process required in tests.

## ABI v2 notes

- The inner flow is a **linear sequence**. When ABI v3 exposes variables-
  on-complete, branches like "sanctions_hit → straight-to-rejected" move
  into `kyc.bpmn`. Today the microservice aggregates in Java-land.
- Only the outer gateway sees the `decision` variable on job completion —
  that's the full REST engine, so gateway conditions work as expected.

## For a native binary

See the sibling `@nanobpm/nano-ide-app-embedded-graalvm-native` template
for the same code compiled to a ~30 MB standalone binary via GraalVM
Native Image (no JVM required at deploy time).
