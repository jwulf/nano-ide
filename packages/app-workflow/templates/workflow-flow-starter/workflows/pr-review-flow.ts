import { defineFlow } from "@nanobpm/workflow";

// A code-first DECLARATIVE durable flow: an ordered list of steps that
// @nanobpm/workflow compiles to an executable BPMN model — a service task per
// `run`, and a message intermediate-catch event per `signal`. No diagram, no
// task-type wiring, no correlation plumbing: it is all derived from this code.
//
// The declarative surface's advantage over the imperative one is `signal`: a
// durable wait for an external or human event, correlated on a process variable.
// The instance parks (durably) at the signal until a matching message arrives.
//
// Keep every `run` side effect idempotent — jobs are at-least-once, so a crash
// between the side effect and the job completion redelivers the step.
export const prReviewFlow = defineFlow("pr-review-flow", (w) => {
  w.run("fetchDiff", (job) => {
    // Idempotent: reading a diff is a pure read.
    return { files: 3, additions: 42, summary: `diff for ${job.variables.prId}` };
  });

  w.run("autoReview", (job) => {
    // e.g. hand the diff to an LLM for a first-pass review.
    return { verdict: "approve", findings: `looks good (${job.variables.files} files)` };
  });

  // Durable wait: the instance parks here until a `humanApproval` message
  // arrives, correlated on the `prId` process variable. Resume it with:
  //   client.signal(prReviewFlow, "humanApproval", prIdValue, { approvedBy });
  w.signal("humanApproval", { correlationKey: "prId" });

  w.run("merge", (job) => {
    // Idempotent: keyed by prId; a redelivery re-merges the same PR.
    const approvedBy = job.variables.approvedBy ?? "system";
    return { merged: true, prId: job.variables.prId, approvedBy };
  });
});
