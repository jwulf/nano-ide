# `@nanobpm/urban`

The `urban` command-line tool: scaffold, validate, generate and run an Urban app
from your terminal — on **Node or Deno**.

## Install

```bash
npm i -g @nanobpm/urban      # install the `urban` command
# or run without installing:
npx @nanobpm/urban new my-app
```

Requires Node ≥ 22.6 or Deno. On Node < 23.6 the `urban` command re-executes with
`--experimental-strip-types` so its TypeScript source runs directly.

Under Deno you can run it without installing:

```bash
deno run -A npm:@nanobpm/urban run
```

## Commands

| Command | What it does |
|---|---|
| `urban new <name>` | scaffold a new app in a new directory |
| `urban check` | validate the app's `nano.app.json` manifest |
| `urban gen` | generate the `nano-generated/` artifacts (migrations, worker I/O, models) |
| `urban gen --check` | fail if the generated artifacts are out of date (a CI drift gate) |
| `urban run` | generate, then run the app — starts its workers and serves its surfaces |
| `urban dev` | run the app (hot-reload is not yet implemented) |
| `urban deploy` | deploy the app's models to the engine, then exit |

## Options

| Flag | Purpose | Default |
|---|---|---|
| `--root <dir>` | app directory | `.` |
| `--manifest <file>` | manifest filename | `nano.app.json` |
| `--port <n>` | HTTP port for surfaces and triggers (integer 0–65535) | `$PORT` or `8090` |
| `-h`, `--help` | show help | |
| `-v`, `--version` | print the version | |

The engine address comes from `$CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`). Set `$CAMUNDA_TRANSPORT` to a non-`rest` value to use
the `@nanobpm/nano-sdk` transport when it is installed.

## A typical session

```bash
urban new invoices && cd invoices
urban gen        # generate nano-generated/
urban check      # validate the manifest
urban run        # start workers and serve surfaces
```

## Related packages

- [`create-urban-app`](../create-urban-app) — the scaffolder behind `urban new`.
- [`@nanobpm/urban-toolkit`](../urban-toolkit) — the generation behind `urban gen`.
- [`@nanobpm/urban-runtime`](../urban-runtime) — the runtime behind `urban run`.
