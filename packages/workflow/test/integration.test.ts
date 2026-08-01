// Integration tests against a DEDICATED gateway (own data dir + free port). They
// skip themselves when no gateway binary is available, so unit-only CI stays
// green; run them locally with a built server (or SERVER_BIN=/path).
//
// Covers the two productised guarantees:
//   1. imperative (Strategy B) crash-resume: engine SIGKILL mid-workflow →
//      restart → recorded steps replayed (no side effect), frontier runs once.
//   2. declarative (Strategy A) human-in-the-loop: park at a signal, resume via
//      a correlated message, complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineWorkflow, defineFlow, WorkflowClient, Worker } from "../dist/index.js";
import { Gateway, resolveServerBin, sleep, waitFor } from "./server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const hasBin = resolveServerBin();
const skip = hasBin ? false : "no gateway binary built (set SERVER_BIN or `make debug`)";

test("imperative workflow survives an engine crash and resumes without duplicate side effects", { skip }, async () => {
  const scratch = join(HERE, ".it", "imperative");
  const gw = await Gateway.create(scratch);
  await gw.start();

  const sideEffects: string[] = [];
  const committed = new Set<string>();
  const wf = defineWorkflow("durable-imperative", async (ctx) => {
    const a = await ctx.run("stepA", () => {
      sideEffects.push("stepA");
      return { n: 1 };
    });
    const b = await ctx.run("stepB", () => {
      sideEffects.push("stepB");
      return { n: (a as { n: number }).n + 1 };
    });
    if ((b as { n: number }).n === 2) {
      await ctx.run("stepC", () => {
        sideEffects.push("stepC");
        return { n: 3 };
      });
    }
  });

  // Crash-resilience is a REST-transport guarantee today: REST long-poll
  // reconnects with backoff after the engine restarts. The Falcon push
  // transport does not yet recover a mid-stream disconnect (unhandled reconnect
  // rejection + no retry loop) — tracked by jwulf/nano-sdk-js#3 — so this test
  // pins the client to REST. The Worker already defaults to REST.
  const client = new WorkflowClient({ baseUrl: gw.baseUrl, transport: "rest" });
  const worker = new Worker({
    baseUrl: gw.baseUrl,
    workflows: [wf],
    pollTimeoutMs: 1500,
    onActivity: async (e) => {
      if (e.step) committed.add(e.step);
      // Hold after B's journal commit so we can SIGKILL before C's turn.
      if (e.step === "2:stepB") await sleep(4000);
    },
    onError: () => {},
  });

  try {
    await client.deploy(wf);
    await client.start(wf, { requestedBy: "integration" });
    worker.start();

    await waitFor(() => committed.has("1:stepA"), "A journalled", 15000);
    await waitFor(() => committed.has("2:stepB"), "B journalled", 15000);

    gw.kill();
    await sleep(1000);
    await gw.start(); // restart against the SAME data dir → journal replay

    await waitFor(() => committed.has("__done"), "workflow completed after restart", 30000);
    await sleep(300);

    const counts = { stepA: 0, stepB: 0, stepC: 0 };
    for (const s of sideEffects) counts[s as keyof typeof counts] += 1;
    assert.deepEqual(counts, { stepA: 1, stepB: 1, stepC: 1 }, `each side effect exactly once (got ${JSON.stringify(sideEffects)})`);
  } finally {
    await worker.stop();
    await gw.stop();
  }
});

test("declarative flow parks at a signal and resumes via a correlated message", { skip }, async () => {
  const scratch = join(HERE, ".it", "declarative");
  const gw = await Gateway.create(scratch);
  await gw.start();

  const committed = new Set<string>();
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async (job) => ({ diff: `diff-${job.variables.prId}` }));
    w.signal("humanApproval", { correlationKey: "prId" });
    w.run("finalize", async (job) => ({ approvedBy: job.variables.approvedBy ?? "system" }));
  });

  // Pin to REST for a deterministic teardown (the gateway is stopped in the
  // finally block; a Falcon WS would background-reconnect and keep the loop
  // alive). Falcon's happy-path create is covered by nano-sdk's own tests.
  const client = new WorkflowClient({ baseUrl: gw.baseUrl, transport: "rest" });
  const worker = new Worker({
    baseUrl: gw.baseUrl,
    workflows: [flow],
    pollTimeoutMs: 1500,
    onActivity: (e) => {
      committed.add(e.elementId);
    },
    onError: () => {},
  });

  try {
    await client.deploy(flow);
    const inst = await client.start(flow, { prId: "PR-1" });
    worker.start();

    await waitFor(() => committed.has("fetchDiff"), "fetchDiff ran", 15000);
    // The instance is now parked at humanApproval. Send the approval signal.
    await sleep(500);
    await client.signal(flow, "humanApproval", "PR-1", { approvedBy: "alice" });

    await waitFor(() => committed.has("finalize"), "finalize ran after signal", 15000);
    await sleep(300);

    const final = await client.getInstance(String(inst.processInstanceKey));
    assert.ok(final, "getInstance should return the completed instance (not null)");
    const state = (final?.state ?? (final as { processInstance?: { state?: string } })?.processInstance?.state) as string | undefined;
    assert.ok(state === "COMPLETED" || state === undefined, `instance should complete (state=${state})`);
  } finally {
    await worker.stop();
    await gw.stop();
  }
});
