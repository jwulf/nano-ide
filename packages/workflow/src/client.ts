// A thin, dependency-free client for a running nanobpmn gateway (REST v2):
// deploy a workflow's derived model, start instances, correlate signals, and the
// low-level job activate/complete/fail used by the Worker runtime.

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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkflowClientOptions {
  /** Base URL of the nanobpmn gateway, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). Useful for tests/proxies. */
  fetch?: FetchLike;
}

export interface ActivateOptions {
  worker: string;
  maxJobsToActivate?: number;
  /** Job timeout in ms (how long the worker holds the job). Default 30000. */
  timeout?: number;
  /** Long-poll timeout in ms; `< 0` disables long-poll. Default 15000. */
  requestTimeout?: number;
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

export class WorkflowClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: WorkflowClientOptions) {
    if (!opts?.baseUrl) throw new Error("WorkflowClient needs a baseUrl");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("no fetch available; pass options.fetch (Node < 18)");
    this.fetchImpl = f;
  }

  private async json<T>(path: string, init: RequestInit, what: string): Promise<T> {
    const res = await this.send(path, init, what);
    return (await res.json()) as T;
  }

  /** Perform a request, throwing WorkflowError on transport error or !ok, and
   *  return the raw Response (for endpoints with an empty/no-content body). */
  private async send(path: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new WorkflowError(`${what} transport error: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new WorkflowError(`${what} failed: ${res.status}`, res.status, body);
    }
    return res;
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
    const form = new FormData();
    form.append("resources", new Blob([xml], { type: "text/xml" }), `${wf.id}.bpmn`);
    return this.json<DeployResult>(`/v2/deployments`, { method: "POST", body: form }, "deploy");
  }

  /**
   * Start a workflow instance. For imperative workflows the engine variables are
   * seeded with `{ input, journal: {}, wfDone: false }` (the replay state); for
   * declarative flows `input` becomes the instance variables directly.
   */
  async start(wf: Workflow, input: JsonObject = {}): Promise<StartResult> {
    const variables: JsonObject =
      wf.kind === "imperative" ? { input, journal: {}, wfDone: false } : input;
    return this.json<StartResult>(
      `/v2/process-instances`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processDefinitionId: wf.id, variables }),
      },
      "start",
    );
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
    return this.json<JsonObject>(
      `/v2/messages/correlation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: messageName(flow.id, signalName), correlationKey, variables }),
      },
      `signal "${signalName}"`,
    );
  }

  /** Fetch an instance (used by demos/tests to observe completion). */
  async getInstance(processInstanceKey: string): Promise<JsonObject | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v2/process-instances/${processInstanceKey}`);
      if (!res.ok) return null;
      return (await res.json()) as JsonObject;
    } catch {
      return null;
    }
  }

  // --- low-level job protocol (used by the Worker runtime) -------------------

  async activateJobs(type: string, opts: ActivateOptions): Promise<Job[]> {
    const body = {
      type,
      worker: opts.worker,
      maxJobsToActivate: opts.maxJobsToActivate ?? 1,
      timeout: opts.timeout ?? 30000,
      requestTimeout: opts.requestTimeout ?? 15000,
    };
    const res = await this.json<{ jobs?: Job[] }>(
      `/v2/jobs/activation`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      `activate ${type}`,
    );
    return res.jobs ?? [];
  }

  async completeJob(jobKey: string, variables: JsonObject = {}): Promise<void> {
    await this.send(
      `/v2/jobs/${jobKey}/completion`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variables }) },
      "complete job",
    );
  }

  async failJob(jobKey: string, errorMessage: string, retries = 0): Promise<void> {
    await this.send(
      `/v2/jobs/${jobKey}/failure`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ errorMessage, retries }) },
      "fail job",
    );
  }
}
