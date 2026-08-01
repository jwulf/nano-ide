import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNanoSdkEngineClient,
  requireProcessInstanceKey,
  SdkEngineClient,
  type NanoSdkActivatedJob,
  type NanoSdkClient,
  type NanoSdkJobWorker,
  type NanoSdkJobWorkerConfig,
} from "./nanosdk.ts";

/** A fake nano-sdk client that records calls and lets a test drive its job worker. */
function fakeSdkClient(overrides: Partial<NanoSdkClient> = {}): NanoSdkClient & {
  calls: string[];
  deployments: File[][];
  workers: {
    cfg: NanoSdkJobWorkerConfig;
    started: number;
    stopped: number;
    dispatch: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  }[];
  closed: number;
} {
  const calls: string[] = [];
  const deployments: File[][] = [];
  const workers: {
    cfg: NanoSdkJobWorkerConfig;
    started: number;
    stopped: number;
    dispatch: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  }[] = [];
  let closed = 0;

  const client: NanoSdkClient & {
    calls: string[];
    deployments: File[][];
    workers: typeof workers;
    closed: number;
  } = {
    calls,
    deployments,
    workers,
    get closed() {
      return closed;
    },
    async createDeployment(input) {
      calls.push("createDeployment");
      deployments.push(input.resources);
      return { deployments: input.resources.map((_, i) => ({ i })) };
    },
    async createProcessInstance(input) {
      calls.push("createProcessInstance");
      return { processInstanceKey: 99, variables: input.variables };
    },
    async publishMessage(input) {
      calls.push("publishMessage");
      return { key: 1, ...input };
    },
    async searchUserTasks() {
      calls.push("searchUserTasks");
      return { items: [] };
    },
    async completeUserTask() {
      calls.push("completeUserTask");
      return {};
    },
    createJobWorker(cfg) {
      calls.push("createJobWorker");
      const rec = { cfg, started: 0, stopped: 0, dispatch: cfg.jobHandler };
      workers.push(rec);
      const worker: NanoSdkJobWorker = {
        start() {
          rec.started++;
        },
        stop() {
          rec.stopped++;
        },
      };
      return worker;
    },
    close() {
      closed++;
    },
    ...overrides,
  };
  return client;
}

test("requireProcessInstanceKey coerces and rejects empties", () => {
  assert.equal(requireProcessInstanceKey(42), "42");
  assert.equal(requireProcessInstanceKey("k"), "k");
  assert.throws(() => requireProcessInstanceKey(null), /missing processInstanceKey/);
  assert.throws(() => requireProcessInstanceKey(""), /missing processInstanceKey/);
});

test("deployResources builds web Files and calls createDeployment", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const res = await engine.deployResources([
    { name: "a.bpmn", content: "<x/>", contentType: "text/xml" },
    { name: "b.form", content: "{}", contentType: "application/json" },
  ]);
  assert.deepEqual(res, { deployed: 2 });
  assert.equal(client.deployments.length, 1);
  const [f0, f1] = client.deployments[0];
  assert.ok(f0 instanceof File);
  assert.equal(f0.name, "a.bpmn");
  assert.equal(f0.type, "text/xml");
  assert.equal(await f0.text(), "<x/>");
  assert.equal(f1.name, "b.form");
});

test("createInstance routes through the SDK and coerces the key", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const res = await engine.createInstance({ processDefinitionId: "p", variables: { a: 1 } });
  assert.equal(res.processInstanceKey, "99");
  assert.deepEqual(res.variables, { a: 1 });
  assert.ok(client.calls.includes("createProcessInstance"));
});

test("createInstance throws when the SDK response omits the instance key", async () => {
  const client = fakeSdkClient({
    createProcessInstance: async () => ({ variables: { ok: true } }),
  });
  const engine = new SdkEngineClient(client);
  await assert.rejects(
    () => engine.createInstance({ processDefinitionId: "p" }),
    /missing processInstanceKey/,
  );
});

test("publishMessage defaults correlationKey/variables", async () => {
  let seen: Record<string, unknown> | undefined;
  const client = fakeSdkClient({
    publishMessage: async (input) => {
      seen = input;
      return {};
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.publishMessage({ name: "m" });
  assert.deepEqual(seen, { name: "m", correlationKey: "", variables: {} });
});

test("searchUserTasks passes zero-wait consistency and maps items", async () => {
  let consistency: unknown;
  const client = fakeSdkClient({
    searchUserTasks: async (_input, c) => {
      consistency = c;
      return {
        items: [
          { userTaskKey: 7, elementId: "task_a", variables: { x: 1 } },
          { key: "" }, // keyless → skipped
          { userTaskKey: "8" },
        ],
      };
    },
  });
  const engine = new SdkEngineClient(client);
  const tasks = await engine.searchUserTasks({ processInstanceKey: "pi" });
  assert.deepEqual(consistency, { consistency: { waitUpToMs: 0 } });
  assert.deepEqual(tasks, [
    { userTaskKey: "7", elementId: "task_a", variables: { x: 1 } },
    { userTaskKey: "8", elementId: undefined, variables: undefined },
  ]);
});

test("completeUserTask routes through the SDK", async () => {
  let seen: unknown;
  const client = fakeSdkClient({
    completeUserTask: async (input) => {
      seen = input;
      return {};
    },
  });
  const engine = new SdkEngineClient(client);
  await engine.completeUserTask("utk", { done: true });
  assert.deepEqual(seen, { userTaskKey: "utk", variables: { done: true } });
});

test("registerWorker creates a worker (autoStart false), starts it, and dispatches + completes", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  const handled: Record<string, unknown>[] = [];
  const sub = await engine.registerWorker(
    "svc",
    (job) => {
      handled.push(job.variables);
      return { out: job.variables.n };
    },
    { maxParallelJobs: 4 },
  );
  assert.equal(sub.jobType, "svc");
  const rec = client.workers[0];
  assert.equal(rec.cfg.autoStart, false);
  assert.equal(rec.cfg.workerName, "urban:svc");
  assert.equal(rec.cfg.maxParallelJobs, 4);
  assert.equal(rec.started, 1);

  let completedWith: Record<string, unknown> | undefined;
  await rec.dispatch({
    jobKey: 12,
    processInstanceKey: 34,
    elementId: "e1",
    variables: { n: 5 },
    async complete(v?: Record<string, unknown>) {
      completedWith = v;
      return "receipt";
    },
    async fail() {
      throw new Error("should not fail");
    },
  } as unknown as NanoSdkActivatedJob);
  assert.deepEqual(handled, [{ n: 5 }]);
  assert.deepEqual(completedWith, { out: 5 });

  await sub.unsubscribe();
  assert.equal(rec.stopped, 1);
});

test("registerWorker fails the job when the handler throws", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("svc", () => {
    throw new Error("boom");
  });
  const rec = client.workers[0];
  let failBody: { errorMessage: string; retries?: number } | undefined;
  await rec.dispatch({
    jobKey: "j1",
    variables: {},
    async complete() {
      throw new Error("should not complete");
    },
    async fail(body: { errorMessage: string; retries?: number }) {
      failBody = body;
      return "failed";
    },
  } as unknown as NanoSdkActivatedJob);
  assert.equal(failBody?.errorMessage, "boom");
  assert.equal(failBody?.retries, 0);
});

test("close stops every worker and closes the SDK client", async () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  await engine.registerWorker("a", async () => ({}));
  await engine.registerWorker("b", async () => ({}));
  await engine.close();
  assert.equal(client.workers[0].stopped, 1);
  assert.equal(client.workers[1].stopped, 1);
  assert.equal(client.closed, 1);
});

test("exposes the underlying nano-sdk client as .sdk", () => {
  const client = fakeSdkClient();
  const engine = new SdkEngineClient(client);
  assert.equal(engine.sdk, client, "sdk returns the exact client the adapter was built from");
});

test("createNanoSdkEngineClient uses an injected client", async () => {
  const client = fakeSdkClient();
  const engine = await createNanoSdkEngineClient({ restAddress: "http://x/v2", client });
  await engine.createInstance({ processDefinitionId: "p" });
  assert.ok(client.calls.includes("createProcessInstance"));
});

test("createNanoSdkEngineClient uses an injected client factory with the resolved transport", async () => {
  let seen: { restAddress: string; token?: string; transport?: string } | undefined;
  const client = fakeSdkClient();
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    token: "t",
    transport: "falcon",
    createClient: (o) => {
      seen = o;
      return client;
    },
  });
  assert.deepEqual(seen, { restAddress: "http://x/v2", token: "t", transport: "falcon" });
  assert.ok(engine);
});
