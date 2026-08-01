// The Worker runtime — hosts one or more workflows against a gateway and drives
// them: long-polls each derived job type, dispatches jobs to handlers, completes
// them. It generalises the two surfaces:
//
//   - a declarative flow contributes one job type per `run` step, dispatched to
//     the user handler (external `task` steps are intentionally NOT hosted here —
//     a worker outside this program serves them);
//   - an imperative workflow contributes its single orchestrator job type,
//     dispatched to the replay engine (which advances the journal one step).
//
// It is resilient to the gateway disappearing (each poll loop backs off and
// reconnects on its own), so it survives an engine crash/restart — the property
// the ADR 0044 spike proved.

import { WorkflowClient } from "./client.js";
import { replayOnce } from "./imperative.js";
import { walkNodes } from "./declarative.js";
import type { Job, JsonObject, Workflow } from "./types.js";
import { jobType } from "./xml.js";

/** Fired after a job completes; purely observational. */
export interface ActivityEvent {
  workflowId: string;
  type: string;
  jobKey: string;
  elementId: string;
  /** For an imperative orchestrator turn: the journalled step key, or "__done". */
  step?: string;
}

export interface WorkerOptions {
  /** Provide a baseUrl (a client is created) or an existing client. */
  baseUrl?: string;
  client?: WorkflowClient;
  workflows: Workflow[];
  /** Worker name reported to the gateway. Default "nanobpm-workflow". */
  name?: string;
  /** Long-poll timeout per activation, ms. Also bounds stop() latency. Default 10000. */
  pollTimeoutMs?: number;
  /** Job lock timeout, ms. Default 30000. */
  jobTimeoutMs?: number;
  /** Backoff after a transport error, ms. Default 500. */
  backoffMs?: number;
  onActivity?: (e: ActivityEvent) => void | Promise<void>;
  onError?: (err: Error, context: { type: string }) => void;
}

type Handler = (job: Job) => Promise<{ variables: JsonObject; step?: string }>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Worker {
  private readonly client: WorkflowClient;
  private readonly name: string;
  private readonly pollTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly backoffMs: number;
  private readonly onActivity?: WorkerOptions["onActivity"];
  private readonly onError?: WorkerOptions["onError"];
  /** job type → { workflowId, handle } */
  private readonly routes = new Map<string, { workflowId: string; handle: Handler }>();
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(opts: WorkerOptions) {
    this.client = opts.client ?? new WorkflowClient({ baseUrl: requireBaseUrl(opts) });
    this.name = opts.name ?? "nanobpm-workflow";
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 10000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 30000;
    this.backoffMs = opts.backoffMs ?? 500;
    this.onActivity = opts.onActivity;
    this.onError = opts.onError;
    for (const wf of opts.workflows) this.register(wf);
  }

  private register(wf: Workflow): void {
    if (wf.kind === "imperative") {
      this.addRoute(wf.orchestrateType, {
        workflowId: wf.id,
        handle: async (job) => {
          const input = (job.variables.input as JsonObject) ?? {};
          const journal = (job.variables.journal as JsonObject) ?? {};
          const step = await replayOnce(wf, input, journal);
          if (step.done) return { variables: { wfDone: true } as JsonObject, step: "__done" };
          const next = { ...journal, [step.frontier.key]: step.frontier.result };
          return { variables: { journal: next, wfDone: false } as JsonObject, step: step.frontier.key };
        },
      });
    } else {
      // Walk the flow tree; only `run` steps are hosted locally. `signal`
      // (message catch) and `task` (external worker) contribute no in-process
      // route, and structural combinators (`switch`/`branch`/`loop`) are pure
      // routing with no job of their own.
      walkNodes(wf.steps, (s) => {
        if (s.kind !== "run") return;
        const handler = wf.handlers[s.name];
        if (typeof handler !== "function") {
          // `DeclarativeFlow` is a public type; a consumer-constructed flow could
          // carry a `run` step with no handler. Fail fast at registration with a
          // clear message rather than a `handler is not a function` TypeError on
          // the first job activation.
          throw new Error(
            `workflow "${wf.id}": run step "${s.name}" has no handler function`,
          );
        }
        this.addRoute(jobType(wf.id, s.name), {
          workflowId: wf.id,
          handle: async (job) => ({ variables: ((await handler(job)) ?? {}) as JsonObject }),
        });
      });
    }
  }

  /** Register a derived job type, failing fast on a collision. Two workflows can
   *  resolve to the same job type (duplicate workflow ids, or a declarative step
   *  name that collides with another workflow's); silently overwriting the route
   *  would drop a handler, so we reject it at construction time. */
  private addRoute(type: string, route: { workflowId: string; handle: Handler }): void {
    const existing = this.routes.get(type);
    if (existing) {
      throw new Error(
        `duplicate derived job type "${type}": workflows "${existing.workflowId}" and "${route.workflowId}" ` +
          `resolve to the same job type (check for duplicate workflow ids or colliding step names)`,
      );
    }
    this.routes.set(type, route);
  }

  /** Invoke the onError observer hook without letting it affect the poll loop —
   *  a throwing observer must not permanently stop a route. */
  private emitError(err: Error, type: string): void {
    try {
      this.onError?.(err, { type });
    } catch {
      /* observer hooks are purely observational; swallow their failures */
    }
  }

  /** Invoke the onActivity observer hook in isolation. It runs after the job has
   *  already been completed, so a throwing observer must not fall into the
   *  failure path and try to fail an already-completed job. */
  private async emitActivity(e: ActivityEvent): Promise<void> {
    try {
      await this.onActivity?.(e);
    } catch {
      /* observational only; swallow so it never triggers failJob */
    }
  }

  /** The derived job types this worker serves. */
  get servedTypes(): string[] {
    return [...this.routes.keys()];
  }

  /** Begin polling. Resolves once the loops are running (they run until stop()). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [...this.routes.entries()].map(([type, route]) => this.pollLoop(type, route));
  }

  /** Stop polling and wait for in-flight loops to unwind (≤ pollTimeoutMs). */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async pollLoop(type: string, route: { workflowId: string; handle: Handler }): Promise<void> {
    while (this.running) {
      let jobs: Job[] = [];
      try {
        jobs = await this.client.activateJobs(type, {
          worker: this.name,
          maxJobsToActivate: 1,
          timeout: this.jobTimeoutMs,
          requestTimeout: this.pollTimeoutMs,
        });
      } catch (e) {
        // Transport/gateway error (e.g. engine restarting): back off, reconnect.
        this.emitError(e as Error, type);
        await sleep(this.backoffMs);
        continue;
      }
      for (const job of jobs) {
        if (!this.running) break;
        try {
          const { variables, step } = await route.handle(job);
          await this.client.completeJob(job.jobKey, variables);
          // Job is now completed; the observer hook is isolated (emitActivity
          // swallows its own errors) so it can never fall into the failure path.
          await this.emitActivity({
            workflowId: route.workflowId,
            type,
            jobKey: job.jobKey,
            elementId: job.elementId,
            step,
          });
        } catch (e) {
          // A handler or completion failed. Report; the engine will redeliver the
          // job after its lock times out (at-least-once → handlers must be
          // idempotent). Best-effort surface it as an incident-worthy failure.
          this.emitError(e as Error, type);
          try {
            await this.client.failJob(job.jobKey, (e as Error).message, 0);
          } catch {
            /* engine may be down; the lock will expire and redeliver */
          }
        }
      }
    }
  }
}

function requireBaseUrl(opts: WorkerOptions): string {
  if (!opts.baseUrl) throw new Error("Worker needs either options.client or options.baseUrl");
  return opts.baseUrl;
}
