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
  /** Path to the handler module, relative to the app root. Mutually exclusive with `llm`. */
  handler?: string;
  /** Name of an `llm[]` binding used as the worker (LLM-as-worker). Mutually exclusive with `handler`. */
  llm?: string;
}

/**
 * One named LLM binding (`llm.<id>` in the manifest). A binding is usable as a worker
 * (LLM-as-worker, ADR 0022 §E role 1) or as a chat surface agent. `provider` selects how
 * the endpoint is resolved (`"env"` reads it from the environment); `model` is typically
 * an env template. When `output.decision` is set, the model's JSON reply is fed through
 * that DMN decision (the "rails") and the decision's output is returned instead.
 */
export interface LlmBinding {
  /** Provider selector. `"env"` resolves an OpenAI-compatible endpoint from the environment. */
  provider: string;
  /** Model id, typically an env template (e.g. `${NANO_APP_LLM_MODEL}`). */
  model: string;
  /** Constrains the model's structured output — currently a DMN decision id (the rails). */
  output?: { decision?: string };
  /** Action-API tools the agent may call (chat-agent role; unused by the worker role). */
  tools?: string[];
}

export interface TriggerDecl {
  id: string;
  type: string;
  path?: string;
  auth?: string;
  /** cron: the 5-field crontab spec (UTC), e.g. "0 6 * * *". */
  spec?: string;
  /** cron catch-up policy for fires missed while the app was down. Default "skip". */
  onMissed?: "skip" | "once" | "all";
  /** Source-kind-specific settings (e.g. file `{ pollMs }`). */
  config?: Record<string, unknown>;
  /** Name of a connections[] entry supplying this source's credentials. */
  connection?: string;
  /** Maps the event to one engine call: start a process OR publish a message (ADR 0025 §1). */
  action?: {
    /** Process id/name to start. */
    start?: string;
    /** messageName to publish as a CorrelateMessage. */
    message?: string;
    /** correlationKey (literal, or `= body.path`) for a message action. */
    correlationKey?: string;
    /** variables for the started instance / published message (literal record or `= body.path`). */
    variables?: unknown;
  };
}

export interface SurfaceDecl {
  enabled?: boolean;
  path?: string;
  agent?: string;
  /** pages surface: directory of `*.page.json` (relative to app root). Default `pages`. */
  pagesDir?: string;
  /** pages surface: the page served at `/`. Default `home`. */
  homePage?: string;
  /** pages surface: max rows a `dataGrid` fetch returns. Default 200. */
  rowLimit?: number;
  /** pages surface: the injected default datasource name. Default `app`. */
  sourceName?: string;
}

/**
 * An app-authored action handler override (ADR 0055 phase 3). Each declaration binds a
 * route to a handler module (default-exports an `ActionHandler`), letting an app wrap the
 * generic pages start/cancel/message actions with business logic. Mounted before the
 * generic pages action routes, so an exact override shadows the generic one.
 */
export interface ActionDecl {
  /** Route path to serve, e.g. "/app/actions/cancel" or "/app/actions/start/convergence-loop". */
  path: string;
  /** Handler module path relative to the app root; default-exports an `ActionHandler`. */
  module: string;
  /** HTTP method to match. Default "POST". */
  method?: string;
  /** Match `path` as a prefix rather than exactly. Default false. */
  prefix?: boolean;
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
  actions?: ActionDecl[];
  workers?: WorkerDecl[];
  llm?: Record<string, LlmBinding>;
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
