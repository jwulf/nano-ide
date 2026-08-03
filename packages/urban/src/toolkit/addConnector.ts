// addConnector — enable an installed connector pack into an app's nano.app.json.
//
// A connector pack ships a `nano-ide.ext.json` manifest declaring one or more
// workers (a `taskType`, a worker `entry`, and its config fields). "Enabling" it
// means the pure, idempotent manifest edit the `urban add` CLI performs after
// `npm install <pkg>` (ADR 0050 §5): for every worker the pack declares, append a
// pack-backed `workers[]` entry (`{ taskType, connector: <pack-id>, connection }`)
// and, when the pack needs credentials, a named `connections[]` entry whose values
// are env-pointer templates (never inline secrets, ADR 0025 §1 / 0027 §5).
//
// This module only reads/writes files through the GenIO port — installing the
// package (a subprocess) is the CLI's job, so this stays runtime-agnostic and
// unit-testable.

import type { GenIO } from "./gen.ts";

/** A config field a pack declares (subset of ext-types `ConfigField`). */
interface PackConfigField {
  key: string;
  label?: string;
  env?: string;
  default?: string;
}

/** A worker a pack declares (subset of ext-types `WorkerSpec`). */
interface PackWorkerSpec {
  type: string;
  entry: string;
  displayName?: string;
  maxParallelJobs?: number;
  configFields?: PackConfigField[];
}

/** The pack manifest (`nano-ide.ext.json`) fields `addConnector` reads. */
interface PackManifest {
  id: string;
  workers?: PackWorkerSpec[];
}

export interface AddConnectorOptions {
  /** App root directory. */
  root: string;
  /** The installed npm package name (already present under node_modules). */
  pkg: string;
  /** Manifest filename under root. Default "nano.app.json". */
  manifestFile?: string;
  io: GenIO;
}

export interface AddConnectorResult {
  /** The pack id (`nano-ide.ext.json` `id`) written to each worker's `connector`. */
  packId: string;
  /** Workers considered, with whether one was already wired (idempotent). */
  wired: { taskType: string; alreadyPresent: boolean }[];
  /** The named connection created/reused, if the pack needs credentials. */
  connection?: string;
  /** Env vars the operator must set for the enabled workers to run. */
  requiredEnv: string[];
}

const MANIFEST_FILE = "nano-ide.ext.json";

function joinPath(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/** A stable, slug-ish connection name for a pack id (kebab, no leading scope). */
function connectionNameFor(packId: string): string {
  const base = packId.includes("/") ? packId.slice(packId.lastIndexOf("/") + 1) : packId;
  return base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || packId;
}

/**
 * Read the installed pack manifest, then wire its workers into the app manifest.
 * Idempotent: re-running never duplicates a `workers[]`/`connections[]` entry.
 * The app manifest object is mutated in place and written back.
 */
export async function addConnector(opts: AddConnectorOptions): Promise<AddConnectorResult> {
  const { root, pkg, io } = opts;
  const manifestFile = opts.manifestFile ?? "nano.app.json";

  const packManifestPath = joinPath(joinPath(joinPath(root, "node_modules"), pkg), MANIFEST_FILE);
  if (!(await io.exists(packManifestPath))) {
    throw new Error(
      `"${pkg}" is not an Urban connector: no ${MANIFEST_FILE} found at ${packManifestPath}. ` +
        `Install the package first (\`npm install ${pkg}\`), and check it is a connector pack.`,
    );
  }
  let pack: PackManifest;
  try {
    pack = JSON.parse(await io.readText(packManifestPath)) as PackManifest;
  } catch (err) {
    throw new Error(`failed to parse ${packManifestPath}: ${(err as Error).message}`);
  }
  if (typeof pack.id !== "string" || !pack.id) {
    throw new Error(`${packManifestPath} has no string "id" (a pack must declare its id).`);
  }
  const specs = Array.isArray(pack.workers) ? pack.workers : [];
  if (specs.length === 0) {
    throw new Error(`connector pack "${pack.id}" declares no workers[] — nothing to enable.`);
  }

  const appManifestPath = joinPath(root, manifestFile);
  if (!(await io.exists(appManifestPath))) {
    throw new Error(`no ${manifestFile} at ${appManifestPath} — run this inside an Urban app.`);
  }
  const app = JSON.parse(await io.readText(appManifestPath)) as {
    workers?: { taskType?: string; connector?: string; connection?: string }[];
    connections?: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
  };
  const workers = (app.workers ??= []);

  // Required env across the pack's workers (env-pointer fields without a default).
  const envFields: PackConfigField[] = [];
  const requiredEnvSet = new Set<string>();
  for (const spec of specs) {
    for (const f of spec.configFields ?? []) {
      if (f.env) {
        envFields.push(f);
        if (f.default === undefined || f.default === "") requiredEnvSet.add(f.env);
      }
    }
  }

  // Create/reuse a named connection when the pack carries credential config, so the
  // required env pointers are documented in the manifest (secrets stay templates).
  let connection: string | undefined;
  if (envFields.length > 0) {
    connection = connectionNameFor(pack.id);
    const connections = (app.connections ??= {});
    if (!connections[connection]) {
      const conn: Record<string, unknown> = { type: pack.id };
      for (const f of envFields) {
        if (!(f.key in conn) && f.env) conn[f.key] = `\${${f.env}}`;
      }
      connections[connection] = conn;
    }
  }

  const wired: { taskType: string; alreadyPresent: boolean }[] = [];
  for (const spec of specs) {
    const existing = workers.find((w) => w.taskType === spec.type);
    if (existing) {
      wired.push({ taskType: spec.type, alreadyPresent: true });
      // Heal an entry that references the pack but predates the connection.
      if (existing.connector === pack.id && connection && !existing.connection) {
        existing.connection = connection;
      }
      continue;
    }
    const entry: { taskType: string; connector: string; connection?: string } = {
      taskType: spec.type,
      connector: pack.id,
    };
    if (connection) entry.connection = connection;
    workers.push(entry);
    wired.push({ taskType: spec.type, alreadyPresent: false });
  }

  await io.writeText(appManifestPath, JSON.stringify(app, null, 2) + "\n");

  return {
    packId: pack.id,
    wired,
    connection,
    requiredEnv: [...requiredEnvSet],
  };
}
