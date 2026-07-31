import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../adapters/node.ts";
import { createUrbanApp, resolvePort } from "./runtime.ts";
import { runFromEnv } from "../run.ts";
import type {
  EngineClient,
  EngineJob,
  JobHandler,
  WorkerSubscription,
} from "./host.ts";

// A fake engine: records everything and lets the test deliver a job to a registered worker.
class FakeEngine implements EngineClient {
  deployed = 0;
  workers = new Map<string, JobHandler>();
  messages: { name: string; correlationKey?: string; variables?: Record<string, unknown> }[] = [];
  completedTasks: { key: string; variables?: Record<string, unknown> }[] = [];
  userTasks = [{ userTaskKey: "ut-1", elementId: "approve", variables: {} }];

  async deployResources(r: { name: string }[]) {
    this.deployed += r.length;
    return { deployed: r.length };
  }
  async createInstance() {
    return { processInstanceKey: "pi-1" };
  }
  async publishMessage(input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }) {
    this.messages.push(input);
  }
  async searchUserTasks() {
    return this.userTasks;
  }
  async completeUserTask(key: string, variables?: Record<string, unknown>) {
    this.completedTasks.push({ key, variables });
  }
  async registerWorker(jobType: string, handler: JobHandler): Promise<WorkerSubscription> {
    this.workers.set(jobType, handler);
    return { jobType, unsubscribe: async () => void this.workers.delete(jobType) };
  }
  async close() {}
  // test helper
  async deliver(jobType: string, job: EngineJob) {
    const h = this.workers.get(jobType);
    if (!h) throw new Error(`no worker for ${jobType}`);
    return h(job);
  }
}

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-rt-"));
  await mkdir(join(dir, "processes"));
  await mkdir(join(dir, "decisions"));
  await mkdir(join(dir, "forms"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await mkdir(join(dir, "workers"));
  await writeFile(join(dir, "processes", "p.bpmn"), "<definitions/>");
  await writeFile(join(dir, "decisions", "d.dmn"), "<definitions/>");
  await writeFile(join(dir, "forms", "f.form"), "{}");
  await writeFile(
    join(dir, "db", "migrations", "001_init.sql"),
    "CREATE TABLE crew_tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT);",
  );
  await writeFile(
    join(dir, "workers", "handlers.ts"),
    `export const handlers = {
      "wf.claim": async (job, app) => {
        app.data.repo("task").insert({ title: job.variables.title, status: "claimed" });
        return { claimed: true };
      },
    };`,
  );
  const manifest = {
    schemaVersion: 1,
    id: "fixture-app",
    name: "Fixture App",
    models: { processes: ["processes/*.bpmn"], decisions: ["decisions/*.dmn"], forms: ["forms/*.form"] },
    data: { default: "app", sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } } },
    types: { task: { table: "crew_tasks", fields: { title: { type: "string" }, status: { type: "string" } } } },
    workers: [{ taskType: "wf.claim", handler: "workers/handlers.ts" }],
    triggers: [{ id: "hook", type: "webhook", path: "/hooks/task", action: { message: "wf.requested", correlationKey: "= body.taskId" } }],
    surfaces: { taskInbox: { enabled: true, path: "/tasks" } },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("runtime materializes the manifest end-to-end against a fake engine", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();

  try {
    // deploy
    assert.equal(engine.deployed, 3, "3 model files deployed");

    // migrations applied
    const insp = app.inspect() as Record<string, any>;
    assert.deepEqual(insp.data.sources[0].migrations, 1);

    // workers registered + data injected: deliver a job and see a DB row
    await engine.deliver("wf.claim", {
      jobKey: "j1",
      jobType: "wf.claim",
      variables: { title: "Fix bug" },
    });
    const rows = app.data!.repo("task").all<{ title: string; status: string }>();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Fix bug");
    assert.equal(rows[0].status, "claimed");

    // HTTP surfaces + triggers on the real node server
    const port = app.httpPort!;
    assert.ok(port > 0);

    const tasksRes = await fetch(`http://localhost:${port}/tasks/api/tasks`);
    assert.equal(tasksRes.status, 200);
    assert.equal((await tasksRes.json() as unknown[]).length, 1);

    const hookRes = await fetch(`http://localhost:${port}/hooks/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "T-9", title: "from webhook" }),
    });
    assert.equal(hookRes.status, 200);
    assert.equal(engine.messages.length, 1);
    assert.equal(engine.messages[0].name, "wf.requested");
    assert.equal(engine.messages[0].correlationKey, "T-9");

    // complete a user task through the surface API
    const done = await fetch(`http://localhost:${port}/tasks/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userTaskKey: "ut-1", variables: { approved: true } }),
    });
    assert.equal(done.status, 200);
    assert.equal(engine.completedTasks.length, 1);
    assert.equal(engine.completedTasks[0].key, "ut-1");

    // healthz
    const health = await fetch(`http://localhost:${port}/healthz`);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    // field-drift guard
    assert.throws(() => app.data!.repo("task").insert({ bogus: 1 }));
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop() resets state so the app can be cleanly restarted", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });

  try {
    await app.start();
    const firstPort = app.httpPort!;
    assert.ok(firstPort > 0);
    await app.stop();

    // after stop, inspect() no longer carries stale describe data / port
    const stopped = app.inspect() as Record<string, unknown>;
    assert.equal(stopped.httpPort, undefined);
    assert.equal(stopped.workers, undefined);

    // and a fresh start works (would throw "already started" if state leaked)
    await app.start();
    assert.ok(app.httpPort! > 0);
    // deploy ran again on the clean start, not doubled from the first run
    assert.equal(engine.deployed, 6);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task-inbox /api/complete returns 400 on a malformed JSON body", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();
  try {
    const res = await fetch(`http://localhost:${app.httpPort!}/tasks/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(engine.completedTasks.length, 0);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvePort prefers explicit, then $PORT, then 8090; rejects bad $PORT", () => {
  assert.equal(resolvePort(3000, "9999"), 3000);
  assert.equal(resolvePort(undefined, "9999"), 9999);
  assert.equal(resolvePort(undefined, undefined), 8090);
  assert.equal(resolvePort(undefined, ""), 8090);
  assert.throws(() => resolvePort(undefined, "abc"), /invalid PORT/);
  assert.throws(() => resolvePort(undefined, "70000"), /invalid PORT/);
});

test("runFromEnv anchors the host at a non-'.' root without double-prefixing paths", async () => {
  const dir = await makeFixture();
  const engine = new FakeEngine();
  // No host passed → runFromEnv selects a host anchored at `dir`. The regression
  // guarded here: it must NOT also prefix `dir` inside createUrbanApp (which
  // would look for "<dir>/<dir>/nano.app.json" and fail).
  const app = await runFromEnv({ root: dir, engine, port: 0, handleSignals: false });
  try {
    assert.equal(app.manifest.id, "fixture-app");
    assert.equal(engine.deployed, 3, "models deployed from the correct root");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
