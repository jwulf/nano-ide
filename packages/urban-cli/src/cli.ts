// The `urban` CLI — a thin command surface over @nanobpm/urban-runtime.
//
//   urban new <name>     scaffold a new app (delegates to create-urban-app)
//   urban check          load + validate the manifest, report issues
//   urban run            materialize + serve the app (deploy, data, workers, surfaces, triggers)
//   urban dev            like run (hot-reload is not yet implemented; documented below)
//   urban deploy         deploy models only, then exit
//
// Global flags: --root <dir> (default "."), --manifest <file> (default nano.app.json),
//               --port <n>, -h/--help, -v/--version.

import {
  collectManifestIssues,
  loadManifest,
  runFromEnv,
  selectHost,
} from "@nanobpm/urban-runtime";
import { scaffold, slugify } from "create-urban-app";
import { createNodeGenIO, runGen } from "@nanobpm/urban-toolkit";

const VERSION = "0.1.0";

interface Flags {
  root: string;
  manifest: string;
  port?: number;
  check: boolean;
  help: boolean;
  version: boolean;
  _: string[];
}

function parse(argv: string[]): Flags {
  const f: Flags = { root: ".", manifest: "nano.app.json", check: false, help: false, version: false, _: [] };
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
    else if (a === "--root") f.root = need(++i, a);
    else if (a === "--manifest") f.manifest = need(++i, a);
    else if (a === "--port") {
      const n = Number(need(++i, a));
      if (!Number.isFinite(n)) throw new Error(`flag --port requires a number`);
      f.port = n;
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else f._.push(a);
  }
  return f;
}

const USAGE = `urban — build and run Urban apps (nano.app.json)

Usage:
  urban new <name> [--root <path>]    scaffold a new Urban app
  urban check                       validate the manifest
  urban gen [--check]               derive artifacts (migrations, worker-io, models)
  urban run                         materialize + serve the app
  urban dev                         run (hot-reload not yet implemented)
  urban deploy                      deploy models only, then exit

Global flags:
  --root <dir>        app root (default ".")
  --manifest <file>   manifest filename (default "nano.app.json")
  --port <n>          HTTP port for surfaces/triggers (default $PORT or 8090)
  -h, --help          show this help
  -v, --version       print version

Engine address: $CAMUNDA_REST_ADDRESS (default http://localhost:8080/v2).
`;

function manifestPath(f: Flags): string {
  return `${f.root.replace(/\/+$/, "")}/${f.manifest}`;
}

async function cmdCheck(f: Flags): Promise<number> {
  const host = selectHost({ cwd: f.root });
  const manifest = await loadManifest(host, manifestPath(f));
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
  const res = await runGen({ root: f.root, io, manifestFile: f.manifest, check: f.check });
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
    console.error("usage: urban new <name> [--root <path>]");
    return 1;
  }
  const dir = f.root !== "." ? f.root : `./${slugify(name)}`;
  const res = await scaffold({ name, dir });
  console.log(`✔ scaffolded "${res.id}" in ${res.dir} (${res.files.length} files)`);
  console.log(`  cd ${res.dir} && (npm install && npm start) || deno task start`);
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
    case "run":
      return cmdRun(f);
    case "dev":
      console.log("urban dev: hot-reload is not yet implemented; running once.");
      return cmdRun(f);
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
  Deno?: unknown;
};
const meta = import.meta as unknown as { main?: boolean; url: string };
const argv1 = g.process?.argv?.[1];
const nodeMain = argv1 ? meta.url === new URL(`file://${argv1}`).href : false;
if (meta.main === true || nodeMain) {
  const argv = g.process?.argv?.slice(2) ?? [];
  main(argv).then(
    (code) => {
      if (code >= 0) g.process?.exit(code);
    },
    (err) => {
      console.error(String((err as Error)?.message ?? err));
      g.process?.exit(1);
    },
  );
}
