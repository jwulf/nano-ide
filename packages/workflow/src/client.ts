// A client for a running nanobpmn gateway, built on `@nanobpm/nano-sdk` (the
// single engine-transport spine — ADR 0055). It derives a workflow's model,
// deploys it (with diagram interchange), starts instances, and correlates
// signals; the low-level job protocol used by the Worker runtime is the SDK's
// own job worker, reached through the exposed `sdk` client.

import { createCamundaClient } from "@nanobpm/nano-sdk";
import { declarativeToBpmn, walkNodes } from "./declarative.js";
import { imperativeToBpmn } from "./imperative.js";
import { layoutBpmn } from "./layout.js";
import type { DeclarativeFlow, DeployResult, Job, JsonObject, StartResult, Workflow } from "./types.js";
import { assertWorkflowIds, messageName } from "./xml.js";

/** Render a workflow (either surface) to its executable BPMN model. */
export function toBpmn(wf: Workflow): string {
  assertWorkflowIds(wf);
  return wf.kind === "imperative" ? imperativeToBpmn(wf) : declarativeToBpmn(wf);
}

let warnedNoLayout = false;

/**
 * Render a workflow to *deployable* BPMN — the executable model plus diagram
 * interchange (DI), auto-generated with `bpmn-auto-layout` — so the deployed
 * process opens rendered and inspectable in a modeller/Operate rather than as a
 * blank canvas. The semantic model stays authoritative; DI is derived.
 *
 * DI generation needs the optional peer dependency `bpmn-auto-layout`. When it is
 * absent, this degrades gracefully: it warns once and returns the DI-less model
 * so `deploy` still works everywhere. Pass `{ layout: false }` to skip layout
 * deliberately. A genuine layout failure (the dep is installed but errors) is
 * surfaced, not swallowed.
 */
export async function toDeployableBpmn(
  wf: Workflow,
  opts: { layout?: boolean } = {},
): Promise<string> {
  const semantic = toBpmn(wf);
  if (opts.layout === false) return semantic;
  try {
    return await layoutBpmn(semantic);
  } catch (e) {
    // Only fall back for the "optional dep not installed" case (layoutBpmn wraps
    // it with an ERR_MODULE_NOT_FOUND cause). Any other failure is a real layout
    // problem and must surface rather than silently deploy an uninspectable model.
    const cause = (e as { cause?: NodeJS.ErrnoException })?.cause;
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    if (!warnedNoLayout) {
      warnedNoLayout = true;
      console.warn(
        `[@nanobpm/workflow] Deploying "${wf.id}" without a diagram: the optional ` +
          '"bpmn-auto-layout" dependency is not installed, so the model will be ' +
          "uninspectable in a modeller/Operate. Install it for diagram layout: " +
          "npm i bpmn-auto-layout",
      );
    }
    return semantic;
  }
}


/**
 * The subset of the `@nanobpm/nano-sdk` (Camunda orchestration-cluster) client
 * that the workflow surface uses. `createCamundaClient` returns a superset of
 * this, so a test — or an author bringing their own transport (e.g. the embedded
 * engine) — can inject any object satisfying it.
 */
export interface NanoSdkClient {
  createDeployment(
    input: { resources: File[]; [k: string]: unknown },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  createProcessInstance(
    input: { processDefinitionId: string; variables?: JsonObject },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  correlateMessage(
    input: { name: string; correlationKey: string; variables?: JsonObject },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  getProcessInstance(
    input: { processInstanceKey: string },
    consistency: { consistency: { waitUpToMs: number } },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  createJobWorker(cfg: JobWorkerConfig): NanoJobWorker;
}

/** Config for a nano-sdk job worker (the subset the Worker runtime sets). */
export interface JobWorkerConfig {
  jobType: string;
  jobHandler: (job: ActivatedJob) => Promise<unknown> | unknown;
  workerName?: string;
  maxParallelJobs?: number;
  /** Job lock timeout in ms. */
  jobTimeoutMs?: number;
  /** Long-poll timeout in ms. */
  pollTimeoutMs?: number;
  /** Start polling immediately. The Worker runtime sets this false and starts explicitly. */
  autoStart?: boolean;
}

/** The handle returned by `createJobWorker`. */
export interface NanoJobWorker {
  start(): void;
  stop(): void | Promise<void>;
  stopGracefully?(opts?: { waitUpToMs?: number }): Promise<void>;
}

/** An activated job as delivered to a nano-sdk job handler: the workflow `Job`
 *  fields plus the acknowledgement actions. */
export type ActivatedJob = Job & {
  complete(variables?: JsonObject): Promise<unknown>;
  fail(body: { errorMessage: string; retries?: number }): Promise<unknown>;
};

export interface WorkflowClientOptions {
  /** Base URL of the nanobpmn gateway, e.g. `http://localhost:8080`. The nano-sdk
   *  client normalises this to the `/v2` REST address. */
  baseUrl?: string;
  /** Bearer token for the gateway (CAMUNDA_TOKEN). */
  token?: string;
  /** Transport mode passed to `createCamundaClient`: "auto" | "falcon" | "rest".
   *  Default "auto" (Falcon on a Nano server, REST elsewhere). */
  transport?: "auto" | "falcon" | "rest";
  /** Inject a pre-built nano-sdk client (or a compatible fake) instead of
   *  constructing one from `baseUrl`. Useful for tests, the embedded transport,
   *  and advanced authors who build the client themselves. */
  client?: NanoSdkClient;
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

/** Normalise a thrown SDK/transport error into a WorkflowError, preserving an
 *  HTTP status when the SDK attached one. */
function asWorkflowError(e: unknown, what: string): WorkflowError {
  if (e instanceof WorkflowError) return e;
  const err = e as { message?: string; status?: number; response?: { status?: number } };
  const status = err?.status ?? err?.response?.status;
  return new WorkflowError(`${what} failed: ${err?.message ?? String(e)}`, status);
}

export class WorkflowClient {
  /** The underlying nano-sdk client. Exposed so the Worker runtime and app
   *  authors can reach the full engine surface (user tasks, decisions, signals,
   *  messages, …) through the same transport (ADR 0055). */
  readonly sdk: NanoSdkClient;

  constructor(opts: WorkflowClientOptions) {
    if (opts?.client) {
      this.sdk = opts.client;
      return;
    }
    if (!opts?.baseUrl) throw new Error("WorkflowClient needs a baseUrl or a client");
    this.sdk = createCamundaClient({
      config: {
        CAMUNDA_REST_ADDRESS: opts.baseUrl.replace(/\/+$/, ""),
        ...(opts.token ? { CAMUNDA_TOKEN: opts.token } : {}),
        CAMUNDA_TRANSPORT: opts.transport ?? "auto",
      },
    }) as unknown as NanoSdkClient;
  }

  /**
   * Deploy a workflow's derived BPMN model. The deployed model includes
   * auto-generated diagram interchange (DI) so it is inspectable in a
   * modeller/Operate; pass `{ layout: false }` to deploy the DI-less semantic
   * model. DI needs the optional `bpmn-auto-layout` dependency — see
   * `toDeployableBpmn` for the graceful-degradation behaviour when it is absent.
   */
  async deploy(wf: Workflow, opts: { layout?: boolean } = {}): Promise<DeployResult> {
    const xml = await toDeployableBpmn(wf, opts);
    const file = new File([xml], `${wf.id}.bpmn`, { type: "text/xml" });
    try {
      return (await this.sdk.createDeployment({ resources: [file] })) as DeployResult;
    } catch (e) {
      throw asWorkflowError(e, "deploy");
    }
  }

  /**
   * Start a workflow instance. For imperative workflows the engine variables are
   * seeded with `{ input, journal: {}, wfDone: false }` (the replay state); for
   * declarative flows `input` becomes the instance variables directly.
   */
  async start(wf: Workflow, input: JsonObject = {}): Promise<StartResult> {
    const variables: JsonObject =
      wf.kind === "imperative" ? { input, journal: {}, wfDone: false } : input;
    try {
      return (await this.sdk.createProcessInstance({
        processDefinitionId: wf.id,
        variables,
      })) as StartResult;
    } catch (e) {
      throw asWorkflowError(e, "start");
    }
  }

  /** Correlate a signal to a parked declarative `signal` step. Fails fast on an
   *  unknown signal name (a typo would otherwise send an uncorrelatable message
   *  that the gateway silently drops). */
  async signal(
    flow: DeclarativeFlow,
    signalName: string,
    correlationKey: string,
    variables: JsonObject = {},
  ): Promise<JsonObject> {
    // Signal steps can live anywhere in the tree (inside switch/branch/loop),
    // so walk the whole flow, not just the top-level sequence.
    const signals: string[] = [];
    walkNodes(flow.steps, (n) => {
      if (n.kind === "signal") signals.push(n.name);
    });
    if (!signals.includes(signalName)) {
      throw new WorkflowError(
        `unknown signal "${signalName}" on flow "${flow.id}" — declared signals: ${
          signals.length ? signals.map((s) => `"${s}"`).join(", ") : "(none)"
        }`,
      );
    }
    try {
      return (await this.sdk.correlateMessage({
        name: messageName(flow.id, signalName),
        correlationKey,
        variables,
      })) as JsonObject;
    } catch (e) {
      throw asWorkflowError(e, `signal "${signalName}"`);
    }
  }

  /** Fetch an instance (used by demos/tests to observe completion). Reads with
   *  zero-wait consistency; returns null when the instance is not (yet) visible. */
  async getInstance(processInstanceKey: string): Promise<JsonObject | null> {
    try {
      return (await this.sdk.getProcessInstance(
        { processInstanceKey },
        { consistency: { waitUpToMs: 0 } },
      )) as JsonObject;
    } catch {
      return null;
    }
  }
}
