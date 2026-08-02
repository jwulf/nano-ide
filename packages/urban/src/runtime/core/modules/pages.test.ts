import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineClient, HttpRequest, HttpResponse } from "../host.ts";
import { makeRouter } from "../router.ts";
import { createPagesRoutes, type PagesDataSource } from "./pages.ts";

function req(
  method: string,
  path: string,
  opts: { query?: string; body?: unknown } = {},
): HttpRequest {
  const bodyText = opts.body === undefined ? "" : JSON.stringify(opts.body);
  return {
    method,
    path,
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
    text: () => Promise.resolve(bodyText),
  };
}

interface FakeEngineCalls {
  created: { processDefinitionId: string; variables?: Record<string, unknown> }[];
  canceled: string[];
  messages: { name: string; correlationKey?: string; variables?: Record<string, unknown> }[];
}

function fakeEngine(): { engine: EngineClient; calls: FakeEngineCalls } {
  const calls: FakeEngineCalls = { created: [], canceled: [], messages: [] };
  const engine = {
    async createInstance(input: { processDefinitionId: string; variables?: Record<string, unknown> }) {
      calls.created.push(input);
      return { processInstanceKey: "pi-42" };
    },
    async cancelInstance(input: { processInstanceKey: string }) {
      calls.canceled.push(input.processInstanceKey);
    },
    async publishMessage(input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }) {
      calls.messages.push(input);
    },
  } as unknown as EngineClient;
  return { engine, calls };
}

function fakeDb(overrides: Partial<PagesDataSource> = {}): PagesDataSource {
  return {
    schema: async () => [{ name: "orders" }],
    query: async (sql: string) => {
      if (/PRAGMA table_info/i.test(sql)) {
        return [{ name: "id" }, { name: "status" }, { name: "total" }];
      }
      return [{ id: 1, status: "new", total: 10 }];
    },
    ...overrides,
  };
}

function build(dbOverrides: Partial<PagesDataSource> = {}) {
  const { engine, calls } = fakeEngine();
  const db = fakeDb(dbOverrides);
  const readPage = async (path: string) => {
    if (path === "pages/home.page.json") return JSON.stringify({ title: "Home", nodes: [] });
    throw new Error("not found");
  };
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db,
    engine,
    readPage,
  });
  const router = makeRouter(routes);
  return { router, calls };
}

async function dispatch(method: string, path: string, opts?: { query?: string; body?: unknown }): Promise<HttpResponse> {
  const { router } = build();
  return router(req(method, path, opts));
}

test("GET / serves the renderer shell with the home marker", async () => {
  const res = await dispatch("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /text\/html/);
  assert.match(res.body ?? "", /data-home="home"/);
});

test("GET /app/runtime.js serves the renderer module", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  assert.match(res.headers?.["content-type"] ?? "", /javascript/);
  assert.match(res.body ?? "", /pc:refresh/);
});

test("GET /app/pages/<id> returns the page json, 404 for unknown", async () => {
  const ok = await dispatch("GET", "/app/pages/home");
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body ?? "{}").title, "Home");
  const miss = await dispatch("GET", "/app/pages/nope");
  assert.equal(miss.status, 404);
});

test("GET /app/data/<source>/<table> returns rows", async () => {
  const res = await dispatch("GET", "/app/data/app/orders");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body ?? "{}");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].status, "new");
});

test("GET /app/data rejects unknown source, invalid + unknown table", async () => {
  assert.equal((await dispatch("GET", "/app/data/other/orders")).status, 404);
  const { router } = build();
  const unknownTable = await router(req("GET", "/app/data/app/customers"));
  assert.equal(unknownTable.status, 404);
});

test("GET /app/data whitelists filter columns", async () => {
  const { router } = build();
  const good = await router(req("GET", "/app/data/app/orders", { query: "where=status:new" }));
  assert.equal(good.status, 200);
  const bad = await router(req("GET", "/app/data/app/orders", { query: "where=evil:1" }));
  assert.equal(bad.status, 400);
});

test("POST /app/actions/start/<process> creates an instance", async () => {
  const { router, calls } = build();
  const res = await router(req("POST", "/app/actions/start/my-proc", { body: { variables: { a: 1 } } }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body ?? "{}").processInstanceKey, "pi-42");
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].processDefinitionId, "my-proc");
  assert.deepEqual(calls.created[0].variables, { a: 1 });
});

test("POST /app/actions/cancel cancels, 400 without a key", async () => {
  const { router, calls } = build();
  const ok = await router(req("POST", "/app/actions/cancel", { body: { processInstanceKey: "pi-9" } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.canceled, ["pi-9"]);
  const bad = await router(req("POST", "/app/actions/cancel", { body: {} }));
  assert.equal(bad.status, 400);
});

test("POST /app/actions/message publishes, 400 on missing fields", async () => {
  const { router, calls } = build();
  const ok = await router(req("POST", "/app/actions/message", {
    body: { name: "answered", correlationKey: "k1", variables: { answer: "yes" } },
  }));
  assert.equal(ok.status, 200);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].name, "answered");
  const noName = await router(req("POST", "/app/actions/message", { body: { correlationKey: "k" } }));
  assert.equal(noName.status, 400);
  const noKey = await router(req("POST", "/app/actions/message", { body: { name: "m" } }));
  assert.equal(noKey.status, 400);
});

test("GET /app/data quotes table/column identifiers in the emitted SQL", async () => {
  const seen: string[] = [];
  const db = fakeDb({
    query: async (sql: string) => {
      seen.push(sql);
      if (/PRAGMA table_info/i.test(sql)) {
        return [{ name: "id" }, { name: "status" }, { name: "total" }];
      }
      return [{ id: 1 }];
    },
  });
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db,
    engine: fakeEngine().engine,
    readPage: async () => "{}",
  });
  const router = makeRouter(routes);
  const res = await router(req("GET", "/app/data/app/orders", {
    query: "where=status:new&order=total:desc",
  }));
  assert.equal(res.status, 200);
  const pragma = seen.find((s) => /PRAGMA table_info/i.test(s))!;
  assert.match(pragma, /table_info\("orders"\)/);
  const select = seen.find((s) => /^SELECT/.test(s))!;
  assert.match(select, /FROM "orders"/);
  assert.match(select, /WHERE "status" = \?/);
  assert.match(select, /ORDER BY "total" DESC/);
});
