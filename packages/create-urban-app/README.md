# `create-urban-app`

Scaffold a new, runnable Urban app in one command.

## Create an app

```bash
npm create urban-app my-app
# or, if you have the CLI installed:
urban new my-app
```

This creates a `my-app/` directory:

```
my-app/
  nano.app.json          # the manifest: the app's contract
  processes/greet.bpmn   # a process (with layout; opens in the modeller)
  forms/greeting.form    # a form
  db/migrations/001_init.sql
  workers/greet.ts       # a job worker
  main.ts                # entrypoint that runs the app
  package.json           # npm run scripts
  .gitignore
  README.md
```

Pass `--deno` to additionally emit a `deno.json` (Deno tasks + import map) and the
Deno usage docs. The scaffold defaults to Node to keep the authoring experience
simple; the Urban runtime itself is host-agnostic, so `--deno` is purely additive.

## Run it

```bash
cd my-app
npm install
npm start                # or: npx urban run
```

`npm start` generates the app's `nano-generated/` artifacts and starts it against a
nano-bpm engine (set `CAMUNDA_REST_ADDRESS`, default `http://localhost:8080/v2`).
The scaffolded `package.json` also exposes `check`, `dev` and `deploy` scripts. With
`--deno`, the equivalent `deno task <name>` commands are available too.

## Options

| Flag | Purpose | Default |
|---|---|---|
| `--dir <path>` | target directory | `./<name>` (slugified) |
| `--id <slug>` | app id in the manifest | derived from the name |
| `--preset <full\|headless>` | `full` includes surfaces, triggers and forms; `headless` is workers-only | `full` |
| `--deno` | also emit `deno.json` + Deno docs | Node only |

## Related packages

- [`@nanobpm/urban`](../urban) — the runtime, derivation toolkit, and CLI (`urban new`, `run`, `gen`, `check`, `deploy`) in one package.
- [`@nanobpm/workflow`](../workflow) — the code-first process surface (`defineFlow`).
