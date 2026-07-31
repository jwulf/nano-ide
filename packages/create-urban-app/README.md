# `create-urban-app`

> Scaffold a runnable Urban app in one command — the Create-React-App of Urban.
> Materializes a manifest, a process, a form, a datasource migration and a
> worker, wired to `@nanobpm/urban-runtime`. Runs on **Node and Deno**.
> (ADR 0052.)

## Use

```bash
npm create urban-app my-app
# or via the CLI:
urban new my-app
```

This writes a directory containing:

```
my-app/
  nano.app.json          # the manifest — the app's contract
  processes/greet.bpmn   # a process (with DI, opens in the modeller)
  forms/greeting.form    # a form
  db/migrations/001_init.sql
  workers/greet.ts       # a job worker
  main.ts                # entrypoint → runFromEnv()
  package.json           # Node run scripts
  deno.json              # Deno tasks + import map
  .gitignore             # ignores nano-generated/
  README.md
```

Then:

```bash
cd my-app
urban gen && urban run    # Node
# or
deno task run             # Deno
```

## What it is not

The scaffolder only writes files (token substitution `__APP_ID__` / `__APP_NAME__`,
`_gitignore` → `.gitignore`). Derivation is `@nanobpm/urban-toolkit`; execution
is `@nanobpm/urban-runtime`. Keeping these separate is the whole point of ADR
0052/0053: an app is a decoupled directory, not a console feature.
