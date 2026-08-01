# __APP_NAME__

An [Urban](https://github.com/jwulf/nano-ide) app. Urban is a local‑first RAD toolkit
that turns a declarative manifest (`nano.app.json`) into a running application on top of the
[Nano](https://nanobpm.io) process engine — Borland Delphi for BPMN.

## What's here

```
nano.app.json         the manifest — the whole app, declared
processes/*.bpmn      BPMN process models
forms/*.form          form-js user task forms
db/migrations/*.sql   datasource schema (SQLite by default)
workers/*.ts          service-task handlers (Node + Deno)
main.ts               entrypoint (calls the Urban runtime)
```

The manifest is the contract; the runtime is the interpreter; the host (Node or Deno) is
interchangeable. You never eject.

## Run it

You need a Nano engine reachable at `CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`).

**Node**

```bash
npm install
npm run check      # validate the manifest
npm start          # deploy models, provision the DB, start workers + surfaces
```

**Deno**

```bash
deno task check
deno task start
```

Then trigger the demo:

```bash
curl -X POST localhost:8090/hooks/greet -H 'content-type: application/json' \
  -d '{"who":"Adam"}'
```

## Extend it

- Add a `.bpmn` under `processes/` and a matching worker under `workers/`.
- Add a domain type to `types` in the manifest and a migration under `db/migrations/`.
- Enable more surfaces (task inbox, chat) or triggers in the manifest.

See the [Urban runtime docs](https://github.com/jwulf/nano-ide/tree/main/packages/urban).
