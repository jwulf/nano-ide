# @nanobpm/nano-ide-example-rust-throughput

A distributable **native Rust throughput demo** for the [Nano RAD IDE](https://github.com/Magikcraft/nano-bpm).

A native, **pipelined command-stream** producer that drives a clean engine to
show where the **command stream beats REST**. This is the highest-throughput
example in the set: it talks the Nano command-stream / Falcon transport directly.

## What it shows

- The throughput headroom of a **pipelined producer** on the command stream
  versus request/response REST.
- A native Rust worker against a Nano gateway.

## What it contributes

- **Example template (`rust-throughput`):** the full runnable Cargo app under
  `app/`, installed as a project from the console.

## Requirements

- The **`rust`** lang pack (declared in `requires`) and a **Rust / Cargo**
  toolchain on the host.

## Install

Install it from the console's **Extensions** marketplace, or add it to a
project's pack set. The console reads `nano-ide.ext.json` and offers the demo as
a distributable example app.

## Licence

Apache-2.0.
