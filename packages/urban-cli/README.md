# `urban` — the Urban CLI (`@nanobpm/urban`)

> One command to scaffold, derive, check and run an Urban app — outside the
> console, on **Node or Deno**. The peer caller of `@nanobpm/urban-toolkit`
> (derivation) and `@nanobpm/urban-runtime` (execution). (ADR 0052 / 0053.)

## Install

```bash
npm i -g @nanobpm/urban
# or run once:
npx @nanobpm/urban new my-app
```

The `urban` bin re-execs Node with `--experimental-strip-types` when Node < 23.6,
so source `.ts` runs directly. Needs Node ≥ 22.6 or Deno.

## Commands

| Command | Does |
|---|---|
| `urban new <name> [--root <path>]` | scaffold a new app (delegates to `create-urban-app`) |
| `urban check` | validate the `nano.app.json` manifest |
| `urban gen [--check]` | derive `nano-generated/` artifacts; `--check` is a drift gate |
| `urban run` | materialize + run the app (starts workers, connects the engine) |
| `urban dev` | run (hot-reload TBD) |
| `urban deploy` | deploy models only, then exit |

## Global flags

- `--root <dir>` — app root (default `.`)
- `--manifest <file>` — manifest filename (default `nano.app.json`)
- `--port <n>` — HTTP port (default `$PORT` or 8090)
- `-h/--help`, `-v/--version`

Engine address: `$CAMUNDA_REST_ADDRESS` (default `http://localhost:8080/v2`).
Transport: `$CAMUNDA_TRANSPORT` (`rest` default; anything else opts into
`@nanobpm/nano-sdk` Falcon on the hot path).

## Typical loop

```bash
urban new invoices && cd invoices
urban gen            # derive nano-generated/
urban check          # validate
urban run            # serve
```
