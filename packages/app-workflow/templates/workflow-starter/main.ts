// Code-first durable workflows on Nano (ADR 0044/0045). No diagram, no task-type
// wiring, no correlation plumbing: @nanobpm/workflow derives the executable BPMN
// model, the job types, and hosts a generic Worker.
import { WorkflowClient, Worker } from "@nanobpm/workflow";
import { prReview } from "./workflows/pr-review.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const workflows = [prReview];

const client = new WorkflowClient({ baseUrl });
for (const wf of workflows) {
  await client.deploy(wf);
  console.log(`deployed ${wf.id}`);
}

// Demo-only: resolve once the workflow reports done, so this script can exit.
let markDone: () => void;
const done = new Promise<void>((resolve) => (markDone = resolve));

const worker = new Worker({
  baseUrl,
  workflows,
  onActivity: (e) => {
    console.log(`  · ${e.workflowId}: ${e.step ?? e.elementId}`);
    if (e.step === "__done") markDone();
  },
  onError: (err) => console.error("worker error:", err.message),
});
worker.start();

const { processInstanceKey } = await client.start(prReview, { prId: "PR-1234" });
console.log(`started pr-review instance ${processInstanceKey}`);

// A production worker host removes everything below and runs forever.
await done;
console.log("workflow complete \u2714");
await worker.stop();
