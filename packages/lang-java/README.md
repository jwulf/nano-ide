# @nanobpm/nano-ide-lang-java

Java + Maven language pack for the Nano RAD console IDE. Adds `.java` (and `.xml`
for `pom.xml`) editing (Monaco lazy-loads the Java grammar only when a Java file
is open), the `mvn` toolchain (run/compile via the user's installed Apache Maven),
and a starter project template that talks to a Camunda 8 REST gateway — or, when
connected to a Nano server, transparently upgrades to the Falcon Protocol via a
patched Falcon-aware Camunda Java client (see [Falcon roadmap](#falcon-roadmap)).

Manifest: `nano-ide.ext.json`.

## Requirements

* **Apache Maven 3.9+** — `mvn` on PATH. Install: https://maven.apache.org/install.html
* **JDK 17+** — the template compiles against Java 17.

The IDE surfaces a red toolchain warning in the config panel when `mvn --version`
fails, with the install link above.

## Templates

* **`java-starter`** — a minimal Maven project that
  * builds a `CamundaClient` from `CAMUNDA_REST_ADDRESS`,
  * fetches the gateway topology and prints it, then
  * registers a job worker for job type `hello` that completes each job by
    echoing its variables.

  Runs on stock Camunda 8 today. When the Falcon-aware client artifact ships,
  swap the dependency `groupId`/`artifactId` in `pom.xml` — no application code
  change — and job push + create-instance will upgrade to Falcon against Nano.

## Falcon roadmap

The current `pom.xml` depends on stock `io.camunda:camunda-client-java`, which
speaks REST + gRPC. A Falcon-aware fork (planned) will publish a drop-in artifact
that adds `/v2/topology` Nano detection and routes `createProcessInstance` +
job workers over the Falcon WebSocket when detected, falling back to REST when
not. When it lands, the only change in this template will be the two coordinates
in `pom.xml` — the `Main.java` code will not change.
