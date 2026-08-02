import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineJob, JobHandler, WorkerSubscription } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { mountWorkers, sdkDecisionEvaluator } from "./workers.ts";

/** A tiny engine that records registrations and can deliver a job to a handler. */
class MiniEngine {
  workers = new Map<string, JobHandler>();
  async registerWorker(jobType: string, handler: JobHandler): Promise<WorkerSubscription> {
    this.workers.set(jobType, handler);
    return { jobType, unsubscribe: async () => void this.workers.delete(jobType) };
  }
  deliver(jobType: string, job: EngineJob) {
    const h = this.workers.get(jobType);
    if (!h) throw new Error(`no worker for ${jobType}`);
    return h(job);
  }
}

function makeCtx(
  manifest: Partial<AppManifest>,
  engine: MiniEngine,
): { ctx: RuntimeContext; logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = [];
  const ctx = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", ...manifest } as AppManifest,
    engine: engine as unknown as RuntimeContext["engine"],
    host: {
      log: (level: string, msg: string) => logs.push({ level, msg }),
      importModule: () => Promise.reject(new Error("no modules in this test")),
    },
  } as unknown as RuntimeContext;
  return { ctx, logs };
}

function makeApp(over: Partial<AppApi> = {}): AppApi {
  return {
    env: (n) => ({ NANO_APP_LLM_MODEL: "m" } as Record<string, string>)[n],
    log: () => {},
    ...over,
  } as AppApi;
}

function fakeFetch(content: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  })) as unknown as typeof fetch;
}

const orig = globalThis.fetch;
function withFetch(content: string, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = fakeFetch(content);
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("mountWorkers registers an llm-bound worker and runs the job through the model", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx(
    {
      workers: [{ taskType: "classify", llm: "classifier" }],
      llm: { classifier: { provider: "env", model: "" } },
    },
    engine,
  );
  const handle = await mountWorkers(ctx, makeApp());
  assert.deepEqual(handle.jobTypes, ["classify"]);
  assert.ok(logs.some((l) => l.msg === "llm worker registered"));

  await withFetch("hi there", async () => {
    const out = await engine.deliver("classify", {
      jobKey: "j1",
      jobType: "classify",
      variables: { prompt: "who are you" },
    });
    assert.deepEqual(out, { text: "hi there" });
  });
  await handle.stop();
});

test("mountWorkers throws when an llm worker references an unknown binding", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx(
    { workers: [{ taskType: "classify", llm: "missing" }], llm: {} },
    engine,
  );
  await assert.rejects(mountWorkers(ctx, makeApp()), /unknown llm binding "missing"/);
});

test("mountWorkers skips (with a warning) a worker with neither handler nor llm", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx({ workers: [{ taskType: "orphan" }] }, engine);
  const handle = await mountWorkers(ctx, makeApp());
  assert.deepEqual(handle.jobTypes, []);
  assert.ok(logs.some((l) => l.level === "warn" && /neither a handler nor an llm/.test(l.msg)));
});

test("an llm worker with decision rails uses app.sdk to evaluate the decision", async () => {
  const engine = new MiniEngine();
  const evaluated: Array<{ id: string; vars: Record<string, unknown> }> = [];
  const sdk = {
    evaluateDecision: async (input: { decisionDefinitionId: string; variables: Record<string, unknown> }) => {
      evaluated.push({ id: input.decisionDefinitionId, vars: input.variables });
      return { output: JSON.stringify({ approved: true }) };
    },
  };
  const { ctx } = makeCtx(
    {
      workers: [{ taskType: "risk", llm: "risker" }],
      llm: { risker: { provider: "env", model: "", output: { decision: "risk-table" } } },
    },
    engine,
  );
  await mountWorkers(ctx, makeApp({ sdk: sdk as unknown as AppApi["sdk"] }));

  await withFetch('{"amount":100}', async () => {
    const out = await engine.deliver("risk", {
      jobKey: "j1",
      jobType: "risk",
      variables: { prompt: "score it" },
    });
    assert.deepEqual(out, { approved: true });
  });
  assert.deepEqual(evaluated, [{ id: "risk-table", vars: { amount: 100 } }]);
});

test("sdkDecisionEvaluator parses the decision's JSON-string output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: JSON.stringify({ ok: 1 }) }),
  });
  assert.deepEqual(await evaluate("d", {}), { ok: 1 });
});

test("sdkDecisionEvaluator passes through a non-string output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: { ok: 2 } }),
  });
  assert.deepEqual(await evaluate("d", {}), { ok: 2 });
});

test("sdkDecisionEvaluator throws with decision context on unparseable output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: "not json" }),
  });
  await assert.rejects(evaluate("risk", {}), /decision "risk" returned unparseable JSON/);
});

test("sdkDecisionEvaluator throws a clear error when the SDK lacks evaluateDecision", async () => {
  const evaluate = sdkDecisionEvaluator({});
  await assert.rejects(evaluate("risk", {}), /does not support evaluateDecision.*"risk"/);
});
