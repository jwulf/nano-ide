# @nanobpm/nano-ide-example-java-throughput

A distributable **Java + Maven throughput demo** for the [Nano RAD IDE](https://github.com/Magikcraft/nano-bpm).

A producer plus a `JobWorker` that maxes out create / complete throughput. The
**same code** runs against **Camunda 8 (REST or gRPC)** or **Nano (Falcon)** —
you pick the transport by swapping **one Maven dependency** (profile).

## What it shows

- One worker, three transports, selected at run time via **run configurations**:
  - **Camunda 8 · REST** (`-Pstock`, default)
  - **Camunda 8 · gRPC** (`-Pstock`)
  - **Nano · Falcon** (`-Pfalcon`)
- Where the **command-stream / Falcon** transport pulls ahead of REST and gRPC.

## What it contributes

- **Example template (`java-throughput`):** the full runnable Maven app under
  `app/`, installed as a project from the console.
- **Toolchain (Maven):** `mvn package` / `mvn compile exec:java`, with the three
  run configurations above.

## Requirements

- The **`java`** lang pack (declared in `requires`) and **Maven** (`mvn`) on the
  host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo
with its REST / gRPC / Falcon run configurations.

## Licence

Apache-2.0.
