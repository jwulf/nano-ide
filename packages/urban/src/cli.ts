// The `urban` CLI — a thin command surface over the Urban runtime + toolkit.
//
//   urban new <name>     scaffold a new app (delegates to create-urban-app)
//   urban check          load + validate the manifest, report issues
//   urban gen            derive generated artifacts (migrations, worker I/O, code-first models)
//   urban derive         derive code-first models only (workflows/*.ts → processes/*.bpmn)
//   urban run            materialize + serve the app (deploy, data, workers, surfaces, triggers)
//   urban dev            like run, plus watch sources and hot-reload on change
//   urban deploy         deploy models only, then exit
//
// Global flags: --root <dir> (default "."), --manifest <file> (default nano.app.json),
//               --port <n>, -h/--help, -v/--version.

import {
  collectManifestIssues,
  installSignalHandlers,
  loadManifest,
  runDev,
  runFromEnv,
  selectHost,
} from "./runtime/index.ts";
import { scaffold, slugify } from "create-urban-app";
import { createNodeGenIO, previewModels, runGen, scaffoldWorkers } from "./toolkit/index.ts";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

// Read the package version from package.json (one hop up from both src/cli.ts and the
// compiled dist/cli.js) so `urban --version` never drifts from the published version.
function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();


interface Flags {
  root: string;
  manifest: string;
  port?: number;
  check: boolean;
  write: boolean;
  deno: boolean;
  models: boolean;
  stdout: boolean;
  style?: "model" | "code";
  help: boolean;
  version: boolean;
  _: string[];
}

function parse(argv: string[]): Flags {
  const f: Flags = { root: ".", manifest: "nano.app.json", check: false, write: false, deno: false, models: true, stdout: false, help: false, version: false, _: [] };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`flag ${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") f.help = true;
    else if (a === "-v" || a === "--version") f.version = true;
    else if (a === "--check") f.check = true;
    else if (a === "--write") f.write = true;
    else if (a === "--deno") f.deno = true;
    else if (a === "--no-models") f.models = false;
    else if (a === "--models") f.models = true;
    else if (a === "--stdout") f.stdout = true;
    else if (a === "--code-first") f.style = "code";
    else if (a === "--style") {
      const v = need(++i, a);
      if (v !== "model" && v !== "code") throw new Error(`flag --style requires "model" or "code" (got "${v}")`);
      f.style = v;
    }
    else if (a === "--") continue; // tolerate a bare "--" some runners inject (not an option terminator here)
    else if (a === "--root") f.root = need(++i, a);
    else if (a === "--manifest") f.manifest = need(++i, a);
    else if (a === "--port") {
      const raw = need(++i, a);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`flag --port requires an integer in 0..65535 (got "${raw}")`);
      }
      f.port = n;
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else f._.push(a);
  }
  return f;
}

const USAGE = `urban — build and run Urban apps (nano.app.json)

Usage:
  urban new <name> [--root <path>] [--deno] [--style model|code]    scaffold a new Urban app
                                    (--code-first is shorthand for --style code)
  urban check                       validate the manifest
  urban gen [--check] [--no-models] derive artifacts (migrations, worker-io, + code-first models)
                                    (--no-models: skip writing derived .bpmn; type-contracts only)
  urban derive [--check|--stdout]   derive code-first models only (workflows/*.ts → processes/*.bpmn)
                                    (--stdout: print {models,incomplete} JSON without writing)
  urban stubs [--write]             scaffold write-once handler stubs from the model
  urban run                         materialize + serve the app
  urban dev                         run + watch sources, hot-reload on change
  urban deploy                      deploy models only, then exit

Global flags:
  --root <dir>        app root (default ".")
  --manifest <file>   manifest filename (default "nano.app.json")
  --port <n>          HTTP port for surfaces/triggers (default $PORT or 8090)
  -h, --help          show this help
  -v, --version       print version

Engine address: $CAMUNDA_REST_ADDRESS (default http://localhost:8080/v2).
`;

async function cmdCheck(f: Flags): Promise<number> {
  // The host is anchored at f.root, so manifest paths are already root-relative —
  // pass the bare manifest filename (prefixing root again would double it).
  const host = selectHost({ cwd: f.root });
  const manifest = await loadManifest(host, f.manifest);
  const issues = collectManifestIssues(manifest);
  if (issues.length === 0) {
    console.log(`✔ ${manifest.name ?? manifest.id} — manifest is valid`);
    return 0;
  }
  console.error(`✖ ${issues.length} issue(s) in ${f.manifest}:`);
  for (const it of issues) console.error(`  • ${it.path}: ${it.message}`);
  return 1;
}

async function cmdGen(f: Flags): Promise<number> {
  const io = createNodeGenIO();
  const res = await runGen({ root: f.root, io, manifestFile: f.manifest, check: f.check, emitModels: f.models });
  if (res.incomplete) {
    console.error(`✖ ${res.modelErrors.length} workflow(s) failed to derive:`);
    for (const e of res.modelErrors) console.error(`  • ${e.path}: ${e.message}`);
    return 1;
  }
  if (f.check) {
    if (res.drift.length === 0) {
      console.log(`✔ generated artifacts are up to date (${res.artifacts.length} checked)`);
      return 0;
    }
    console.error(`✖ ${res.drift.length} generated artifact(s) are out of date — run \`urban gen\`:`);
    for (const p of res.drift) console.error(`  • ${p}`);
    return 1;
  }
  console.log(`✔ generated ${res.artifacts.length} artifact(s):`);
  for (const a of res.artifacts) console.log(`  • ${a.path}`);
  return 0;
}

async function cmdDerive(f: Flags): Promise<number> {
  // `urban derive` IS model derivation, so `--no-models` is contradictory. Reject it explicitly
  // rather than silently ignoring it (flags are global, so it's easy to pass by accident).
  if (!f.models) {
    console.error(
      "✖ `urban derive` derives models — `--no-models` is contradictory. Use `urban gen --no-models` for type-contracts only.",
    );
    return 2;
  }
  const io = createNodeGenIO();

  // Non-writing preview: emit `{ models: [{ id, kind, xml }], incomplete }` to stdout for the
  // console's read-only model viewer (never touches `processes/`).
  if (f.stdout) {
    const d = await previewModels({ root: f.root, io, manifestFile: f.manifest });
    process.stdout.write(
      JSON.stringify({
        models: d.list.map((m) => ({ id: m.id, kind: m.kind, xml: m.xml })),
        incomplete: d.incomplete,
      }) + "\n",
    );
    if (d.incomplete) {
      for (const e of d.errors) console.error(`  • ${e.path}: ${e.message}`);
      return 1;
    }
    return 0;
  }

  // Derive + write models only (skip the type-contract derivers); `generate_models` delegates here.
  const res = await runGen({ root: f.root, io, manifestFile: f.manifest, check: f.check, modelsOnly: true });
  if (res.incomplete) {
    console.error(`✖ ${res.modelErrors.length} workflow(s) failed to derive:`);
    for (const e of res.modelErrors) console.error(`  • ${e.path}: ${e.message}`);
    return 1;
  }
  if (f.check) {
    if (res.drift.length === 0) {
      console.log(`✔ derived models are up to date (${res.artifacts.length} checked)`);
      return 0;
    }
    console.error(`✖ ${res.drift.length} derived model(s) are out of date — run \`urban derive\`:`);
    for (const p of res.drift) console.error(`  • ${p}`);
    return 1;
  }
  console.log(`✔ derived ${res.artifacts.length} model(s):`);
  for (const a of res.artifacts) console.log(`  • ${a.path}`);
  return 0;
}

async function cmdStubs(f: Flags): Promise<number> {
  const io = createNodeGenIO();
  const run = await scaffoldWorkers({ root: f.root, io, manifestFile: f.manifest, write: f.write });

  const created = run.outcomes.filter((o) => o.status === "created");
  const would = run.outcomes.filter((o) => o.status === "would-create");
  const kept = run.outcomes.filter((o) => o.status === "kept");
  const typing = (o: { typedIn: boolean; typedOut: boolean }) =>
    o.typedIn || o.typedOut ? ` (typed${o.typedIn ? " in" : ""}${o.typedOut ? " out" : ""})` : "";

  if (run.write) {
    console.log(`✔ scaffolded ${created.length} worker stub(s):`);
    for (const o of created) console.log(`  + ${o.handlerPath}${typing(o)}`);
    if (run.manifestPatched) {
      console.log(`✔ wired ${run.wired.length} worker(s) into ${f.manifest}`);
    }
  } else {
    if (would.length === 0) {
      console.log(`✔ no new worker stubs to scaffold`);
    } else {
      console.log(`Would scaffold ${would.length} worker stub(s) — run with --write to apply:`);
      for (const o of would) console.log(`  + ${o.handlerPath}${typing(o)}`);
    }
  }
  for (const o of kept) console.log(`  = ${o.handlerPath} (kept — already exists)`);
  if (run.skipped.length > 0) {
    console.log(`  skipped ${run.skipped.length}: ` +
      run.skipped.map((s) => `${s.taskType} (${s.reason})`).join(", "));
  }
  return 0;
}

async function cmdRun(f: Flags, mount?: Record<string, boolean>): Promise<number> {
  const app = await runFromEnv({
    root: f.root,
    manifestPath: f.manifest,
    port: f.port,
    mount,
  });
  const info = app.inspect();
  console.log(`▲ ${info.name} — surfaces on :${info.httpPort ?? "n/a"} (Ctrl-C to stop)`);
  return -1; // keep the process alive; signal handlers stop it
}

async function cmdDev(f: Flags): Promise<number> {
  const dev = await runDev({ root: f.root, manifestPath: f.manifest, port: f.port });
  installSignalHandlers(() => dev.stop());
  return -1; // keep the process alive; signal handlers stop the dev server
}

async function cmdDeploy(f: Flags): Promise<number> {
  const app = await runFromEnv({
    root: f.root,
    manifestPath: f.manifest,
    mount: { deploy: true, data: false, workers: false, surfaces: false, triggers: false, security: false },
    handleSignals: false,
  });
  console.log(`✔ deployed models for ${app.manifest.name ?? app.manifest.id}`);
  await app.stop();
  return 0;
}

async function cmdNew(f: Flags): Promise<number> {
  const name = f._[1];
  if (!name) {
    console.error("usage: urban new <name> [--root <path>] [--deno] [--style model|code] (or --code-first)");
    return 1;
  }
  const dir = f.root !== "." ? f.root : `./${slugify(name)}`;
  const res = await scaffold({ name, dir, deno: f.deno, style: f.style });
  console.log(`✔ scaffolded "${res.id}" in ${res.dir} (${res.files.length} files)`);
  console.log(`  cd ${res.dir}`);
  console.log(`  npm install && npm start`);
  if (f.style === "code") console.log(`  npm run greet -- Adam   # start a code-first instance`);
  if (f.deno) console.log(`  # or on Deno: deno task start`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let f: Flags;
  try {
    f = parse(argv);
  } catch (err) {
    console.error(String((err as Error).message));
    return 1;
  }
  if (f.version) {
    console.log(VERSION);
    return 0;
  }
  const cmd = f._[0];
  if (f.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : f.help ? 0 : 1;
  }
  switch (cmd) {
    case "new":
    case "scaffold":
      return cmdNew(f);
    case "check":
      return cmdCheck(f);
    case "gen":
      return cmdGen(f);
    case "derive":
      return cmdDerive(f);
    case "stubs":
      return cmdStubs(f);
    case "run":
      return cmdRun(f);
    case "dev":
      return cmdDev(f);
    case "deploy":
      return cmdDeploy(f);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

const g = globalThis as {
  process?: { argv: string[]; exit(code: number): void };
  Deno?: { args?: string[]; exit?: (code: number) => void };
};
const meta = import.meta as unknown as { main?: boolean; url: string };
const argv1 = g.process?.argv?.[1];
const nodeMain = argv1 ? meta.url === pathToFileURL(argv1).href : false;
if (meta.main === true || nodeMain) {
  // Node passes args via process.argv (slice off exec+script); Deno (run directly)
  // exposes them on Deno.args. Prefer whichever actually carries args.
  const fromNode = g.process?.argv?.slice(2);
  const fromDeno = g.Deno?.args;
  const argv = (fromNode && fromNode.length ? fromNode : fromDeno) ?? fromNode ?? [];
  const exit = (code: number) => {
    if (g.process?.exit) g.process.exit(code);
    else if (g.Deno?.exit) g.Deno.exit(code);
  };
  main(argv).then(
    (code) => {
      if (code >= 0) exit(code);
    },
    (err) => {
      console.error(String((err as Error)?.message ?? err));
      exit(1);
    },
  );
}
