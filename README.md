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
| `@nanobpm/nano-ide-theme-nord` | theme | Nord Dark + Nord Light console themes |
| `@nanobpm/nano-ide-theme-solarized` | theme | Solarized Dark + Light console themes |
| `@nanobpm/nano-ide-theme-synthwave` | theme | Synthwave '84 neon console theme |

## Pack kinds
- **lang** — file types (Monaco lazy-loads the grammar), toolchain (detect/run/compile/targets), templates.
- **app** — project template producing a runnable/compilable binary (e.g. Deno GUI).
- **example** — a complete app shipped under `appDir`, copied into a new project; `requires[]` lists needed lang packs.
- **theme** — console colour themes as pure data: `themes[]` maps the console's design tokens (`app`, `panel`, `accent`, …) to CSS colours over a light or dark base. No code, no toolchain, no trust prompt.

## Dev
```
npm ci
npm run validate     # check every nano-ide.ext.json
npm run typecheck
npm run build
```
Publish via `node scripts/publish.mjs` (CI on main). Version each pack independently; the
script publishes only versions not yet on npm.

## Authoring a pack

An extension pack is a plain **npm package** with two contract files:

1. **`nano-ide.ext.json`** at the package root — the manifest the console reads
   (see [`packages/ext-types`](packages/ext-types) for the typed schema, or the
   authoritative source in [`nano-bpm/server/src/console/extensions.rs`](https://github.com/jwulf/nano-bpm/blob/main/server/src/console/extensions.rs)).
2. **`package.json`** with:
   - `keywords` including `"nano-ide-ext"` (marketplace discovery).
   - `files` shipping at least `nano-ide.ext.json` plus your `templates/` or `app/` dir.
   - `publishConfig.access: "public"`.

The console discovers packs by the `nano-ide-ext` npm keyword, installs the
tarball into the workspace, reads the manifest, and wires the pack in — no
`preinstall`/`postinstall` scripts run.

### `nano-ide.ext.json` at a glance

```jsonc
{
  "id": "my-pack",                  // stable pack id, must be unique
  "kind": "lang" | "app" | "example",
  "displayName": "Human name",

  // lang packs
  "fileTypes": [{ "ext": ".rs", "monacoLang": "rust" }],
  "toolchain": {
    "detect":  ["cargo", "--version"],
    "run":     ["cargo", "run", "--release"],
    "compile": ["cargo", "build", "--release"],
    "targets": [],                  // cross-compile triples, optional
    "installUrl":  "https://…",     // shown when detect fails
    "installHint": "brew install rust"
  },

  // lang / app packs — templates surfaced in the New Project picker
  "templates": [
    { "id": "my-starter", "label": "Human label shown in the picker" }
  ],

  // example packs
  "appDir":   "app",                // dir copied into the new project
  "requires": ["rust"],             // lang pack ids the example needs
  "summary":  "One-line description"
}
```

### Kinds

Pick the one you're publishing.

#### `lang` — a language

Wires a file extension into Monaco, plus a **toolchain** the supervisor drives
(`detect` probe, `run`, `compile`, cross-compile `targets`, `installUrl`/`installHint`
for when the toolchain is missing). May also contribute starter templates under
`templates/<id>/`.

Layout:

```
packages/lang-mylang/
├── package.json            # name: @you/nano-ide-lang-mylang
├── nano-ide.ext.json       # kind: "lang"
└── templates/
    └── my-starter/         # copied into new projects picking this template id
        ├── ...
```

Example: [`packages/lang-rust`](packages/lang-rust) — Rust file type +
`cargo` toolchain + a Rust starter.

#### `app` — an output/runtime template

Ships one or more project templates that scaffold a runnable/compilable
application (e.g. a Deno GUI app, a Java Maven module). Same `templates[]`
+ `templates/<id>/` shape as lang packs; no `fileTypes`/`toolchain` required
if the lang side is already covered by an existing pack.

Example: [`packages/app-deno-gui`](packages/app-deno-gui).

#### `example` — a ready-to-run reference app

**The whole pack is the template.** No `templates[]` needed. Ship your project
under `appDir` (conventionally `app/`), list `requires[]` of lang packs the
example needs to build, and write a `summary`. The console auto-registers
example packs in the New Project picker (label = `"<displayName> — <summary>"`),
so you never have to patch someone else's lang pack to make your example
discoverable.

Layout:

```
packages/example-my-demo/
├── package.json            # name: @you/nano-ide-example-my-demo
├── nano-ide.ext.json       # kind: "example", appDir: "app"
└── app/                    # copied verbatim into the new project
    ├── README.md
    └── ...
```

Example: [`packages/example-rust-throughput`](packages/example-rust-throughput).

### Publishing

- Any npm namespace works; the console filters marketplace results by the
  `nano-ide-ext` keyword, not by scope.
- Bump `version` per pack. `node scripts/publish.mjs` skips versions already
  on npm.
- Users install through **Console → Extensions → search npm**, or by pack name
  from the CLI. The trust store (ADR 0007) prompts before running any
  toolchain command a pack contributes.
