# Embedded Nano — KYC microservice (GraalVM native binary)

Same demo as `@nanobpm/nano-ide-app-embedded-jvm` — orchestration-of-
orchestration with an outer BPMN on the Nano IDE gateway and an inner
BPMN on a Bernd engine embedded in this microservice — but packaged as
a **single ~30 MB standalone binary** via GraalVM Native Image. No JVM
required at deploy time; ship a scratch container.

See the sibling JVM template's README for the full architectural walk-
through. This README covers only the native-image differences.

## Prerequisites

- **GraalVM for JDK 21+** with `native-image` on `PATH`
  ```sh
  sdk install java 21.0.4-graal
  ```
- Maven 3.9+

## Build

```sh
cd microservice
mvn -q -Pnative -DskipTests package
```

Produces `microservice/target/kyc-microservice` (~30 MB). Copy anywhere
and run.

## Run

```sh
./microservice/target/kyc-microservice
# defaults to ws://localhost:8080/falcon; override:
FALCON_URL=ws://gateway.example.com/falcon ./microservice/target/kyc-microservice
```

## What's inside the binary

- `com.example.KycMicroservice` (main class)
- The `kyc.bpmn` XML (packaged as a resource; kept by
  `-H:IncludeResources=kyc/.*\.bpmn`)
- The Nano engine's wasm blob shipped inside `nano-bernd` (kept by
  `-H:IncludeResources=nano-bernd/.*`)
- Chicory (pure-Java wasm interpreter — AOT-compiles cleanly)
- Jackson + java.net.http WebSocket for the outer Falcon transport

## Reflection config

`microservice/src/main/resources/META-INF/native-image/reflect-config.json`
flags the `EmbeddedEngine`, `ActivatedJob`, and `WasmManifest` types
because `EmbeddedNanoTransport` (in `camunda-client-java-falcon`) uses
reflection to talk to them — Graal's closed-world compilation needs this
so the methods aren't stripped.

## Notes

- `native-image` uses ~4 GB RAM during compilation (`-J-Xmx4g` in the pom).
- The resulting binary is dynamically-linked against libc; for fully-
  static musl binaries add `--static --libc=musl` to `<buildArgs>` and
  build on a Linux host with `musl-cross-compile`.
- Cold start is single-digit milliseconds, so this variant is a good fit
  for scale-to-zero / short-lived scheduled jobs where JVM warm-up would
  dominate wall-clock time.
