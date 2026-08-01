// Strategy B — the imperative surface: a replayed orchestration function (the
// Temporal-style code-first model).
//
//   const wf = defineWorkflow("pr-review", async (ctx) => {
//     const diff   = await ctx.run("fetchDiff",  () => gh.diff(ctx.input.prId));
//     const review = await ctx.run("autoReview", () => llm.review(diff));
//     if (review.blocking) await ctx.run("requestChanges", () => gh.comment(review));
//     await ctx.run("merge", () => gh.merge(ctx.input.prId));
//   });
//
// Real control flow (`if`, locals, composition) — what the declarative surface
// cannot express. The engine drives it by REPLAY: the derived model is a single
// orchestrator service task in a loop; each turn the worker replays the function
// from the top, feeding each `ctx.run` its recorded result from a durable
// journal (an engine process variable). Recorded steps are replayed (no side
// effect); only the frontier step executes. See ADR 0044.
//
// The orchestration body MUST be deterministic across replays (no wall-clock
// branching, RNG, or I/O outside `ctx.run` handlers).

import type { ImperativeWorkflow, Json, JsonObject, Orchestration, WorkflowContext } from "./types.js";
import { assertIdent, escapeXml, orchestrateType } from "./xml.js";

/** Define an imperative, replay-driven durable workflow.
 *
 * @experimental Not the recommended code-first surface. Prefer `defineFlow`
 * (declarative), whose steps are engine-visible BPMN nodes. This imperative
 * replay surface compiles to a single opaque looping orchestrator and requires
 * determinism discipline in the orchestration body; it is retained for advanced
 * durable-orchestration use only. */
export function defineWorkflow(id: string, orchestrate: Orchestration): ImperativeWorkflow {
  assertIdent("workflow id", id);
  if (typeof orchestrate !== "function") throw new Error("defineWorkflow needs an async orchestration function");
  return { kind: "imperative", id, orchestrate, orchestrateType: orchestrateType(id) };
}

/** The looped-orchestrator model: start → orchestrate → gw → (done ? end : loop). */
export function imperativeToBpmn(wf: ImperativeWorkflow): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Definitions_${escapeXml(wf.id)}" targetNamespace="http://bpmn.io/schema/bpmn">\n` +
    `  <bpmn:process id="${escapeXml(wf.id)}" name="${escapeXml(wf.id)}" isExecutable="true">\n` +
    `    <bpmn:startEvent id="Start"><bpmn:outgoing>f_start</bpmn:outgoing></bpmn:startEvent>\n` +
    `    <bpmn:serviceTask id="Orchestrate" name="orchestrate">\n` +
    `      <bpmn:extensionElements><zeebe:taskDefinition type="${escapeXml(wf.orchestrateType)}" /></bpmn:extensionElements>\n` +
    `      <bpmn:incoming>f_start</bpmn:incoming><bpmn:incoming>f_loop</bpmn:incoming><bpmn:outgoing>f_toGw</bpmn:outgoing>\n` +
    `    </bpmn:serviceTask>\n` +
    `    <bpmn:exclusiveGateway id="Gw" default="f_loop">\n` +
    `      <bpmn:incoming>f_toGw</bpmn:incoming><bpmn:outgoing>f_done</bpmn:outgoing><bpmn:outgoing>f_loop</bpmn:outgoing>\n` +
    `    </bpmn:exclusiveGateway>\n` +
    `    <bpmn:endEvent id="End"><bpmn:incoming>f_done</bpmn:incoming></bpmn:endEvent>\n` +
    `    <bpmn:sequenceFlow id="f_start" sourceRef="Start" targetRef="Orchestrate" />\n` +
    `    <bpmn:sequenceFlow id="f_toGw" sourceRef="Orchestrate" targetRef="Gw" />\n` +
    `    <bpmn:sequenceFlow id="f_done" sourceRef="Gw" targetRef="End">\n` +
    `      <bpmn:conditionExpression>=wfDone</bpmn:conditionExpression>\n` +
    `    </bpmn:sequenceFlow>\n` +
    `    <bpmn:sequenceFlow id="f_loop" sourceRef="Gw" targetRef="Orchestrate" />\n` +
    `  </bpmn:process>\n` +
    `</bpmn:definitions>\n`
  );
}

/** A journal of recorded step results, keyed by call-ordinal + name. */
export type Journal = Record<string, Json>;

const SUSPEND = Symbol("nanobpm.workflow.suspend");
interface SuspendCarrier {
  [SUSPEND]?: { key: string; result: Json };
}

/** Outcome of a single replay pass. */
export type ReplayStep =
  | { done: true }
  | { done: false; frontier: { key: string; result: Json } };

/**
 * Replay the orchestration function against a journal. Returns `{ done: true }`
 * if the function ran to completion, or the frontier step (the one un-recorded
 * `ctx.run`) whose handler was just executed and must be journalled next turn.
 *
 * Duplicate `ctx.run` names within a single pass are disambiguated by ordinal,
 * so a loop that calls `ctx.run("x", …)` repeatedly still gets distinct keys.
 */
export async function replayOnce(
  wf: ImperativeWorkflow,
  input: JsonObject,
  journal: Journal,
): Promise<ReplayStep> {
  let ordinal = 0;
  const ctx: WorkflowContext = {
    input,
    async run<T extends Json = Json>(name: string, fn: () => Promise<T> | T): Promise<T> {
      const key = `${++ordinal}:${name}`;
      if (Object.prototype.hasOwnProperty.call(journal, key)) {
        return journal[key] as T; // replay: return recorded value, no side effect
      }
      const result = ((await fn()) ?? null) as T; // frontier: the ONE real side effect this turn
      const carrier = new Error("nanobpm.workflow suspend") as Error & SuspendCarrier;
      carrier[SUSPEND] = { key, result };
      throw carrier;
    },
  };
  try {
    await wf.orchestrate(ctx);
    return { done: true };
  } catch (e) {
    const s = (e as SuspendCarrier)[SUSPEND];
    if (s) return { done: false, frontier: s };
    throw e; // a genuine error in the orchestration or a handler
  }
}
