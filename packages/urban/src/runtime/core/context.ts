import type { AppManifest } from "./manifest.ts";
import type { EngineClient, HostContext } from "./host.ts";
import type { EngineSdkClient } from "../engine/sdk.ts";

/** Everything a runtime module needs. Passed to each module's mount function. */
export interface RuntimeContext {
  manifest: AppManifest;
  host: HostContext;
  engine: EngineClient;
  /** App root directory (paths in the manifest are relative to this). */
  root: string;
}

/** A mounted module returns a disposer so the runtime can tear it down cleanly. */
export interface Mounted {
  readonly name: string;
  stop(): Promise<void>;
  /** Optional human-readable summary for `inspect()`. */
  describe?(): Record<string, unknown>;
}

// AppApi is imported lazily to avoid a cycle; declared here as the injected handler surface.
import type { DataLayer } from "./modules/datasource.ts";

/**
 * The surface injected into worker/trigger/surface handlers — the app's runtime API.
 * This is how a handler reaches the datasource (typed accessors), the engine, and host
 * utilities without hard-coding any of them.
 */
export interface AppApi {
  manifest: AppManifest;
  data: DataLayer;
  engine: EngineClient;
  /**
   * The underlying `@nanobpm/nano-sdk` engine client, present when the app runs on
   * the nano-sdk transport (the default). It exposes the full Camunda
   * orchestration-cluster surface — decisions, cluster variables, incidents, user
   * tasks, agents, batch operations — beyond the transport-agnostic `engine` seam,
   * over the same connection. Undefined when a non-SDK engine is injected (e.g. an
   * in-memory test double).
   */
  sdk?: EngineSdkClient;
  env(name: string): string | undefined;
  log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}
