// @nanobpm/urban — the code-first Urban stack in one package (ADR 0054):
//
//   • runtime — materialize and serve an app from a nano.app.json manifest
//     (datasource, workers, surfaces, triggers) on Node or Deno.
//   • toolkit — pure derivers (`urban gen`) that emit generated artifacts
//     (SQL migrations, worker I/O bindings) from the model.
//   • workflow — the code-first process surface, re-exported from
//     `@nanobpm/workflow`: author durable flows with `defineFlow` and the SDK
//     derives the executable BPMN, job types, and correlation wiring.
//
// The CLI (`urban`) is a separate entrypoint (bin) over this same API.
// Subpath imports are also available: `@nanobpm/urban/runtime` and
// `@nanobpm/urban/toolkit`.

// Runtime — app materialization + hosting
export * from "./runtime/index.ts";

// Toolkit — derivation library (`urban gen`)
export * from "./toolkit/index.ts";

// Code-first process surface (re-exported from @nanobpm/workflow)
export {
  defineFlow,
  declarativeToBpmn,
  declarativeToLayoutedBpmn,
  externalJobTypes,
  envelope,
  layoutBpmn,
  toBpmn,
  Worker,
  WorkflowClient,
  WorkflowError,
} from "@nanobpm/workflow";
export type {
  FlowBuilder,
  Envelope,
  EnvelopeType,
  EnvelopeField,
  FieldSpec,
  ScalarType,
  WorkflowClientOptions,
  ActivateOptions,
  WorkerOptions,
  ActivityEvent,
} from "@nanobpm/workflow";
