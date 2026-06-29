# Nano GUI app — gui-starter

A self-contained GUI process application: a Deno binary that serves a web UI and
drives a Nano cluster. Run = `deno task start`; Compile = `deno compile --include public main.ts`.

- `main.ts` — Deno.serve webserver; `/api/start` proxies to the cluster, `/` serves `public/`.
- `public/index.html` — frontend.
- Set `NANOBPMN_BASE_URL` and `PORT` to configure.

Future: an "Embedded Nano" target bundles the engine into the binary (see ADR 0009).
