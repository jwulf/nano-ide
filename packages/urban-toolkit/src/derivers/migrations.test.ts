import { test } from "node:test";
import assert from "node:assert/strict";
import { createTableSql, deriveMigrations, sqlType } from "./migrations.ts";

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
  assert.match(sql, /CREATE TABLE IF NOT EXISTS greetings/);
  assert.match(sql, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /who TEXT NOT NULL/);
  assert.match(sql, /when TEXT(?! NOT NULL)/);
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
