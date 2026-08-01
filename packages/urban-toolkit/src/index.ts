// Public API for @nanobpm/urban-toolkit — the shared derivation library. The IDE and the
// `urban gen` CLI are peer callers of these pure derivers (ADR 0053).

// Artifact + deriver contract
export type { DerivedArtifact, Deriver } from "./artifact.ts";
export { GENERATED_DIR, sortArtifacts } from "./artifact.ts";

// Derivers
export {
  deriveMigrations,
  migrationsDeriver,
  sqlType,
  createTableSql,
} from "./derivers/migrations.ts";
export type { ToolkitManifest, ToolkitType, ToolkitField } from "./derivers/migrations.ts";

export {
  deriveWorkerBindings,
  emitWorkerBindings,
  workerIoDeriver,
  scanModelWorkers,
  WORKER_BINDINGS_DTS,
  DOMAIN_DTS,
} from "./derivers/worker-io.ts";
export type { ModelSource, WorkerIo, WorkerBindingDecl } from "./derivers/worker-io.ts";

export { deriveModelFromFlow, modelDeriver } from "./derivers/model.ts";
export type { CodeFlow, CodeFlowStep } from "./bpmn.ts";
export { flowToBpmn } from "./bpmn.ts";

// The registry of all derivers (for discovery / IDE migration).
import { migrationsDeriver } from "./derivers/migrations.ts";
import { workerIoDeriver } from "./derivers/worker-io.ts";
import { modelDeriver } from "./derivers/model.ts";
export const DERIVERS = [migrationsDeriver, workerIoDeriver, modelDeriver] as const;

// Gen orchestrator + IO
export { collectArtifacts, runGen, joinPath } from "./gen.ts";
export type { GenIO, GenOptions, GenResult } from "./gen.ts";
export { createNodeGenIO } from "./fsio.ts";
