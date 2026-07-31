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

/** Build the CREATE TABLE statement for one type. */
export function createTableSql(typeName: string, def: ToolkitType): string {
  const table = assertSqlIdent("table name", def.table ?? typeName);
  const cols: string[] = ["  id INTEGER PRIMARY KEY AUTOINCREMENT"];
  const fields = def.fields ?? {};
  for (const [name, f] of Object.entries(fields)) {
    assertSqlIdent("field name", name);
    if (name === "id") {
      throw new Error(`type "${typeName}": field "id" is reserved (the table's implicit primary key)`);
    }
    const notNull = f.optional ? "" : " NOT NULL";
    cols.push(`  ${name} ${sqlType(f.type)}${notNull}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${cols.join(",\n")}\n);`;
}

export function deriveMigrations(manifest: ToolkitManifest): DerivedArtifact[] {
  const types = manifest.types ?? {};
  const defaultSource = manifest.data?.default ?? "app";

  // Group types by their datasource.
  const bySource = new Map<string, Array<[string, ToolkitType]>>();
  for (const [name, def] of Object.entries(types)) {
    const src = def.source ?? defaultSource;
    const list = bySource.get(src) ?? [];
    list.push([name, def]);
    bySource.set(src, list);
  }

  const artifacts: DerivedArtifact[] = [];
  for (const [src, list] of bySource) {
    const header =
      `-- Derived from manifest \`types\` by @nanobpm/urban-toolkit. Do not edit.\n` +
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
