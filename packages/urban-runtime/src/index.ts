// Public API for @nanobpm/urban-runtime.

// Core runtime
export { createUrbanApp } from "./core/runtime.ts";
export type {
  CreateUrbanAppOptions,
  MountFlags,
  UrbanApp,
} from "./core/runtime.ts";

// Manifest
export {
  expandEnv,
  expandEnvString,
  loadManifest,
  parseManifest,
  workerJobType,
} from "./core/manifest.ts";
export type {
  AppManifest,
  DataSource,
  DomainType,
  SurfaceDecl,
  TriggerDecl,
  TypeField,
  WorkerDecl,
} from "./core/manifest.ts";

// Validation
export {
  collectManifestIssues,
  ManifestValidationError,
  validateManifest,
} from "./core/validate.ts";
export type { ValidationIssue } from "./core/validate.ts";

// Host + engine contracts (for custom hosts / tests)
export type {
  EngineClient,
  EngineJob,
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  HttpServer,
  JobHandler,
  SqliteDb,
  WorkerSubscription,
} from "./core/host.ts";
export type { AppApi, Mounted, RuntimeContext } from "./core/context.ts";

// Data layer
export { DataLayer, TypeRepo } from "./core/modules/datasource.ts";
export type { ProvisionedSource } from "./core/modules/datasource.ts";
export type { AppJobHandler } from "./core/modules/workers.ts";
export { resolveHandler } from "./core/modules/workers.ts";
export { evalCorrelation } from "./core/modules/triggers.ts";

// Adapters + engine + run entrypoint
export { createNodeHost } from "./adapters/node.ts";
export { createDenoHost } from "./adapters/deno.ts";
export { isDeno, selectHost } from "./adapters/detect.ts";
export { RestEngineClient } from "./engine/rest.ts";
export type { RestEngineOptions } from "./engine/rest.ts";
export { createNanoSdkEngineClient } from "./engine/nanosdk.ts";
export type { NanoSdkEngineOptions, NanoSdkClient } from "./engine/nanosdk.ts";
export { runFromEnv } from "./run.ts";
export type { RunOptions } from "./run.ts";
