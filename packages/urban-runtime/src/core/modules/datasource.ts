// datasource — provision the manifest `data` sources and expose typed accessors for the
// `types` domain model. Only the `sqlite` driver is implemented; other drivers hit an
// explicit seam (they are declared in the manifest but not yet provisioned). This is the
// runtime side of ADR 0024 (datasource) + ADR 0040 (domain model), scoped to what an app needs.

import type { RuntimeContext } from "../context.ts";
import type { HostContext, SqliteDb } from "../host.ts";
import type { AppManifest, DataSource, DomainType } from "../manifest.ts";

function sqlitePathFromUrl(url: string): string {
  // Accept "file:./x.db", "file:x.db", "sqlite:./x.db" or a bare path.
  return url.replace(/^(file|sqlite):(\/\/)?/, "");
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** A typed accessor over a table declared in manifest `types`. */
export class TypeRepo {
  private readonly db: SqliteDb;
  readonly typeName: string;
  private readonly def: DomainType;

  constructor(db: SqliteDb, typeName: string, def: DomainType) {
    this.db = db;
    this.typeName = typeName;
    this.def = def;
  }

  private table(): string {
    if (!this.def.table) throw new Error(`type "${this.typeName}" has no table`);
    return this.def.table;
  }

  private assertFields(row: Record<string, unknown>): void {
    const declared = this.def.fields;
    if (!declared) return;
    for (const key of Object.keys(row)) {
      if (!(key in declared)) {
        throw new Error(
          `field "${key}" is not declared on type "${this.typeName}" (guards schema drift)`,
        );
      }
    }
  }

  insert(row: Record<string, unknown>): { changes: number; lastInsertRowid: number | bigint } {
    this.assertFields(row);
    const keys = Object.keys(row);
    const cols = keys.join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO ${this.table()} (${cols}) VALUES (${placeholders})`;
    return this.db.run(sql, keys.map((k) => row[k]));
  }

  all<T = Record<string, unknown>>(): T[] {
    return this.db.all<T>(`SELECT * FROM ${this.table()}`);
  }

  query<T = Record<string, unknown>>(where: Record<string, unknown>): T[] {
    this.assertFields(where);
    const keys = Object.keys(where);
    if (keys.length === 0) return this.all<T>();
    const clause = keys.map((k) => `${k} = ?`).join(" AND ");
    return this.db.all<T>(
      `SELECT * FROM ${this.table()} WHERE ${clause}`,
      keys.map((k) => where[k]),
    );
  }
}

export interface ProvisionedSource {
  readonly name: string;
  readonly driver: string;
  readonly db: SqliteDb;
  readonly migrationsApplied: string[];
  close(): void;
}

export class DataLayer {
  private readonly sources: Map<string, ProvisionedSource>;
  private readonly defaultSource: string | undefined;
  private readonly types: Record<string, DomainType>;

  constructor(
    sources: Map<string, ProvisionedSource>,
    defaultSource: string | undefined,
    types: Record<string, DomainType>,
  ) {
    this.sources = sources;
    this.defaultSource = defaultSource;
    this.types = types;
  }

  source(name?: string): ProvisionedSource {
    const key = name ?? this.defaultSource;
    if (!key) throw new Error("no data source specified and no default configured");
    const s = this.sources.get(key);
    if (!s) throw new Error(`no such data source "${key}"`);
    return s;
  }

  /** A typed accessor for a declared domain type (uses the default source). */
  repo(typeName: string, sourceName?: string): TypeRepo {
    const def = this.types[typeName];
    if (!def) throw new Error(`no such type "${typeName}"`);
    return new TypeRepo(this.source(sourceName).db, typeName, def);
  }

  describe(): Record<string, unknown> {
    return {
      default: this.defaultSource,
      sources: [...this.sources.values()].map((s) => ({
        name: s.name,
        driver: s.driver,
        migrations: s.migrationsApplied.length,
      })),
    };
  }

  closeAll(): void {
    for (const s of this.sources.values()) s.close();
  }
}

async function applyMigrations(
  host: HostContext,
  db: SqliteDb,
  root: string,
  migrationsDir: string,
): Promise<string[]> {
  const dir = `${root.replace(/\/+$/, "")}/${migrationsDir.replace(/^\/+/, "")}`;
  if (!(await host.exists(dir))) return [];
  const files = (await host.listDir(dir)).filter((f) => f.endsWith(".sql")).sort();
  db.exec(
    "CREATE TABLE IF NOT EXISTS _urban_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db.all<{ name: string }>("SELECT name FROM _urban_migrations").map((r) => r.name),
  );
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await host.readTextFile(`${dir}/${file}`);
    db.exec(sql);
    db.run("INSERT INTO _urban_migrations (name, applied_at) VALUES (?, ?)", [
      file,
      new Date(host.now()).toISOString(),
    ]);
    newlyApplied.push(file);
  }
  return newlyApplied;
}

async function provisionSqlite(
  ctx: RuntimeContext,
  name: string,
  src: DataSource,
): Promise<ProvisionedSource> {
  const dbPath = sqlitePathFromUrl(src.url);
  const abs = dbPath.startsWith("/") ? dbPath : `${ctx.root.replace(/\/+$/, "")}/${dbPath}`;
  const dir = parentDir(abs);
  if (dir && !(await ctx.host.exists(dir))) {
    // openSqlite is expected to create the file; the directory must exist first.
    ctx.host.log("warn", `datasource: directory for "${name}" does not exist`, { dir });
  }
  const db = ctx.host.openSqlite(abs);
  db.exec("PRAGMA journal_mode=WAL");
  const migrationsApplied = src.migrations
    ? await applyMigrations(ctx.host, db, ctx.root, src.migrations)
    : [];
  ctx.host.log("info", `datasource: provisioned "${name}"`, {
    driver: "sqlite",
    path: abs,
    migrationsApplied,
  });
  return {
    name,
    driver: "sqlite",
    db,
    migrationsApplied,
    close: () => db.close(),
  };
}

/** Provision every declared source and return the typed data layer. */
export async function provisionData(ctx: RuntimeContext): Promise<DataLayer> {
  const data = ctx.manifest.data;
  const sources = new Map<string, ProvisionedSource>();
  for (const [name, src] of Object.entries(data?.sources ?? {})) {
    if (src.driver !== "sqlite") {
      throw new Error(
        `data source "${name}" uses driver "${src.driver}"; only "sqlite" is implemented ` +
          `(the driver seam is intentionally open for future drivers)`,
      );
    }
    sources.set(name, await provisionSqlite(ctx, name, src));
  }
  return new DataLayer(sources, data?.default, ctx.manifest.types ?? {});
}
