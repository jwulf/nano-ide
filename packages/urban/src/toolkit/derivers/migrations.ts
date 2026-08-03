// Deriver: manifest `types` → SQL schema. Turns the declared domain model into a canonical
// CREATE TABLE script per datasource, so the schema is derived from the model instead of
// hand-maintained. Deterministic: same manifest ⇒ byte-identical SQL.

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";

export interface ToolkitField {
  type?: string;
  optional?: boolean;
}
export interface ToolkitType {
  table?: string;
  fields?: Record<string, ToolkitField>;
  /** Optional datasource id; defaults to data.default. */
  source?: string;
}
export interface ToolkitManifest {
  id?: string;
  data?: { default?: string; sources?: Record<string, unknown> };
  types?: Record<string, ToolkitType>;
}

/** Map a domain field type to a SQLite column type. Unknown types fall back to TEXT. */
export function sqlType(t: string | undefined): string {
  switch ((t ?? "string").toLowerCase()) {
    case "int":
    case "integer":
    case "bool":
    case "boolean":
      return "INTEGER";
    case "float":
    case "double":
    case "number":
      return "REAL";
    case "blob":
    case "bytes":
      return "BLOB";
    default:
      // string, datetime, date, time, json, uuid, enum, … all serialise as TEXT.
      return "TEXT";
  }
}

/** A safe unquoted SQL identifier. We interpolate table/column names directly, so
 * reject anything that isn't a plain identifier to prevent invalid SQL / injection. */
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertSqlIdent(kind: string, name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new Error(`invalid ${kind} "${name}": must match ${SQL_IDENT.source}`);
  }
  return name;
}

/** A column in a manifest type's canonical table schema. `sqlType` is the SQLite
 * declared type (the affinity source for both the CREATE TABLE and the row types). */
export interface DerivedColumn {
  name: string;
  sqlType: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** The canonical table schema for one manifest type. */
export interface DerivedTable {
  table: string;
  columns: DerivedColumn[];
}

/**
 * Derive the canonical table schema for one manifest type: an implicit
 * autoincrement `id` primary key plus one column per declared field. This is the
 * single source of truth both the SQL migration (`createTableSql`) and the domain
 * row-types (`domain.ts`) derive from, so the schema can never drift between them.
 */
export function tableSchemaForType(typeName: string, def: ToolkitType): DerivedTable {
  const table = assertSqlIdent("table name", def.table ?? typeName);
  const columns: DerivedColumn[] = [
    { name: "id", sqlType: "INTEGER", notNull: false, primaryKey: true },
  ];
  const fields = def.fields ?? {};
  for (const [name, f] of Object.entries(fields)) {
    assertSqlIdent("field name", name);
    if (name === "id") {
      throw new Error(`type "${typeName}": field "id" is reserved (the table's implicit primary key)`);
    }
    columns.push({ name, sqlType: sqlType(f.type), notNull: !f.optional, primaryKey: false });
  }
  return { table, columns };
}

/** Group manifest types by their datasource, preserving declaration order within each
 * source. Shared by the migrations and domain derivers so both partition and order
 * sources identically (a single source of truth for the source spine). */
export function groupTypesBySource(
  manifest: ToolkitManifest,
): Map<string, Array<[string, ToolkitType]>> {
  const types = manifest.types ?? {};
  const defaultSource = manifest.data?.default ?? "app";
  const bySource = new Map<string, Array<[string, ToolkitType]>>();
  for (const [name, def] of Object.entries(types)) {
    const src = def.source ?? defaultSource;
    const list = bySource.get(src) ?? [];
    list.push([name, def]);
    bySource.set(src, list);
  }
  return bySource;
}

/** Build the CREATE TABLE statement for one type, from its canonical schema. */
export function createTableSql(typeName: string, def: ToolkitType): string {
  const { table, columns } = tableSchemaForType(typeName, def);
  const cols = columns.map((c) =>
    c.primaryKey
      ? `  ${c.name} ${c.sqlType} PRIMARY KEY AUTOINCREMENT`
      : `  ${c.name} ${c.sqlType}${c.notNull ? " NOT NULL" : ""}`
  );
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${cols.join(",\n")}\n);`;
}

export function deriveMigrations(manifest: ToolkitManifest): DerivedArtifact[] {
  const bySource = groupTypesBySource(manifest);

  const artifacts: DerivedArtifact[] = [];
  for (const [src, list] of bySource) {
    const header =
      `-- Derived from manifest \`types\` by @nanobpm/urban (urban gen). Do not edit.\n` +
      `-- Datasource: ${src}\n\n`;
    const body = list.map(([name, def]) => createTableSql(name, def)).join("\n\n");
    artifacts.push({ path: `${GENERATED_DIR}/${src}.schema.sql`, content: `${header}${body}\n` });
  }
  return artifacts;
}

export const migrationsDeriver: Deriver<ToolkitManifest> = {
  id: "types->migrations",
  describe: "Derive SQL schema (CREATE TABLE) from manifest domain types.",
  derive: deriveMigrations,
};
