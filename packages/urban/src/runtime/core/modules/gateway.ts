// The record-oriented datasource gateway (ADR 0024 / ADR 0029 §6, ADR 0055 phase 1).
//
// This is the runtime port of the console-generated `data-sdk.ts` `DataSource` + `Table<T>`:
// the RAD "TTable" a handler binds to instead of hand-writing SQL. It sits on the runtime's
// synchronous `SqliteDb` host seam but keeps the *async* app-facing contract (every method
// returns a Promise), so an app-hosted worker/action/surface handler reaches typed records the
// same way regardless of which driver backs the source underneath.
//
//   const db = app.data.open();                 // the default source as a DataSource
//   await db.exec("INSERT INTO orders(id) VALUES (?)", [id]);
//   const orders = db.table<Order>("orders");   // a typed gateway over one table
//   await orders.insert({ id, status: "new" });
//   const o = await orders.get(id);

import type { SqliteDb } from "../host.ts";

export type Row = Record<string, unknown>;

export interface ExecResult {
  /** Rows changed by an INSERT/UPDATE/DELETE. */
  changed: number;
  /** Rowid of the last inserted row, when the driver reports one. */
  lastInsertId?: number | bigint;
}

/** One column of a table, from the datasource's introspected schema. */
export interface ColumnMeta {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** One foreign-key constraint: `column` references `refTable(refColumn)`. `refColumn` is empty
 * when the FK targets the parent's primary key without naming a column; `onDelete` is the
 * referential action (e.g. `CASCADE`), empty when none was declared. */
export interface ForeignKeyMeta {
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/** One table: its columns, index names, and foreign keys. Powers domain-type projection and
 * the page runtime's list/detail binding. */
export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  indexes: string[];
  foreignKeys: ForeignKeyMeta[];
}

/** The one thin, uniform interface behind every driver (ADR 0024 §2) — the `TDataSet`
 * equivalent. Every consumer shares exactly this surface, so the driver underneath is
 * interchangeable. */
export interface DataSource {
  /** Run a SELECT (or any row-returning statement) and collect the rows. */
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Run a non-row statement (INSERT/UPDATE/DELETE/DDL). */
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  /** Run `fn` inside a transaction, committing on success and rolling back on throw. The
   * handle passed to `fn` targets the same connection. */
  tx<T>(fn: (t: DataSource) => Promise<T>): Promise<T>;
  /** Introspect the datasource's tables/columns/indexes/foreign keys. */
  schema(): Promise<TableMeta[]>;
  /** A typed gateway over one table — the RAD "TTable". `pk` is the primary-key column
   * (default "id"). */
  table<T extends object = Row>(name: string, pk?: string): Table<T>;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Build a parameterised ` WHERE a = ? AND b = ?` clause from an equality map; an empty map
 * yields an empty clause (matches all rows). Takes `object` (not `Row`) so a `Partial<T>` for a
 * generated `interface` row type (which lacks a string index signature) is accepted. */
function whereClause(where: object): { clause: string; params: unknown[] } {
  const w = where as Row;
  const keys = Object.keys(w);
  if (keys.length === 0) return { clause: "", params: [] };
  const clause = " WHERE " + keys.map((k) => `${quoteIdent(k)} = ?`).join(" AND ");
  return { clause, params: keys.map((k) => w[k]) };
}

/** A typed gateway over a single table — the record-oriented data object a handler binds to
 * instead of hand-writing SQL (the Delphi `TTable`/data-module idea, ADR 0029 §6). It builds
 * parameterised SQL from a typed row object's own keys, so callers manipulate rows as records.
 * `T` comes from a generated row type; this class is generic *runtime* and knows nothing about
 * any specific schema. `pk` is the primary-key column (default `id`). */
export class Table<T extends object = Row> {
  readonly name: string;
  readonly pk: string;
  readonly #src: DataSource;

  constructor(src: DataSource, name: string, pk = "id") {
    this.#src = src;
    this.name = name;
    this.pk = pk;
  }

  /** Insert one row (only the present keys are written); returns the new primary-key value
   * (the inserted rowid for an INTEGER PRIMARY KEY). */
  async insert(row: Partial<T>): Promise<number | bigint> {
    const keys = Object.keys(row);
    if (keys.length === 0) {
      throw new Error(`Table(${this.name}).insert: no columns to insert`);
    }
    const cols = keys.map(quoteIdent).join(", ");
    const ph = keys.map(() => "?").join(", ");
    const r = await this.#src.exec(
      `INSERT INTO ${quoteIdent(this.name)} (${cols}) VALUES (${ph})`,
      keys.map((k) => (row as Row)[k]),
    );
    if (r.lastInsertId == null) {
      // The driver reported no rowid — treat as a failed/ambiguous insert rather than
      // silently returning 0, which a caller could mistake for a real primary key.
      throw new Error(`Table(${this.name}).insert: driver reported no lastInsertId`);
    }
    return r.lastInsertId;
  }

  /** Fetch the row with the given primary key, or `undefined`. */
  async get(id: unknown): Promise<T | undefined> {
    const rows = await this.#src.query(
      `SELECT * FROM ${quoteIdent(this.name)} WHERE ${quoteIdent(this.pk)} = ? LIMIT 1`,
      [id],
    );
    return rows[0] as T | undefined;
  }

  /** Every row (optionally capped at `limit`). */
  async all(limit?: number): Promise<T[]> {
    const lim =
      typeof limit === "number" && Number.isFinite(limit)
        ? ` LIMIT ${Math.max(0, Math.floor(limit))}`
        : "";
    return (await this.#src.query(`SELECT * FROM ${quoteIdent(this.name)}${lim}`)) as T[];
  }

  /** Rows matching an equality filter (keys ANDed). An empty filter matches all rows. */
  async find(where: Partial<T> = {}): Promise<T[]> {
    const { clause, params } = whereClause(where as Row);
    return (await this.#src.query(
      `SELECT * FROM ${quoteIdent(this.name)}${clause}`,
      params,
    )) as T[];
  }

  /** The first row matching an equality filter, or `undefined`. */
  async findOne(where: Partial<T> = {}): Promise<T | undefined> {
    const { clause, params } = whereClause(where as Row);
    const rows = await this.#src.query(
      `SELECT * FROM ${quoteIdent(this.name)}${clause} LIMIT 1`,
      params,
    );
    return rows[0] as T | undefined;
  }

  /** Patch the row with the given primary key; returns rows changed. */
  async update(id: unknown, patch: Partial<T>): Promise<number> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return 0;
    const set = keys.map((k) => `${quoteIdent(k)} = ?`).join(", ");
    const r = await this.#src.exec(
      `UPDATE ${quoteIdent(this.name)} SET ${set} WHERE ${quoteIdent(this.pk)} = ?`,
      [...keys.map((k) => (patch as Row)[k]), id],
    );
    return r.changed;
  }

  /** Delete the row with the given primary key; returns rows changed. */
  async delete(id: unknown): Promise<number> {
    const r = await this.#src.exec(
      `DELETE FROM ${quoteIdent(this.name)} WHERE ${quoteIdent(this.pk)} = ?`,
      [id],
    );
    return r.changed;
  }

  /** Count rows matching an equality filter (all rows when omitted). */
  async count(where: Partial<T> = {}): Promise<number> {
    const { clause, params } = whereClause(where as Row);
    const rows = await this.#src.query(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(this.name)}${clause}`,
      params,
    );
    return Number((rows[0] as Row)?.n ?? 0);
  }
}

/** A `DataSource` implemented over the runtime's synchronous `SqliteDb` host seam. The methods
 * are async to hold the app-facing contract; the work underneath is synchronous. */
class SqliteGateway implements DataSource {
  readonly #db: SqliteDb;
  constructor(db: SqliteDb) {
    this.#db = db;
  }

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.#db.all<Row>(sql, params);
  }

  async exec(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const r = this.#db.run(sql, params);
    return { changed: Number(r.changes), lastInsertId: r.lastInsertRowid };
  }

  async tx<T>(fn: (t: DataSource) => Promise<T>): Promise<T> {
    this.#db.exec("BEGIN");
    try {
      const out = await fn(this);
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  async schema(): Promise<TableMeta[]> {
    // Exclude SQLite internals (`sqlite_%`) and Nano's own bookkeeping tables (`_urban_%` /
    // `_nano_%`, e.g. the migrations ledger): neither is a user/domain table, so they must
    // never surface in the domain model, DB Manager, or forms.
    const tables = this.#db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_urban\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE '\\_nano\\_%' ESCAPE '\\' ORDER BY name",
    );
    const out: TableMeta[] = [];
    for (const t of tables) {
      const cols = this.#db.all<{ name: string; type: string; notnull: number; pk: number }>(
        `PRAGMA table_info(${quoteIdent(t.name)})`,
      );
      const idx = this.#db.all<{ name: string }>(`PRAGMA index_list(${quoteIdent(t.name)})`);
      const fks = this.#db.all<{
        from: string;
        table: string;
        to: string | null;
        on_delete?: string;
      }>(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`);
      out.push({
        name: t.name,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: !!c.notnull,
          primaryKey: !!c.pk,
        })),
        indexes: idx.map((i) => String(i.name)),
        foreignKeys: fks.map((f) => ({
          column: f.from,
          refTable: f.table,
          refColumn: f.to ?? "",
          onDelete:
            f.on_delete && f.on_delete.toUpperCase() !== "NO ACTION"
              ? f.on_delete.toUpperCase()
              : "",
        })),
      });
    }
    return out;
  }

  table<T extends object = Row>(name: string, pk = "id"): Table<T> {
    return new Table<T>(this, name, pk);
  }
}

/** Wrap a provisioned `SqliteDb` as the record-oriented `DataSource` gateway. */
export function makeGateway(db: SqliteDb): DataSource {
  return new SqliteGateway(db);
}
