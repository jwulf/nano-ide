import { defineWorkflow } from "@nanobpm/workflow";

// A durable "review a pull request" loop. Replace the step bodies with real
// work (GitHub calls, an LLM review, a merge). Keep every side effect inside a
// `ctx.run(...)` step and make it idempotent — a crash between a side effect and
// its journal commit redelivers the step (at-least-once).
export const prReview = defineWorkflow("pr-review", async (ctx) => {
  const prId = ctx.input.prId;
  if (typeof prId !== "string" || prId.length === 0) {
    throw new Error("pr-review requires a non-empty string `prId` input");
  }

  const diff = await ctx.run("fetchDiff", async () => {
    // Idempotent: reading a diff is a pure read.
    return { prId, files: 3, additions: 42 };
  });

  const review = await ctx.run("review", async () => {
    // e.g. hand `diff` to an LLM; deterministic key -> replayed on resume.
    return { verdict: "approve", notes: `looks good (${diff.files} files)` };
  });

  await ctx.run("merge", async () => {
    // Idempotent: keyed by prId; a redelivery re-merges the same PR.
    return { merged: review.verdict === "approve", prId };
  });
});
