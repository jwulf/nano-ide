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

// --- Timer definitions (BPMN timerEventDefinition bodies) --------------------
//
// The engine (engine-core/src/bpmn.rs) accepts a nested `timeDuration`,
// `timeCycle`, or `timeDate` as either a static ISO-8601 literal or a FEEL
// expression (a leading `=`). We validate the literal forms at authoring time so
// a malformed timer fails fast in the DSL rather than at deploy.

/** An ISO-8601 duration with integer week/day/hour/minute/second components
 *  (no years/months — ambiguous length — matching the engine's parser). */
const ISO_DURATION = /^P(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
function isIsoDuration(v: string): boolean {
  if (!ISO_DURATION.test(v) || v === "P" || v === "PT" || v.endsWith("T")) return false;
  return /\d/.test(v);
}

/** A recurring ISO-8601 interval: an optional `R[n]/` repeat prefix + a
 *  duration, or a bare duration (the engine repeats it unboundedly). */
function isIsoCycle(v: string): boolean {
  const slash = v.indexOf("/");
  if (slash < 0) return isIsoDuration(v);
  const repeat = v.slice(0, slash);
  const interval = v.slice(slash + 1);
  return /^R\d*$/.test(repeat) && isIsoDuration(interval);
}

/** An ISO-8601 date-time instant (a `timeDate`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** A FEEL expression body (a leading `=`, non-empty). */
function isFeel(v: string): boolean {
  return v.startsWith("=") && v.length > 1;
}

export function assertTimerDuration(kind: string, value: string): void {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "" || (!isFeel(v) && !isIsoDuration(v))) {
    throw new Error(
      `${kind} "${value}" is not an ISO-8601 duration (e.g. PT1M30S, P1DT6H) or a FEEL expression (=...)`,
    );
  }
}

export function assertTimerCycle(kind: string, value: string): void {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "" || (!isFeel(v) && !isIsoCycle(v))) {
    throw new Error(
      `${kind} "${value}" is not an ISO-8601 repeating interval (e.g. R/PT1H, R5/PT30M) or a FEEL expression (=...)`,
    );
  }
}

export function assertTimerDate(kind: string, value: string): void {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "" || (!isFeel(v) && !ISO_DATE.test(v))) {
    throw new Error(
      `${kind} "${value}" is not an ISO-8601 instant (e.g. 2026-01-01T09:00:00Z) or a FEEL expression (=...)`,
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
      case "timer":
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
