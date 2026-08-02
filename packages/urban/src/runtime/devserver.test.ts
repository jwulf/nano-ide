import { test } from "node:test";
import assert from "node:assert/strict";
import { runDev, shouldReload, type DevDeps } from "./devserver.ts";
import type { HostContext } from "./core/host.ts";
import type { UrbanApp } from "./core/runtime.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("shouldReload triggers on source files and the manifest", () => {
  for (const p of [
    "nano.app.json",
    "processes/greet.bpmn",
    "decisions/route.dmn",
    "forms/greet.form",
    "workers/greet.ts",
    "workers/greet.js",
    "db/migrations/001_init.sql",
    "./processes/greet.bpmn",
  ]) {
    assert.equal(shouldReload(p), true, `expected reload for ${p}`);
  }
});

test("shouldReload ignores generated output, deps, VCS and db churn", () => {
  for (const p of [
    "nano-generated/greeting.schema.sql",
    "nano-generated/urban-workers.d.ts",
    "node_modules/left-pad/index.js",
    ".git/index",
    "dist/index.js",
    "db/app.db",
    "db/app.db-wal",
    "db/app.db-shm",
    "db/app.sqlite-journal",
    "README.md",
    "notes.txt",
    "",
  ]) {
    assert.equal(shouldReload(p), false, `expected no reload for ${p}`);
  }
});

// A minimal fake host: runDev only calls host.watch on it.
function fakeHost(): { host: HostContext; fire: (p: string) => void; closed: () => boolean } {
  let cb: ((p: string) => void) | undefined;
  let closed = false;
  const host = {
    watch(onChange: (p: string) => void) {
      cb = onChange;
      return { close: () => (closed = true) };
    },
  } as unknown as HostContext;
  return { host, fire: (p) => cb?.(p), closed: () => closed };
}

function fakeApp(stops: string[], id: string): UrbanApp {
  return {
    manifest: { id } as UrbanApp["manifest"],
    root: ".",
    async start() {},
    async stop() {
      stops.push(id);
    },
    inspect: () => ({ app: id }),
    data: undefined,
    security: undefined,
    httpPort: undefined,
  };
}

test("runDev derives + starts once, then hot-reloads on a relevant change", async () => {
  const gens: string[] = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const nonces: string[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  let clock = 1000;

  const deps: DevDeps = {
    makeHost: (nonce) => {
      nonces.push(nonce);
      const h = fakeHost();
      hosts.push(h);
      return h.host;
    },
    startApp: async (_host) => {
      const id = `app#${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async (root, mf) => {
      gens.push(`${root}:${mf}`);
      return { count: 2 };
    },
    now: () => clock++,
  };

  const logs: string[] = [];
  const dev = await runDev(
    { root: ".", manifestPath: "nano.app.json", debounceMs: 5, log: (m) => logs.push(m) },
    deps,
  );

  assert.deepEqual(gens, [".:nano.app.json"], "gen ran once at boot");
  assert.deepEqual(starts, ["app#0"], "app started once at boot");
  assert.equal(stops.length, 0, "nothing stopped yet");

  // runDev registers the watcher on the boot host only; fire through it.
  const bootWatch = hosts[0];

  // An irrelevant change (the sqlite db) must NOT reload.
  bootWatch.fire("db/app.db");
  await delay(20);
  assert.equal(starts.length, 1, "db churn did not reload");

  // A relevant change reloads: stop old, regen, start new with a fresh nonce.
  bootWatch.fire("processes/greet.bpmn");
  await delay(20);
  assert.deepEqual(stops, ["app#0"], "old app stopped");
  assert.equal(gens.length, 2, "gen reran on reload");
  assert.deepEqual(starts, ["app#0", "app#1"], "new app started");
  assert.notEqual(nonces[0], nonces[1], "import nonce changed across reload");

  await dev.stop();
  assert.equal(bootWatch.closed(), true, "watcher closed on stop");
  assert.deepEqual(stops, ["app#0", "app#1"], "current app stopped on shutdown");
});

test("runDev coalesces a burst of changes into a single reload (debounce)", async () => {
  const starts: string[] = [];
  const stops: string[] = [];
  let clock = 1;
  let watch!: ReturnType<typeof fakeHost>;

  const deps: DevDeps = {
    makeHost: () => ((watch = fakeHost()), watch.host),
    startApp: async () => {
      const id = `a${starts.length}`;
      starts.push(id);
      return fakeApp(stops, id);
    },
    regenerate: async () => ({ count: 0 }),
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 15, log: () => {} }, deps);
  for (const p of ["workers/a.ts", "workers/b.ts", "forms/c.form"]) watch.fire(p);
  await delay(40);
  assert.equal(starts.length, 2, "three rapid edits produced exactly one reload");
  await dev.stop();
});

test("runDev survives a failing reload and keeps the previous app running", async () => {
  const stops: string[] = [];
  let boom = false;
  let clock = 1;
  let watch!: ReturnType<typeof fakeHost>;
  const logs: string[] = [];

  const deps: DevDeps = {
    makeHost: () => ((watch = fakeHost()), watch.host),
    startApp: async () => fakeApp(stops, "app"),
    regenerate: async () => {
      if (boom) throw new Error("bad manifest");
      return { count: 1 };
    },
    now: () => clock++,
  };

  const dev = await runDev({ debounceMs: 5, log: (m) => logs.push(m) }, deps);
  boom = true;
  watch.fire("nano.app.json");
  await delay(20);
  assert.ok(
    logs.some((l) => l.includes("reload failed")),
    "a failed reload is reported, not thrown",
  );
  await dev.stop();
});
