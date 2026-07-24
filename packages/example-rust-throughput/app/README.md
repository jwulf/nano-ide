# Rust throughput demo

A complete, runnable example app for the Nano RAD IDE. Deploys a one-task process,
then runs a native pipelined producer + drainer to measure create/complete throughput.
Requires the Rust toolchain (`cargo`); install the `rust` lang pack.

**In the Nano IDE** — open this project and press **▶ Run** in the toolbar.

**From a terminal** (outside the IDE):

```
cargo run --release
```

Tunables (env): `NANOBPMN_BASE_URL`, `PROD_CONNS`, `WORKER_CONNS`, `DURATION_SECS`.

A native producer pipelines creates across pooled connections rather than awaiting
per-instance — the mode where the command stream out-throughputs REST.
