# Embedded μ-nano starter

A self-contained process app: the Nano BPMN engine runs **in this process** via
WebAssembly (ADR 0005). No gateway, no sockets. `deno compile` ships engine + app
as one binary.

## Run

```sh
deno task start        # N=1000 by default; override with N=5000 deno task start
```

## Compile to a single binary

```sh
deno task compile      # -> ./embedded-app (includes engine wasm + BPMN)
./embedded-app
```

## How it works

- `engine/unano_bg.wasm` is `engine-core` compiled to wasm; `engine/host.ts` wraps it
  as an `EmbeddedHost` (deploy / createInstance / activateJobs / complete / tick).
- `@nanobpm/nano-sdk` with `CAMUNDA_TRANSPORT=embedded` binds the host directly, so the
  same SDK code that talks to a real cluster drives the in-process engine.
- The host injects `Date.now()` via `tickNow`, so the clock-free engine-core runs as a
  real wall-clock runtime.
