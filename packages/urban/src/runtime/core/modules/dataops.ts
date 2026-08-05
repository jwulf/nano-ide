// dataops — the DB-manager op protocol behind `urban data`. A single JSON request is
// dispatched against a manifest datasource and a single JSON result is returned; the CLI
// (`urban data`, cli.ts) wraps it in the `{ ok, ... }` stdin/stdout envelope. This is the
// runtime-agnostic core the Nano console re-points its **Data** panel (Tables / SQL /
// Migrations) at, replacing the vendored `nano-generated/data-cli.ts` (host dry-out #576).
//
// Every op runs THROUGH the same datasource seam the app runtime uses (`openSqliteSource` +
// `makeGateway`), so the panel browses exactly what the named source resolves to — never a
// parallel path. Read/list ops open the source WITHOUT applying migrations (opening the DB
// manager must not silently mutate the schema); `migrate` applies pending migrations on the
// shared `_urban_migrations` ledger.
//
//   Request:  { op, source?, sql?, params?, statements? }
//   op = "sources" | "schema" | "query" | "exec" | "script" | "migrations" | "migrate"
//
// `domaintypes` (live-schema reification + shape resolution) is intentionally NOT handled here
// yet — it is ported to `urban data` in a follow-up (PR 2 of #576) and errors clearly for now.

import type { HostContext, SqliteDb } from "../host.ts";
import type { AppManifest, DataSource as ManifestDataSource } from "../manifest.ts";
import { loadManifest } from "../manifest.ts";
import { validateManifest } from "../validate.ts";
import { makeGateway, type DataSource as GatewayDataSource } from "./gateway.ts";
import { applyMigrations, openSqliteSource } from "./datasource.ts";

export interface DataRequest {
  op: string;
  source?: string;
  sql?: string;
  params?: unknown[];
  statements?: string[];
}

/** One datasource the manifest declares, resolved against the environment (env templates in
 * `driver`/`url` are already expanded by `loadManifest`). Mirrors the console's `ResolvedSource`
 * so the panel's datasource picker is unchanged. */
export interface ResolvedSource {
  name: string;
  driver: string;
  url: string;
  migrations?: string;
}

const MIGRATIONS_TABLE = "_urban_migrations";
const DEFAULT_MIGRATIONS_DIR = "db/migrations";

/** JSON-safe a value: BigInt → number (when lossless) or string, recursing objects/arrays. SQLite
 * reports `lastInsertRowid` (and INTEGER columns) as BigInt, which `JSON.stringify` cannot encode. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

/** Column order across a row set: first-seen order, unioned over every row (rows may be ragged). */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** Split a script on `;` boundaries, dropping blank and comment-only fragments. Minimal DDL
 * splitter (ADR 0024 "minimal dialect stance"); does not parse semicolons inside string literals. */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split("\n").every((l) => l.trim().startsWith("--")));
}

/** List every declared datasource plus the default's name (no connection opened). */
export function listSources(manifest: AppManifest): { default?: string; sources: ResolvedSource[] } {
  const data = manifest.data;
  const sources: ResolvedSource[] = Object.entries(data?.sources ?? {}).map(([name, raw]) => ({
    name,
    driver: String(raw.driver),
    url: raw.url,
    migrations: raw.migrations,
  }));
  return { default: data?.default, sources };
}

/** Resolve the source a request names (the default, or the sole source, when unnamed). */
function pickSource(manifest: AppManifest, name?: string): { name: string; src: ManifestDataSource } {
  const data = manifest.data;
  const sources = data?.sources ?? {};
  const chosen = name || data?.default || Object.keys(sources)[0];
  if (!chosen) throw new Error("no data source specified and none declared in the manifest");
  const src = sources[chosen];
  if (!src) throw new Error(`no such data source "${chosen}"`);
  return { name: chosen, src };
}

/** Open the requested source's gateway WITHOUT applying migrations (opening the DB manager must
 * not mutate the schema). The caller closes the returned handle. */
async function openGateway(
  host: HostContext,
  root: string,
  manifest: AppManifest,
  name?: string,
): Promise<{ gw: GatewayDataSource; db: SqliteDb }> {
  const { name: chosen, src } = pickSource(manifest, name);
  if (String(src.driver) !== "sqlite") {
    throw new Error(
      `data source "${chosen}" uses driver "${String(src.driver)}"; only "sqlite" is implemented`,
    );
  }
  let db: SqliteDb;
  try {
    db = await openSqliteSource(host, root, src.url);
  } catch (err) {
    // Prefix the source name onto openSqliteSource's runtime-agnostic message so the CLI/console
    // error names which datasource failed (mirrors provisionSqlite).
    throw new Error(`datasource "${chosen}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return { gw: makeGateway(db), db };
}

/**
 * Resolve a `--manifest` argument against the app `root`. An absolute path (`/abs/nano.app.json`)
 * is honoured as-is; a relative path is joined onto `root`. Mirrors `resolveSqlitePath` so manifest
 * and datasource path resolution stay consistent.
 */
function resolveManifestPath(root: string, manifestPath: string): string {
  return manifestPath.startsWith("/")
    ? manifestPath
    : `${root.replace(/\/+$/, "")}/${manifestPath}`;
}

/**
 * Dispatch one DB-manager op against the app at `root`. Returns the op's result object (the CLI
 * wraps it as `{ ok: true, ...result }`); throws on a handled error (wrapped as `{ ok: false }`).
 */
export async function runDataOp(
  host: HostContext,
  root: string,
  manifestPath: string,
  req: DataRequest,
): Promise<Record<string, unknown>> {
  const manifest = validateManifest(
    await loadManifest(host, resolveManifestPath(root, manifestPath)),
  );

  switch (req.op) {
    case "sources": {
      const { sources, default: def } = listSources(manifest);
      return { default: def, sources };
    }
    case "schema": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        return { tables: await gw.schema() };
      } finally {
        db.close();
      }
    }
    case "query": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        const rows = (await gw.query(req.sql ?? "", req.params ?? [])) as Record<string, unknown>[];
        return { columns: columnsOf(rows), rows: jsonSafe(rows) as unknown[] };
      } finally {
        db.close();
      }
    }
    case "exec": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        return jsonSafe(await gw.exec(req.sql ?? "", req.params ?? [])) as Record<string, unknown>;
      } finally {
        db.close();
      }
    }
    case "script": {
      // Run several statements atomically in one transaction — the console's structure editor
      // uses this for the SQLite 12-step table rebuild (create → copy → drop → rename), so a
      // mid-rebuild failure rolls back and leaves the table untouched. Statements come pre-split
      // from the caller; `?`-params are not threaded (DDL needs none).
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        const statements = Array.isArray(req.statements)
          ? req.statements
          : splitStatements(req.sql ?? "");
        let changed = 0;
        await gw.tx(async (t) => {
          for (const stmt of statements) {
            if (stmt.trim()) changed += (await t.exec(stmt)).changed;
          }
        });
        return { changed };
      } finally {
        db.close();
      }
    }
    case "migrations": {
      const { name, src } = pickSource(manifest, req.source);
      const relDir = src.migrations ?? DEFAULT_MIGRATIONS_DIR;
      const absDir = `${root.replace(/\/+$/, "")}/${relDir.replace(/^\/+/, "")}`;
      // `migrations` is a read/list op: treat a missing dir as no migrations (mirrors
      // applyMigrations) instead of throwing on host.listDir.
      const files = (await host.exists(absDir))
        ? (await host.listDir(absDir)).filter((f) => f.endsWith(".sql")).sort()
        : [];
      const { gw, db } = await openGateway(host, root, manifest, name);
      try {
        // Do not create the ledger table here — listing migrations must not mutate the
        // schema. If the ledger doesn't exist yet, nothing has been applied.
        const ledgerExists =
          (
            await gw.query(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='${MIGRATIONS_TABLE}'`,
            )
          ).length > 0;
        const applied = ledgerExists
          ? new Map<string, string>(
              (await gw.query(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE}`)).map((r) => [
                String(r.name),
                String(r.applied_at),
              ]),
            )
          : new Map<string, string>();
        return {
          dir: relDir,
          entries: files.map((name) => ({
            name,
            applied: applied.has(name),
            appliedAt: applied.get(name) ?? null,
          })),
        };
      } finally {
        db.close();
      }
    }
    case "migrate": {
      const { name, src } = pickSource(manifest, req.source);
      const { db } = await openGateway(host, root, manifest, name);
      try {
        const applied = await applyMigrations(
          host,
          db,
          root,
          src.migrations ?? DEFAULT_MIGRATIONS_DIR,
        );
        return { applied, pending: 0 };
      } finally {
        db.close();
      }
    }
    case "domaintypes": {
      throw new Error(
        "`domaintypes` is not yet implemented in `urban data` — the Nano console still serves it " +
          "(tracked as PR 2 of nano-bpm#576)",
      );
    }
    default:
      throw new Error(`unknown op "${req.op}"`);
  }
}
