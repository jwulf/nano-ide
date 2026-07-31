// Manifest types (a hand-mirrored subset of nano-app.schema.json — the block shapes the
// runtime actually consumes) plus env-placeholder expansion and a host-driven loader.
// The schema itself (src/schema/nano-app.schema.json) remains the source of truth for
// validation; see validate.ts.

import type { HostContext } from "./host.ts";

export interface DataSource {
  driver: string;
  url: string;
  migrations?: string;
}

export interface TypeField {
  type: string;
  optional?: boolean;
}

export interface DomainType {
  name?: string;
  table?: string;
  fields?: Record<string, TypeField>;
}

export interface WorkerDecl {
  /** Job/task type the worker subscribes to. Schema allows `taskType` or `type`. */
  taskType?: string;
  type?: string;
  /** Path to the handler module, relative to the app root. */
  handler: string;
}

export interface TriggerDecl {
  id: string;
  type: string;
  path?: string;
  auth?: string;
  action?: { message?: string; correlationKey?: string };
}

export interface SurfaceDecl {
  enabled?: boolean;
  path?: string;
  agent?: string;
}

export interface AppManifest {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  codename?: string;
  runtime?: { engine?: string; node?: string };
  models?: { processes?: string[]; decisions?: string[]; forms?: string[] };
  data?: { default?: string; sources?: Record<string, DataSource> };
  types?: Record<string, DomainType>;
  triggers?: TriggerDecl[];
  connections?: Record<string, { type: string; [k: string]: unknown }>;
  surfaces?: Record<string, SurfaceDecl>;
  workers?: WorkerDecl[];
  llm?: Record<string, unknown>;
  security?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The normalised job type for a worker declaration (`taskType` preferred, `type` fallback). */
export function workerJobType(w: WorkerDecl): string | undefined {
  return w.taskType ?? w.type;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` placeholders in a string using `lookup`.
 * Unset vars with no default expand to "" (matching common shell semantics).
 */
export function expandEnvString(input: string, lookup: (name: string) => string | undefined): string {
  return input.replace(ENV_RE, (_m, name: string, dflt: string | undefined) => {
    const v = lookup(name);
    if (v !== undefined && v !== "") return v;
    return dflt ?? "";
  });
}

/** Recursively expand env placeholders across every string in a JSON-ish value. */
export function expandEnv<T>(value: T, lookup: (name: string) => string | undefined): T {
  if (typeof value === "string") return expandEnvString(value, lookup) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, lookup)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, lookup);
    return out as T;
  }
  return value;
}

/** Parse a manifest from JSON text and expand env placeholders. Does not validate. */
export function parseManifest(
  json: string,
  lookup: (name: string) => string | undefined = () => undefined,
): AppManifest {
  const raw = JSON.parse(json) as AppManifest;
  return expandEnv(raw, lookup);
}

/** Load and parse the manifest from the app root using the host (env-expanded). */
export async function loadManifest(host: HostContext, manifestPath: string): Promise<AppManifest> {
  const text = await host.readTextFile(manifestPath);
  return parseManifest(text, (n) => host.env(n));
}
