// Code-first DECLARATIVE durable workflow on Nano (ADR 0044/0045). A declarative
// flow adds a durable human-in-the-loop `signal` step over the imperative
// surface: the instance parks at `humanApproval` until a correlated message
// arrives. @nanobpm/workflow derives the executable BPMN model, the job types,
// and the message/correlation wiring; a generic Worker hosts the `run` steps.
import { WorkflowClient, Worker } from "@nanobpm/workflow";
import { prReviewFlow } from "./workflows/pr-review-flow.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const prId = "PR-1234";

const client = new WorkflowClient({ baseUrl });
await client.deploy(prReviewFlow);
console.log(`deployed ${prReviewFlow.id}`);

// Track completed steps so the demo knows when the flow has parked at the signal
// and when it finally completes. A production worker host keeps the worker
// running forever and sends the signal from wherever the human decision arrives
// (an HTTP handler, a chat command, a review UI) — not on a scripted timeline.
const done = new Set<string>();
const worker = new Worker({
  baseUrl,
  workflows: [prReviewFlow],
  onActivity: (e) => {
    done.add(e.elementId);
    console.log(`  · ${prReviewFlow.id}: ${e.elementId}`);
  },
  onError: (err) => console.error("worker error:", err.message),
});
worker.start();

const { processInstanceKey } = await client.start(prReviewFlow, { prId });
console.log(`started ${prReviewFlow.id} instance ${processInstanceKey} (prId=${prId})`);

// Demo-only: wait until autoReview has run so the instance is parked at the
// `humanApproval` signal, then send the (correlated) approval message.
await waitFor(() => done.has("autoReview"), "autoReview to complete", 15000);
console.log("parked at humanApproval — sending approval signal");
await client.signal(prReviewFlow, "humanApproval", prId, { approvedBy: "alice" });

await waitFor(() => done.has("merge"), "merge to complete", 15000);
console.log("workflow complete \u2714");
await worker.stop();

/** Poll `pred` until true or the timeout elapses. */
function waitFor(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}
