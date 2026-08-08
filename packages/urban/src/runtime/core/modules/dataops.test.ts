import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { isRecord } from "../guards.ts";
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
      schemaVersion: 1,
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

function expectRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new TypeError("expected an array of records");
  }
  return value;
}

function expectString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a string");
  return value;
}

test("sources lists declared datasources and the default", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = await run(dir, { op: "sources" });
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
    const before = await run(dir, { op: "migrations" });
    assert.equal(before.dir, "db/migrations");
    const beforeEntries = expectRecords(before.entries);
    assert.deepEqual(
      beforeEntries.map((e) => [e.name, e.applied]),
      [["001_orders.sql", false], ["002_customers.sql", false]],
    );
    assert.deepEqual(await run(dir, { op: "schema" }), { tables: [] });

    // migrate applies both in filename order.
    const migrated = await run(dir, { op: "migrate" });
    assert.deepEqual(migrated, { applied: ["001_orders.sql", "002_customers.sql"], pending: 0 });

    // migrations now reports them applied (with timestamps).
    const after = await run(dir, { op: "migrations" });
    assert.ok(expectRecords(after.entries).every((e) => e.applied && typeof e.appliedAt === "string"));

    // A second migrate is idempotent.
    assert.deepEqual(await run(dir, { op: "migrate" }), { applied: [], pending: 0 });

    // schema introspects the live DB — the migrations ledger table is excluded, FKs surface.
    const schema = await run(dir, { op: "schema" });
    const tables = expectRecords(schema.tables);
    assert.deepEqual(tables.map((t) => t.name), ["customers", "orders"]);
    const customers = tables.find((t) => t.name === "customers");
    assert.ok(customers);
    assert.deepEqual(customers.foreignKeys, [
      { column: "order_id", refTable: "orders", refColumn: "id", onDelete: "" },
    ]);
  } finally {
    await cleanup();
  }
});

test("migrations honours an absolute migrations dir (root is not wrongly prefixed)", async () => {
  // A manifest may declare an absolute migrations path (e.g. a Node host pointing at a shared
  // location). It must be used as-is, not joined onto the app root — this guards the
  // `resolveAppPath` routing in both the `migrations` op and `applyMigrations`.
  const dir = await mkdtemp(join(tmpdir(), "urban-dataops-abs-"));
  try {
    const absMigrations = join(dir, "db", "migrations");
    await mkdir(absMigrations, { recursive: true });
    await writeFile(
      join(dir, "nano.app.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "shop",
        name: "Shop",
        data: {
          default: "app",
          sources: {
            app: { driver: "sqlite", url: "file:./db/app.db", migrations: absMigrations },
          },
        },
      }),
    );
    await writeFile(
      join(absMigrations, "001_orders.sql"),
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL);",
    );

    const before = await run(dir, { op: "migrations" });
    assert.equal(before.dir, absMigrations);
    const beforeEntries = expectRecords(before.entries);
    assert.deepEqual(
      beforeEntries.map((e) => [e.name, e.applied]),
      [["001_orders.sql", false]],
    );

    const migrated = await run(dir, { op: "migrate" });
    assert.deepEqual(migrated, { applied: ["001_orders.sql"], pending: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exec then query round-trips rows with JSON-safe values", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await run(dir, { op: "migrate" });
    const ins = await run(dir, {
      op: "exec",
      sql: "INSERT INTO orders (id, total) VALUES (?, ?)",
      params: [1, 4200],
    });
    assert.equal(ins.changed, 1);
    assert.equal(ins.lastInsertId, 1);

    const q = await run(dir, { op: "query", sql: "SELECT id, total FROM orders" });
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
    const after = await run(dir, { op: "query", sql: "SELECT total FROM orders WHERE id = 1" });
    assert.equal(expectRecords(after.rows)[0].total, 10, "the first UPDATE was rolled back");

    // A valid multi-statement script commits and reports the changed-row count.
    const ok = await run(dir, {
      op: "script",
      statements: ["UPDATE orders SET total = 20 WHERE id = 1"],
    });
    assert.equal(ok.changed, 1);
  } finally {
    await cleanup();
  }
});

test("opening a read op does not apply migrations (schema stays empty until migrate)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // `schema`/`query` must not silently migrate — the DB manager opens the panel read-only.
    assert.deepEqual(await run(dir, { op: "schema" }), { tables: [] });
    const mig = await run(dir, { op: "migrations" });
    assert.ok(expectRecords(mig.entries).every((e) => !e.applied), "listing migrations did not apply them");
  } finally {
    await cleanup();
  }
});

test("listing migrations is side-effect-free (does not create the ledger table)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // Listing must not mutate the schema — the ledger table stays absent until `migrate`.
    await run(dir, { op: "migrations" });
    const ledger = await run(dir, {
      op: "query",
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='_urban_migrations'",
    });
    assert.deepEqual(ledger.rows, [], "listing migrations must not create the ledger table");
  } finally {
    await cleanup();
  }
});

test("migrations treats a missing migrations dir as an empty list", async () => {
  const { dir, cleanup } = await fixture();
  try {
    await rm(join(dir, "db", "migrations"), { recursive: true, force: true });
    const mig = await run(dir, { op: "migrations" });
    assert.equal(mig.dir, "db/migrations");
    assert.deepEqual(mig.entries, [], "a missing dir lists no migrations instead of throwing");
  } finally {
    await cleanup();
  }
});

test("an unknown op and an unknown source error", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // "nope" is deliberately not a member of DataOp — parse past the compile-time union to
    // exercise runDataOp's runtime `default` guard against unknown ops reaching it (e.g. a
    // hand-rolled JSON request off the wire).
    const badRequest: Parameters<typeof runDataOp>[3] = JSON.parse('{"op":"nope"}');
    await assert.rejects(run(dir, badRequest), /unknown op/);
    await assert.rejects(run(dir, { op: "schema", source: "ghost" }), /no such data source/);
  } finally {
    await cleanup();
  }
});

test("an invalid manifest fails with ManifestValidationError (consistent with the app runtime)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-dataops-bad-"));
  try {
    // A source declared without a url: valid JSON, but the runtime binding rule rejects it —
    // just as createUrbanApp/runFromEnv would, rather than failing confusingly downstream.
    await writeFile(
      join(dir, "nano.app.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "shop",
        name: "Shop",
        data: { default: "app", sources: { app: { driver: "sqlite" } } },
      }),
    );
    await assert.rejects(run(dir, { op: "sources" }), /Invalid Urban manifest[\s\S]*data\.sources\.app\.url/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing source open names which datasource failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-dataops-openfail-"));
  try {
    // url points into a directory that does not exist: openSqliteSource fails fast, and
    // openGateway prefixes the datasource name so the error is actionable (like provisionSqlite).
    await writeFile(
      join(dir, "nano.app.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "shop",
        name: "Shop",
        data: { default: "app", sources: { app: { driver: "sqlite", url: "file:./nope/app.db" } } },
      }),
    );
    await assert.rejects(run(dir, { op: "schema" }), /datasource "app":/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absolute --manifest path is honoured as-is (not re-prefixed with root)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    // root is irrelevant when the manifest path is absolute — it must not be prefixed onto it.
    const r = await runDataOp(
      createNodeHost({ cwd: dir }),
      "/some/unrelated/root",
      join(dir, "nano.app.json"),
      { op: "sources" },
    );
    assert.equal(r.default, "app");
    assert.deepEqual(expectRecords(r.sources).map((s) => s.name), ["app"]);
  } finally {
    await cleanup();
  }
});

// --- domaintypes: live-schema reification + shape fuse (ADR 0029 §4/§6, ADR 0040 §9/§10) ---
//
// The op ported off the console's vendored data_cli (host dry-out nano-bpm#576). It migrates each
// sqlite source (write mode only), introspects the live schema, folds the manifest `types` + the
// model's composed shapes through the fuse, and RETURNS every artifact's content (the read-only
// host never writes files — the caller persists). These lock that contract.

test("domaintypes migrates, introspects the live schema, and returns every artifact", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = await run(dir, { op: "domaintypes" });
    // Both migrations ran on the shared `_urban_migrations` ledger before introspection.
    assert.deepEqual(r.migrated, { app: ["001_orders.sql", "002_customers.sql"] });
    // Two tables reified from the live schema.
    assert.equal(r.tables, 2);
    // The domain `.d.ts` carries an interface per live table.
    assert.equal(typeof r.text, "string");
    assert.match(expectString(r.text), /export interface Orders\b/);
    assert.match(expectString(r.text), /export interface Customers\b/);
    // Persisting: every `*Path` is the app-relative nano-generated target.
    assert.equal(r.path, "nano-generated/domain-rows.d.ts");
    assert.equal(r.bindingsPath, "nano-generated/domain.ts");
    assert.equal(r.workerBindingsPath, "nano-generated/worker-io.d.ts");
    assert.equal(r.workerRuntimePath, "nano-generated/workers.ts");
    assert.equal(r.messageBindingsPath, "nano-generated/message-io.d.ts");
    assert.equal(r.messageRuntimePath, "nano-generated/messages.ts");
    assert.equal(r.metaPath, "nano-generated/meta.ts");
    assert.equal(r.domainModelPath, "nano-generated/domain.json");
    // The Fused Domain Model is emitted and lists both live tables.
    assert.equal(typeof r.domainModel, "string");
    const model = JSON.parse(expectString(r.domainModel));
    assert.deepEqual(
      model.entities.map((e: { id: string }) => e.id).sort(),
      ["app.customers", "app.orders"],
    );
    // The static runtime wrappers are returned verbatim for the caller to write.
    assert.equal(typeof r.workerRuntime, "string");
    assert.equal(typeof r.messageRuntime, "string");
    assert.deepEqual(r.shapeDiagnostics, []);
  } finally {
    await cleanup();
  }
});

test("domaintypes write:false is a side-effect-free preview (no migrate, null paths)", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = await run(dir, { op: "domaintypes", write: false });
    // The preview never migrates — nothing applied, DB stays fresh.
    assert.deepEqual(r.migrated, {});
    // …and because this fixture's DB is fresh (unmigrated), introspecting the *current* live schema
    // finds no tables. (An existing DB could legitimately report tables here; this count is scoped
    // to the fresh fixture, not a general preview guarantee.)
    assert.equal(r.tables, 0);
    // Content is still returned (the composer preview needs `text`)…
    assert.equal(typeof r.text, "string");
    // …but every persistence target is null and the largest artifact is skipped.
    assert.equal(r.path, null);
    assert.equal(r.bindingsPath, null);
    assert.equal(r.workerBindingsPath, null);
    assert.equal(r.workerRuntimePath, null);
    assert.equal(r.messageBindingsPath, null);
    assert.equal(r.messageRuntimePath, null);
    assert.equal(r.metaPath, null);
    assert.equal(r.domainModelPath, null);
    assert.equal(r.domainModel, null);
    // A second preview did not leave a migrated DB behind for the next write.
    const applied = await run(dir, { op: "migrations" });
    assert.ok(expectRecords(applied.entries).every((e) => e.applied === false));
  } finally {
    await cleanup();
  }
});

test("domaintypes folds a composed shape into DomainTypes and reports its diagnostics", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = await run(dir, {
      op: "domaintypes",
      derivedShapes: [
        {
          id: "ReviewRound",
          ops: [
            { op: "extend", name: "prUrl", type: "string" },
            { op: "extend", name: "approved", type: "boolean" },
          ],
        },
        // A broken shape: unresolved extend type → error diagnostic, omitted from the emit.
        { id: "Broken", ops: [{ op: "extend", name: "ref", type: "NoSuchType" }] },
      ],
    });
    // The good shape reifies into the `DomainTypes` registry surfaced by the domain `.d.ts`.
    assert.match(expectString(r.text), /ReviewRound/);
    assert.doesNotMatch(expectString(r.text), /Broken/);
    // The broken shape's diagnostic is returned so the panel can surface it.
    const diags = expectRecords(r.shapeDiagnostics);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].shape, "Broken");
    assert.equal(diags[0].severity, "error");
  } finally {
    await cleanup();
  }
});

test("domaintypes emits worker/message bindings from the injected model IO maps", async () => {
  const { dir, cleanup } = await fixture();
  try {
    const r = await run(dir, {
      op: "domaintypes",
      derivedShapes: [
        { id: "Order", ops: [{ op: "extend", name: "total", type: "integer" }] },
      ],
      derivedWorkers: [
        { taskType: "review", inputType: "Order", outputType: "Order", headerKeys: ["priority"] },
      ],
      derivedMessages: [{ messageName: "approved", inputType: "Order" }],
    });
    // The worker binding names the task type and threads the declared header key.
    assert.match(expectString(r.workerBindings), /review/);
    assert.match(expectString(r.workerBindings), /priority/);
    // The message binding names the message.
    assert.match(expectString(r.messageBindings), /approved/);
  } finally {
    await cleanup();
  }
});
