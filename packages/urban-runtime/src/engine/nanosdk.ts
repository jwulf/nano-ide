// nano-sdk engine adapter. The console wires every generated app to `@nanobpm/nano-sdk`'s
// `createCamundaClient`, which upgrades the throughput-critical path — process-instance
// creation — to the Falcon protocol (falling back to REST). This adapter lets the Urban
// runtime use that same client, so the runtime and the IDE talk to the engine the same way
// (ADR 0053).
//
// Scope: the adapter routes instance creation (the hot path Falcon actually upgrades) through
// the SDK client, and delegates the cold paths (deploy, publish, user tasks, workers) to a
// REST fallback with the same address/token. `@nanobpm/nano-sdk` is an OPTIONAL dependency —
// imported lazily — so the runtime keeps a dependency-free core and REST-only default.

import type { EngineClient, JobHandler, WorkerSubscription } from "../core/host.ts";
import { RestEngineClient } from "./rest.ts";

/** The subset of the `@nanobpm/nano-sdk` client the adapter uses. */
export interface NanoSdkClient {
  createProcessInstance(
    input: {
      processDefinitionId: string;
      variables?: Record<string, unknown>;
      awaitCompletion?: boolean;
    },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  close?(): void | Promise<void>;
}

export interface NanoSdkEngineOptions {
  /** REST base, e.g. http://localhost:8080/v2. */
  restAddress: string;
  token?: string;
  /** CAMUNDA_TRANSPORT: "auto" | "falcon" | "rest". Passed to createCamundaClient. */
  transport?: string;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  /** Test seam: provide the SDK client factory instead of importing @nanobpm/nano-sdk. */
  createClient?: (opts: { restAddress: string; token?: string; transport?: string }) => NanoSdkClient;
  /** Test seam / customisation: the cold-path client. Defaults to a RestEngineClient. */
  fallback?: EngineClient;
}

async function importNanoSdk(): Promise<
  (opts: Record<string, unknown>) => NanoSdkClient
> {
  // Indirect the specifier so the (optional, peer) module is not resolved at typecheck time.
  const spec = "@nanobpm/nano-sdk";
  const mod = (await import(spec)) as {
    createCamundaClient?: (opts: Record<string, unknown>) => NanoSdkClient;
  };
  if (typeof mod.createCamundaClient !== "function") {
    throw new Error("@nanobpm/nano-sdk does not export createCamundaClient");
  }
  return mod.createCamundaClient;
}

/**
 * Build an EngineClient backed by `@nanobpm/nano-sdk` for instance creation (Falcon) and a REST
 * fallback for everything else. Returns `null` if the SDK cannot be loaded (and no test seam was
 * given), so callers can fall back to plain REST.
 */
export async function createNanoSdkEngineClient(
  opts: NanoSdkEngineOptions,
): Promise<EngineClient | null> {
  const log = opts.log ?? (() => {});
  let client: NanoSdkClient;
  try {
    if (opts.createClient) {
      client = opts.createClient({
        restAddress: opts.restAddress,
        token: opts.token,
        transport: opts.transport,
      });
    } else {
      const createCamundaClient = await importNanoSdk();
      client = createCamundaClient({
        config: {
          CAMUNDA_REST_ADDRESS: opts.restAddress,
          CAMUNDA_TOKEN: opts.token,
          CAMUNDA_TRANSPORT: opts.transport ?? "auto",
        },
      });
    }
  } catch (err) {
    log("warn", "nano-sdk unavailable; using REST transport", { error: String(err) });
    return null;
  }

  const fallback =
    opts.fallback ?? new RestEngineClient({ baseUrl: opts.restAddress, token: opts.token, log });

  const adapter: EngineClient = {
    deployResources: (resources) => fallback.deployResources(resources),

    async createInstance(input) {
      const body = await client.createProcessInstance({
        processDefinitionId: input.processDefinitionId,
        variables: input.variables,
        awaitCompletion: input.awaitCompletion ?? false,
      });
      const key =
        (body.processInstanceKey as string | number | undefined) ?? (body.key as string | number | undefined);
      return {
        processInstanceKey: key != null ? String(key) : "",
        variables: (body.variables as Record<string, unknown> | undefined) ?? undefined,
      };
    },

    publishMessage: (input) => fallback.publishMessage(input),
    searchUserTasks: (filter) => fallback.searchUserTasks(filter),
    completeUserTask: (key, vars) => fallback.completeUserTask(key, vars),

    registerWorker: (jobType: string, handler: JobHandler, options): Promise<WorkerSubscription> =>
      fallback.registerWorker(jobType, handler, options),

    async close() {
      try {
        await client.close?.();
      } finally {
        await fallback.close();
      }
    },
  };
  return adapter;
}
