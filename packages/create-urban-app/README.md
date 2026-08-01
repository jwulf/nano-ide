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
  deno.json              # Deno tasks and import map
  .gitignore
  README.md
```

## Run it

```bash
cd my-app

# Node
npm install
npm start                # or: npx urban run

# Deno
deno task start
```

Both `npm start` and `deno task start` run the app: they generate its
`nano-generated/` artifacts and start it against a nano-bpm engine (set
`CAMUNDA_REST_ADDRESS`, default `http://localhost:8080/v2`). The scaffolded
`package.json` and `deno.json` also expose `check`, `dev` and `deploy` tasks.

## Options

| Flag | Purpose | Default |
|---|---|---|
| `--dir <path>` | target directory | `./<name>` (slugified) |
| `--id <slug>` | app id in the manifest | derived from the name |
| `--preset <full\|headless>` | `full` includes surfaces, triggers and forms; `headless` is workers-only | `full` |

## Related packages

- [`@nanobpm/urban`](../urban-cli) — the CLI (`urban new`, `run`, `gen`, `check`, `deploy`).
- [`@nanobpm/urban-runtime`](../urban-runtime) — runs the scaffolded app.
- [`@nanobpm/urban-toolkit`](../urban-toolkit) — generates the app's artifacts.
