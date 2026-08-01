import type { AppManifest } from "./manifest.ts";
import type { EngineClient, HostContext } from "./host.ts";

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
  env(name: string): string | undefined;
  log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}
