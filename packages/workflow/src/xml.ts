// XML helpers + derived-name conventions shared by both model emitters.

import type { FlowNode, Workflow } from "./types.js";

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Derived job type for a declarative `run` step / imperative orchestrator. */
export const jobType = (workflowId: string, step: string): string => `${workflowId}:${step}`;

/** Derived message name for a declarative `signal` step. */
export const messageName = (workflowId: string, step: string): string => `${workflowId}:${step}`;

/** The single orchestrator job type of an imperative workflow. */
export const orchestrateType = (workflowId: string): string => `${workflowId}:__orchestrate`;

/** A BPMN identifier must be an NCName; validate derived ids fail fast. */
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export function assertIdent(kind: string, value: string): void {
  if (!NCNAME.test(value)) {
    throw new Error(`${kind} "${value}" is not a valid BPMN identifier (expected an NCName)`);
  }
}

/** An explicit job type override (e.g. a `rank:capability` worker token like
 *  `senior:pr-review`). Unlike a step name it is NOT a BPMN element id, so it may
 *  carry the `:`/`+` token delimiters a `c8ctl nano work` matrix uses; it only
 *  has to be a non-empty, whitespace-free token. */
const JOB_TYPE = /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/;
export function assertJobType(kind: string, value: string): void {
  if (typeof value !== "string" || !JOB_TYPE.test(value)) {
    throw new Error(
      `${kind} "${value}" is not a valid job type (expected a non-empty token of letters, digits, and _ . : + -)`,
    );
  }
}

export function assertWorkflowIds(wf: Workflow): void {
  assertIdent("workflow id", wf.id);
  if (wf.kind === "declarative") {
    assertNodeNames(wf.steps);
  }
}

function assertNodeNames(nodes: FlowNode[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "run":
      case "signal":
        assertIdent("step name", node.name);
        break;
      case "task":
        assertIdent("step name", node.name);
        if (node.jobType !== undefined) assertJobType("job type", node.jobType);
        break;
      case "switch":
        for (const c of node.cases) assertNodeNames(c.body);
        if (node.default) assertNodeNames(node.default);
        break;
      case "branch":
        assertNodeNames(node.then);
        if (node.else) assertNodeNames(node.else);
        break;
      case "loop":
        assertNodeNames(node.body);
        break;
      case "break":
      case "continue":
        break;
    }
  }
}
