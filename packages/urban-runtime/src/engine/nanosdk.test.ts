import { test } from "node:test";
import assert from "node:assert/strict";
import { createNanoSdkEngineClient } from "./nanosdk.ts";
import type { EngineClient } from "../core/host.ts";

/** A fallback that records which cold-path methods were used. */
function recordingFallback(): EngineClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async deployResources() {
      calls.push("deployResources");
      return { deployed: 0 };
    },
    async createInstance() {
      calls.push("createInstance");
      return { processInstanceKey: "REST" };
    },
    async publishMessage() {
      calls.push("publishMessage");
    },
    async searchUserTasks() {
      calls.push("searchUserTasks");
      return [];
    },
    async completeUserTask() {
      calls.push("completeUserTask");
    },
    async registerWorker(jobType: string) {
      calls.push("registerWorker");
      return { jobType, unsubscribe: async () => {} };
    },
    async close() {
      calls.push("close");
    },
  };
}

test("createInstance is routed through the nano-sdk client (Falcon hot path)", async () => {
  let sdkCreated = 0;
  const fallback = recordingFallback();
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    fallback,
    createClient: () => ({
      createProcessInstance: async (input) => {
        sdkCreated++;
        assert.equal(input.processDefinitionId, "p");
        return { processInstanceKey: 42, variables: { ok: true } };
      },
    }),
  });
  assert.ok(engine);
  const res = await engine!.createInstance({ processDefinitionId: "p", variables: { a: 1 } });
  assert.equal(sdkCreated, 1);
  assert.equal(res.processInstanceKey, "42");
  assert.deepEqual(res.variables, { ok: true });
  assert.ok(!fallback.calls.includes("createInstance"), "did not use REST for create");
});

test("cold paths delegate to the REST fallback", async () => {
  const fallback = recordingFallback();
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    fallback,
    createClient: () => ({ createProcessInstance: async () => ({ processInstanceKey: 1 }) }),
  });
  await engine!.deployResources([]);
  await engine!.publishMessage({ name: "m" });
  await engine!.searchUserTasks();
  await engine!.completeUserTask("k");
  await engine!.registerWorker("t", async () => ({}));
  assert.deepEqual(fallback.calls, [
    "deployResources",
    "publishMessage",
    "searchUserTasks",
    "completeUserTask",
    "registerWorker",
  ]);
});

test("returns null when the SDK cannot be loaded (so callers fall back to REST)", async () => {
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    createClient: () => {
      throw new Error("boom");
    },
  });
  assert.equal(engine, null);
});

test("close tears down both the SDK client and the fallback", async () => {
  const fallback = recordingFallback();
  let sdkClosed = 0;
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    fallback,
    createClient: () => ({
      createProcessInstance: async () => ({ processInstanceKey: 1 }),
      close: () => {
        sdkClosed++;
      },
    }),
  });
  await engine!.close();
  assert.equal(sdkClosed, 1);
  assert.ok(fallback.calls.includes("close"));
});

test("createInstance throws when the SDK response omits the instance key", async () => {
  const fallback = recordingFallback();
  const engine = await createNanoSdkEngineClient({
    restAddress: "http://x/v2",
    fallback,
    createClient: () => ({
      createProcessInstance: async () => ({ variables: { ok: true } }) as unknown as { processInstanceKey: number },
    }),
  });
  assert.ok(engine);
  await assert.rejects(
    () => engine!.createInstance({ processDefinitionId: "p" }),
    /missing processInstanceKey/,
  );
});
