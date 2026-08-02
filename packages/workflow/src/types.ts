// Public types for @nanobpm/workflow.

import type { Envelope } from "./envelope.js";

/** A JSON-serialisable value, as carried by process variables. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** A job as delivered by the nanobpmn gateway's `POST /v2/jobs/activation`. The
 *  `variables` type parameter carries the input envelope's inferred payload when
 *  a step is declared with a typed envelope; it defaults to the untyped
 *  `JsonObject`. */
export interface Job<V extends JsonObject = JsonObject> {
  jobKey: string;
  processInstanceKey: string;
  elementId: string;
  type: string;
  variables: V;
}

// --- Declarative surface (Strategy A: compile a step tree to a BPMN model) ----
//
// A flow is a TREE of nodes, not a flat list: leaf activities (`run`/`task`/
// `signal`) plus structural combinators (`switch`/`branch`/`loop`) that compile
// to real XOR gateways and back-edges. See declarative.ts for the compiler.

/** The input/output data envelopes lifted onto an activity node. */
export interface NodeEnvelopes {
  in?: Envelope;
  out?: Envelope;
}

/** A typed I/O contract for one step: its input and/or output data envelope.
 *  For a `signal`, `in` types the message payload. */
export interface StepContract {
  in?: Envelope;
  out?: Envelope;
}

/** A flow's typed I/O registry, keyed by step name — the single source of truth
 *  for each step's envelopes. Passed to `defineFlow`; a step whose name is a key
 *  is typed (and its envelopes lifted to the model), others fall back to the
 *  untyped `JsonObject`. */
export type FlowContracts = Record<string, StepContract>;

/** Handler for a declarative `run` step: does real work, returns variables. */
export type StepHandler = (job: Job) => Promise<JsonObject | void> | JsonObject | void;

/** A node in a declarative flow tree. Leaf activities carry optional data
 *  envelopes (lifted to `nano:shape` + `dataEnvelope` in the model); structural
 *  combinators carry nested `FlowNode[]` bodies. */
export type FlowNode =
  | { kind: "run"; name: string; envelopes?: NodeEnvelopes }
  | { kind: "task"; name: string; envelopes?: NodeEnvelopes; jobType?: string }
  | { kind: "signal"; name: string; correlationKey: string; payload?: Envelope }
  | { kind: "timer"; name: string; after?: string; at?: string }
  | { kind: "switch"; subject: string; cases: SwitchCase[]; default?: FlowNode[] }
  | { kind: "branch"; condition: string; then: FlowNode[]; else?: FlowNode[] }
  | { kind: "loop"; body: FlowNode[] }
  | { kind: "break" }
  | { kind: "continue" };

/** A flow's start-timer: the plain none start event becomes a durable timer
 *  start the engine fires on schedule. Exactly one field is set:
 *  - `cycle` — a recurring ISO-8601 interval (`R/PT1H`, `R5/PT30M`) or bare
 *    duration; the engine re-fires on each period. This is the model-native,
 *    durable, single-fire-per-cluster replacement for an app-side cron.
 *  - `after` — a one-shot ISO-8601 delay (`PT10S`) measured from deployment.
 *  - `at`    — a one-shot absolute instant (an ISO-8601 date-time, or a FEEL
 *    `=` expression). */
export interface TimerStart {
  cycle?: string;
  after?: string;
  at?: string;
}

/** One case of a `switch`: routed when `subject = value` (FEEL equality). */
export interface SwitchCase {
  value: string;
  body: FlowNode[];
}

/** @deprecated Renamed to {@link FlowNode} now that a flow is a tree of nodes,
 *  not a flat list of steps. Kept as an alias for source compatibility. */
export type DeclarativeStep = FlowNode;

export interface DeclarativeFlow {
  kind: "declarative";
  id: string;
  /** The flow's node tree (top-level sequence). */
  steps: FlowNode[];
  handlers: Record<string, StepHandler>;
  /** When set, the flow's start event is a durable timer start (see
   *  {@link TimerStart}) rather than a plain none start. */
  startTimer?: TimerStart;
}

// --- Imperative surface (Strategy B: a replayed orchestration function) -------

/** The context passed to an imperative orchestration function. */
export interface WorkflowContext {
  /** The workflow's start input (immutable across replays). */
  readonly input: JsonObject;
  /**
   * A durable activity. On first execution the handler runs (its side effects
   * happen once); on every subsequent replay the recorded result is returned
   * WITHOUT invoking the handler. The handler is the only place side effects
   * (I/O, network, shell, LLM) are allowed — the orchestration body itself must
   * be deterministic.
   */
  run<T extends Json = Json>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export type Orchestration = (ctx: WorkflowContext) => Promise<void>;

export interface ImperativeWorkflow {
  kind: "imperative";
  id: string;
  orchestrate: Orchestration;
  /** Derived job type of the single orchestrator task: `<id>:__orchestrate`. */
  orchestrateType: string;
}

export type Workflow = DeclarativeFlow | ImperativeWorkflow;

/** Result of deploying a workflow. */
export interface DeployResult {
  [k: string]: Json;
}

/** Result of starting a workflow instance. */
export interface StartResult {
  processInstanceKey?: string;
  [k: string]: Json | undefined;
}
