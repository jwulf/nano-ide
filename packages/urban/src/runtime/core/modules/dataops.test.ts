import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { runDataOp } from "./dataops.ts";

// A project fixture: nano.app.json declaring one sqlite source with a migrations dir, plus a
// couple of migration files. runDataOp is called with root "." against a host anchored at `dir`
// (the same pattern `urban data` uses in the CLI), so paths resolve inside the fixture.
async function fixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "urban-dataops-"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(
    join(dir, "nano.app.json"),
    JSON.stringify({
      id: "shop",
      name: "Shop",
      data: {
        default: "app",
        sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
      },
    }),
  );
  await writeFile(
    join(dir, "db", "migrations", "001_orders.sql"),
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL);",
  );
  await writeFile(
    join(dir, "db", "migrations", "002_customers.sql"),
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, order_id INTEGER REFERENCES orders(id));",
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const run = (dir: string, req: Parameters<typeof runDataOp>[3]) =>
  runDataOp(createNodeHost({ cwd: dir }), ".", "nano.app.json", req);

test("sources lists declared datasources and the default", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = (await run(dir, { op: "sources" })) as {
      default: string;
      sources: { name: string; driver: string; url: string; migrations?: string }[];
    };
    assert.equal(r.default, "app");
    assert.deepEqual(r.sources, [
      { name: "app", driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" },
    ]);
  } finally {
    await cleanup();
  }
});

test("migrations lists pending files, migrate applies them, then schema reflects them", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // Before migrating: both files pending, schema empty.
    const before = (await run(dir, { op: "migrations" })) as {
      dir: string;
      entries: { name: string; applied: boolean; appliedAt: string | null }[];
    };
    assert.equal(before.dir, "db/migrations");
    assert.deepEqual(
      before.entries.map((e) => [e.name, e.applied]),
      [["001_orders.sql", false], ["002_customers.sql", false]],
    );
    assert.deepEqual((await run(dir, { op: "schema" })) as { tables: unknown[] }, { tables: [] });

    // migrate applies both in filename order.
    const migrated = (await run(dir, { op: "migrate" })) as { applied: string[]; pending: number };
    assert.deepEqual(migrated, { applied: ["001_orders.sql", "002_customers.sql"], pending: 0 });

    // migrations now reports them applied (with timestamps).
    const after = (await run(dir, { op: "migrations" })) as {
      entries: { name: string; applied: boolean; appliedAt: string | null }[];
    };
    assert.ok(after.entries.every((e) => e.applied && typeof e.appliedAt === "string"));

    // A second migrate is idempotent.
    assert.deepEqual(await run(dir, { op: "migrate" }), { applied: [], pending: 0 });

    // schema introspects the live DB — the migrations ledger table is excluded, FKs surface.
    const schema = (await run(dir, { op: "schema" })) as {
      tables: { name: string; columns: { name: string }[]; foreignKeys: { refTable: string }[] }[];
    };
    assert.deepEqual(schema.tables.map((t) => t.name), ["customers", "orders"]);
    const customers = schema.tables.find((t) => t.name === "customers")!;
    assert.deepEqual(customers.foreignKeys, [
      { column: "order_id", refTable: "orders", refColumn: "id", onDelete: "" },
    ]);
  } finally {
    await cleanup();
  }
});

test("exec then query round-trips rows with JSON-safe values", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await run(dir, { op: "migrate" });
    const ins = (await run(dir, {
      op: "exec",
      sql: "INSERT INTO orders (id, total) VALUES (?, ?)",
      params: [1, 4200],
    })) as { changed: number; lastInsertId?: number };
    assert.equal(ins.changed, 1);
    assert.equal(ins.lastInsertId, 1);

    const q = (await run(dir, { op: "query", sql: "SELECT id, total FROM orders" })) as {
      columns: string[];
      rows: Record<string, unknown>[];
    };
    assert.deepEqual(q.columns, ["id", "total"]);
    assert.deepEqual(q.rows, [{ id: 1, total: 4200 }]);
  } finally {
    await cleanup();
  }
});

test("script runs statements atomically and rolls back on failure", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await run(dir, { op: "migrate" });
    await run(dir, { op: "exec", sql: "INSERT INTO orders (id, total) VALUES (1, 10)" });

    // A failing script (second statement is invalid) rolls back the first.
    await assert.rejects(
      run(dir, {
        op: "script",
        statements: ["UPDATE orders SET total = 99 WHERE id = 1", "UPDATE nope SET x = 1"],
      }),
    );
    const after = (await run(dir, { op: "query", sql: "SELECT total FROM orders WHERE id = 1" })) as {
      rows: { total: number }[];
    };
    assert.equal(after.rows[0].total, 10, "the first UPDATE was rolled back");

    // A valid multi-statement script commits and reports the changed-row count.
    const ok = (await run(dir, {
      op: "script",
      statements: ["UPDATE orders SET total = 20 WHERE id = 1"],
    })) as { changed: number };
    assert.equal(ok.changed, 1);
  } finally {
    await cleanup();
  }
});

test("opening a read op does not apply migrations (schema stays empty until migrate)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // `schema`/`query` must not silently migrate — the DB manager opens the panel read-only.
    assert.deepEqual((await run(dir, { op: "schema" })) as { tables: unknown[] }, { tables: [] });
    const mig = (await run(dir, { op: "migrations" })) as {
      entries: { applied: boolean }[];
    };
    assert.ok(mig.entries.every((e) => !e.applied), "listing migrations did not apply them");
  } finally {
    await cleanup();
  }
});

test("listing migrations is side-effect-free (does not create the ledger table)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // Listing must not mutate the schema — the ledger table stays absent until `migrate`.
    await run(dir, { op: "migrations" });
    const ledger = (await run(dir, {
      op: "query",
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='_urban_migrations'",
    })) as { rows: unknown[] };
    assert.deepEqual(ledger.rows, [], "listing migrations must not create the ledger table");
  } finally {
    await cleanup();
  }
});

test("migrations treats a missing migrations dir as an empty list", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await rm(join(dir, "db", "migrations"), { recursive: true, force: true });
    const mig = (await run(dir, { op: "migrations" })) as {
      dir: string;
      entries: unknown[];
    };
    assert.equal(mig.dir, "db/migrations");
    assert.deepEqual(mig.entries, [], "a missing dir lists no migrations instead of throwing");
  } finally {
    await cleanup();
  }
});

test("domaintypes is not yet implemented and errors clearly", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await assert.rejects(run(dir, { op: "domaintypes" }), /not yet implemented/);
  } finally {
    await cleanup();
  }
});

test("an unknown op and an unknown source error", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await assert.rejects(run(dir, { op: "nope" }), /unknown op/);
    await assert.rejects(run(dir, { op: "schema", source: "ghost" }), /no such data source/);
  } finally {
    await cleanup();
  }
});
