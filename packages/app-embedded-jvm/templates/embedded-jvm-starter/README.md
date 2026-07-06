# Embedded Nano JVM — KYC microservice starter

A working demonstration of **orchestration-of-orchestration** on Nano:

```
Outer BPMN engine                         This microservice (JVM)
┌──────────────────────┐                 ┌──────────────────────────┐
│ models/              │  Camunda REST   │ microservice/            │
│ └─ onboarding.bpmn   │◄── job worker ─►│  Bernd (embedded engine) │
│    (deployed to      │  verify_kyc     │   └─ kyc.bpmn            │
│     the engine)      │                 │                          │
└──────────────────────┘                 └──────────────────────────┘
       outer flow                              inner flow
   (onboarding team)                        (compliance team)
```

The outer engine can be **Camunda 8**, **Camunda Self-Managed**, or a
**Nano gateway** — the microservice only speaks stock Camunda REST on
the outer path. The inner engine is always Bernd (in-process Nano)
because that's the whole point of the demo.

Two engines. Two audit trails. One team owns each file.

## What's in this project

- `models/onboarding.bpmn` — the **outer** customer-onboarding process.
  Deploys automatically when Nano IDE picks up files in `models/`. Has one
  service task `verify_kyc` and an exclusive gateway that branches to
  Approve / Manual review / Reject.
- `microservice/` — a JVM project.
  - `src/main/resources/kyc/kyc.bpmn` — the **inner** KYC flow (check ID,
    screen sanctions, PEP check, risk score). Packaged into the jar.
  - `src/main/java/com/example/OuterKycService.java` — stock Camunda REST
    job worker subscribed to `verify_kyc`. Delegates to InnerKycService,
    completes the outer job with a `decision` variable.
  - `src/main/java/com/example/InnerKycService.java` — in-process Bernd
    engine that runs `kyc.bpmn` for each activation.
  - `src/main/java/com/example/KycMicroservice.java` — wire-up only.

## Run

1. **Start a BPMN engine** — Nano IDE, Camunda 8 SaaS, or Camunda
   Self-Managed. If it isn't reachable at `http://localhost:8080`, set
   `CAMUNDA_REST_ADDRESS` to point at it.
2. **Deploy `models/onboarding.bpmn`** — Nano IDE does this automatically;
   for Camunda 8 use Modeler / Operate or `zbctl deploy`.
3. **Start the microservice**:
   ```sh
   cd microservice
   mvn -q exec:java
   ```
   You'll see: `[inner] Bernd engine up; kyc.bpmn deployed` then
   `[outer] subscribed to verify_kyc`.
4. **Kick off an onboarding instance** — pass a `customerId` variable.
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

The outer instance then routes to `queue_for_ops`.

## How it works

- **Outer path**: stock `io.camunda:camunda-client-java` REST job worker
  (`client.newWorker().jobType("verify_kyc")...`). No Nano-specific
  transport — the same code runs against Camunda 8, Camunda
  Self-Managed, or a Nano gateway.
- **Inner path**: `io.github.jwulf:nano-bernd`'s `EmbeddedEngine` for
  the in-process inner engine (`kycEngine.deploy(kycBpmn)`,
  `activateJobs`, `completeJob`).
- The inner flow ships **inside the microservice jar** — Maven's default
  resource plugin packages `src/main/resources/kyc/kyc.bpmn`, and
  `InnerKycService` reads it via `ClassLoader.getResourceAsStream` on
  boot. Compliance edits `kyc.bpmn`, bumps the jar, ships. Onboarding
  team's outer flow doesn't change.

## ABI v2 notes

- The inner flow is a **linear sequence**. When ABI v3 exposes variables-
  on-complete, branches like "sanctions_hit → straight-to-rejected" move
  into `kyc.bpmn`. Today the microservice aggregates in Java-land.
- The outer engine sees the `decision` variable on job completion — that
  drives the exclusive gateway in `onboarding.bpmn`.

## For a native binary

See the sibling `@nanobpm/nano-ide-app-embedded-graalvm-native` template
for the same code compiled to a ~30 MB standalone binary via GraalVM
Native Image (no JVM required at deploy time).
