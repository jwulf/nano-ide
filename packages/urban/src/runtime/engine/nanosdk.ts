// The Urban runtime's single engine client. Every path to a Nano engine — deploy,
// instance creation, message publication, user tasks, and job workers — routes
// through one `@nanobpm/nano-sdk` client (ADR 0055). The SDK's `createCamundaClient`
// transparently upgrades the throughput-critical paths (process-instance creation and
// job serving) to the Falcon protocol on a Nano server and falls back to REST
// everywhere else, so the runtime and the IDE talk to the engine the same way with a
// single transport instead of a hand-rolled REST client plus a Falcon shim.
//
// `@nanobpm/nano-sdk` is a direct dependency, but it is imported lazily (via an
// indirected specifier) so a caller that injects its own client — unit tests, the
// Deno smoke, or an author bringing the embedded transport — never loads it, keeping
// a dependency-free import graph for those paths.

import type {
  EngineClient,
  EngineJob,
  JobHandler,
  WorkerSubscription,
} from "../core/host.ts";

/** Coerce an engine response's process-instance key to a non-empty string, or
 * throw — a missing key means a malformed/partial response, not a real instance. */
export function requireProcessInstanceKey(key: string | number | null | undefined): string {
  if (key == null || key === "") {
    throw new Error("engine response missing processInstanceKey/key");
  }
  return String(key);
}

/** A job as delivered to a nano-sdk job handler: the frame fields plus the
 *  acknowledgement actions the handler must call. */
export interface NanoSdkActivatedJob {
  jobKey: string;
  type?: string;
  processInstanceKey?: string | number;
  elementId?: string;
  variables?: Record<string, unknown>;
  complete(variables?: Record<string, unknown>): Promise<unknown>;
  fail(body: { errorMessage: string; retries?: number }): Promise<unknown>;
}

/** Config for a nano-sdk job worker (the subset this adapter sets). */
export interface NanoSdkJobWorkerConfig {
  jobType: string;
  jobHandler: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  workerName?: string;
  maxParallelJobs?: number;
  jobTimeoutMs?: number;
  pollTimeoutMs?: number;
  fetchVariables?: string[];
  /** Start polling immediately. This adapter sets it false and starts explicitly. */
  autoStart?: boolean;
}

/** The handle returned by `createJobWorker`. */
export interface NanoSdkJobWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  stopGracefully?(opts?: { waitUpToMs?: number }): Promise<void>;
}

/**
 * The subset of the `@nanobpm/nano-sdk` (Camunda orchestration-cluster) client the
 * engine adapter uses. `createCamundaClient` returns a superset of this, so a test —
 * or an author bringing their own transport (e.g. the embedded engine) — can inject
 * any object satisfying it.
 */
export interface NanoSdkClient {
  createDeployment(
    input: { resources: File[]; [k: string]: unknown },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  createProcessInstance(
    input: {
      processDefinitionId: string;
      variables?: Record<string, unknown>;
      awaitCompletion?: boolean;
    },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  publishMessage(
    input: { name: string; correlationKey?: string; variables?: Record<string, unknown> },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchUserTasks(
    input: { filter?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  completeUserTask(
    input: { userTaskKey: string; variables?: Record<string, unknown> },
    options?: unknown,
  ): Promise<unknown>;
  createJobWorker(cfg: NanoSdkJobWorkerConfig): NanoSdkJobWorker;
  close?(): void | Promise<void>;
}

type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/**
 * An `EngineClient` backed entirely by a `@nanobpm/nano-sdk` client. Deploy, create,
 * message, and user-task calls map one-to-one onto the SDK's client methods; workers
 * are the SDK's own job worker, which handles activation, completion, failure, and
 * long-poll/backoff reconnect behind the same transport.
 */
export class SdkEngineClient implements EngineClient {
  private readonly workers = new Set<NanoSdkJobWorker>();
  private readonly client: NanoSdkClient;
  private readonly log: Log;

  constructor(client: NanoSdkClient, log: Log = () => {}) {
    this.client = client;
    this.log = log;
  }

  async deployResources(
    resources: { name: string; content: string; contentType: string }[],
  ): Promise<{ deployed: number }> {
    const files = resources.map((r) => new File([r.content], r.name, { type: r.contentType }));
    await this.client.createDeployment({ resources: files });
    return { deployed: resources.length };
  }

  async createInstance(input: {
    processDefinitionId: string;
    variables?: Record<string, unknown>;
    awaitCompletion?: boolean;
  }): Promise<{ processInstanceKey: string; variables?: Record<string, unknown> }> {
    const body = await this.client.createProcessInstance({
      processDefinitionId: input.processDefinitionId,
      variables: input.variables,
      awaitCompletion: input.awaitCompletion ?? false,
    });
    const key =
      (body.processInstanceKey as string | number | undefined) ??
      (body.key as string | number | undefined);
    return {
      processInstanceKey: requireProcessInstanceKey(key),
      variables: (body.variables as Record<string, unknown> | undefined) ?? undefined,
    };
  }

  async publishMessage(input: {
    name: string;
    correlationKey?: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    await this.client.publishMessage({
      name: input.name,
      correlationKey: input.correlationKey ?? "",
      variables: input.variables ?? {},
    });
  }

  async searchUserTasks(filter?: {
    processInstanceKey?: string;
    assignee?: string;
    candidateGroup?: string;
  }): Promise<{ userTaskKey: string; elementId?: string; variables?: Record<string, unknown> }[]> {
    // User tasks are an eventually consistent read; ask for zero-wait consistency so
    // the search reflects what is currently visible without blocking.
    const body = await this.client.searchUserTasks(
      { filter: (filter ?? {}) as Record<string, unknown> },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = (body.items as Record<string, unknown>[] | undefined) ?? [];
    return items.flatMap((it) => {
      const userTaskKey = it.userTaskKey ?? it.key;
      if (userTaskKey == null || userTaskKey === "") {
        this.log("warn", "skipping user task with no key in engine response");
        return [];
      }
      return [{
        userTaskKey: String(userTaskKey),
        elementId: it.elementId as string | undefined,
        variables: it.variables as Record<string, unknown> | undefined,
      }];
    });
  }

  async completeUserTask(userTaskKey: string, variables?: Record<string, unknown>): Promise<void> {
    await this.client.completeUserTask({ userTaskKey, variables: variables ?? {} });
  }

  async registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription> {
    const worker = this.client.createJobWorker({
      jobType,
      workerName: options?.workerName ?? `urban:${jobType}`,
      maxParallelJobs: options?.maxParallelJobs ?? 8,
      fetchVariables: options?.fetchVariables,
      // Own the poll lifecycle here rather than leaving it to the SDK's auto-start
      // default, so nothing polls until `start()` is called below.
      autoStart: false,
      jobHandler: async (job) => {
        const rawKey = job.jobKey;
        if (rawKey == null || rawKey === "") {
          this.log("warn", `activation ${jobType}: skipping job with no jobKey in engine response`);
          return undefined;
        }
        const engineJob: EngineJob = {
          jobKey: String(rawKey),
          jobType,
          processInstanceKey:
            job.processInstanceKey != null ? String(job.processInstanceKey) : undefined,
          elementId: job.elementId,
          variables: job.variables ?? {},
        };
        try {
          const out = await handler(engineJob);
          return await job.complete((out as Record<string, unknown> | undefined) ?? {});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log("error", `handler ${jobType} threw`, { err: message });
          try {
            // Best-effort failure report; the engine redelivers after the lock
            // times out (at-least-once → handlers must be idempotent). Await +
            // swallow so a rejected `fail` cannot escape as an unhandled rejection.
            return await job.fail({ errorMessage: message.slice(0, 500), retries: 0 });
          } catch {
            return undefined;
          }
        }
      },
    });
    await worker.start();
    this.workers.add(worker);

    return {
      jobType,
      unsubscribe: async () => {
        await this.stopWorker(worker);
        this.workers.delete(worker);
      },
    };
  }

  /** Stop one worker, tolerating a Falcon worker whose transport never bound
   *  (detection still pending) — its `stop` throws, which must not fail teardown. */
  private async stopWorker(worker: NanoSdkJobWorker): Promise<void> {
    try {
      await (worker.stopGracefully ? worker.stopGracefully() : worker.stop());
    } catch {
      /* worker never fully started (transport unbound); nothing to drain */
    }
  }

  async close(): Promise<void> {
    for (const w of this.workers) await this.stopWorker(w);
    this.workers.clear();
    try {
      await this.client.close?.();
    } catch {
      /* transport already closed / never opened */
    }
  }
}

export interface NanoSdkEngineOptions {
  /** REST base, e.g. http://localhost:8080/v2. */
  restAddress: string;
  token?: string;
  /** CAMUNDA_TRANSPORT: "auto" | "falcon" | "rest" | "embedded". Passed to createCamundaClient. */
  transport?: string;
  log?: Log;
  /** Test seam: inject a ready-made SDK client (or a compatible fake). */
  client?: NanoSdkClient;
  /** Test seam: provide the SDK client factory instead of importing @nanobpm/nano-sdk. */
  createClient?: (opts: { restAddress: string; token?: string; transport?: string }) => NanoSdkClient;
}

async function importNanoSdk(): Promise<
  (opts: Record<string, unknown>) => NanoSdkClient
> {
  // Indirect the specifier so the (lazily loaded) module is not resolved at
  // typecheck time and stays out of the import graph for injected-client paths.
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
 * Build the Urban runtime's `EngineClient`, backed by a single `@nanobpm/nano-sdk`
 * client. Provide a `client`/`createClient` seam to inject a fake (tests, embedded
 * transport); otherwise a client is constructed from `restAddress`/`token`/`transport`.
 */
export async function createNanoSdkEngineClient(
  opts: NanoSdkEngineOptions,
): Promise<EngineClient> {
  const log = opts.log ?? (() => {});
  let client: NanoSdkClient;
  if (opts.client) {
    client = opts.client;
  } else if (opts.createClient) {
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
        ...(opts.token ? { CAMUNDA_TOKEN: opts.token } : {}),
        CAMUNDA_TRANSPORT: opts.transport ?? "auto",
      },
    });
  }
  return new SdkEngineClient(client, log);
}
