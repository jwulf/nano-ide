import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTableSql, deriveMigrations, sqlType } from "./migrations.ts";
import { deriveDomain } from "./domain.ts";

test("sqlType maps domain types to SQLite affinities", () => {
  assert.equal(sqlType("string"), "TEXT");
  assert.equal(sqlType("datetime"), "TEXT");
  assert.equal(sqlType("int"), "INTEGER");
  assert.equal(sqlType("boolean"), "INTEGER");
  assert.equal(sqlType("number"), "REAL");
  assert.equal(sqlType("blob"), "BLOB");
  assert.equal(sqlType(undefined), "TEXT");
});

test("createTableSql emits id PK, NOT NULL by default, nullable when optional", () => {
  const sql = createTableSql("greeting", {
    table: "greetings",
    fields: { who: { type: "string" }, when: { type: "datetime", optional: true } },
  });
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "greetings"/);
  assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /"who" TEXT NOT NULL/);
  assert.match(sql, /"when" TEXT(?! NOT NULL)/);
});

test("createTableSql rejects a reserved 'id' field and non-identifier names", () => {
  assert.throws(
    () => createTableSql("t", { table: "ts", fields: { id: { type: "string" } } }),
    /field "id" is reserved/,
  );
  assert.throws(
    () => createTableSql("t", { table: "bad-name", fields: { x: { type: "string" } } }),
    /invalid table name/,
  );
});

test("deriveMigrations groups by datasource and is deterministic", () => {
  const manifest = {
    data: { default: "app" },
    types: {
      a: { table: "as", fields: { x: { type: "string" } } },
      b: { table: "bs", fields: { y: { type: "int" } }, source: "audit" },
    },
  };
  const a1 = deriveMigrations(manifest);
  const a2 = deriveMigrations(manifest);
  assert.deepEqual(a1, a2, "same manifest ⇒ identical artifacts");
  const paths = a1.map((x) => x.path).sort();
  assert.deepEqual(paths, ["nano-generated/app.schema.sql", "nano-generated/audit.schema.sql"]);
});

// #88: reserved-word table/column names (e.g. `order`, `group`) are valid SQL identifiers
// only when quoted. Guard the defect class — not just `order` — by executing the derived DDL
// against a real SQLite engine, so any unquoted reserved identifier fails here, not at runtime.
test("createTableSql quotes identifiers so reserved-word names produce executable DDL", () => {
  const sql = createTableSql("order", {
    fields: { group: { type: "string" }, select: { type: "int", optional: true } },
  });
  // Identifiers are double-quoted.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "order"/);
  assert.match(sql, /"group" TEXT NOT NULL/);
  assert.match(sql, /"select" INTEGER(?! NOT NULL)/);
  // And the DDL actually executes against a real SQLite engine.
  const db = new DatabaseSync(":memory:");
  try {
    assert.doesNotThrow(() => db.exec(sql), "derived DDL must execute against node:sqlite");
  } finally {
    db.close();
  }
});

// #88 companion: the domain deriver keys `DomainTables` off the raw wire name via
// JSON.stringify, so a reserved-word type name still resolves as a string-literal key.
test("deriveDomain keeps reserved-word table names addressable in DomainTables", () => {
  const [artifact] = deriveDomain({
    data: { default: "app" },
    types: { order: { fields: { group: { type: "string" } } } },
  });
  // Anchor to the DomainTables interface specifically — DomainTypes also emits an
  // "order" key, so a bare /"order":/ would pass even if the DomainTables spine regressed.
  assert.match(
    artifact.content,
    /export interface DomainTables \{\s*"order":/,
    'DomainTables["order"] must resolve',
  );
});
