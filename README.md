# nano-ide

Monorepo publishing **extension packs** for the Nano RAD console IDE (ADR 0007/0008/0009).
Packs are plain npm packages discovered + installed from npm in the console UI. The host
parses each pack's `nano-ide.ext.json` manifest (mirror of `server/src/console/extensions.rs`).

`deno` ships built into the server (offline baseline). Everything else is a pack here.

## Packages
| Package | Kind | What |
| --- | --- | --- |
| `@nanobpm/nano-ide-ext-types` | — | TypeScript types for `nano-ide.ext.json` |
| `@nanobpm/nano-ide-lang-rust` | lang | Rust file types + cargo toolchain + throughput template |
| `@nanobpm/nano-ide-app-deno-gui` | app | Deno served-UI binary template |
| `@nanobpm/nano-ide-example-rust-throughput` | example | Ready-to-run Rust command-stream A/B demo |

## Pack kinds
- **lang** — file types (Monaco lazy-loads the grammar), toolchain (detect/run/compile/targets), templates.
- **app** — project template producing a runnable/compilable binary (e.g. Deno GUI).
- **example** — a complete app shipped under `appDir`, copied into a new project; `requires[]` lists needed lang packs.

## Dev
```
npm ci
npm run validate     # check every nano-ide.ext.json
npm run typecheck
npm run build
```
Publish via `npm publish --workspaces` (CI on main). Version each pack independently; npm skips
already-published versions.
