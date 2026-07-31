// A REST-backed EngineClient using only global `fetch`/`FormData`/`AbortController` — all
// present in both Node 18+ and Deno, so this stays runtime-agnostic. Workers drain via the
// v2 job-activation long-poll (no Falcon push dependency); the SDK-backed client can add
// the push path later behind the same EngineClient seam.

import type {
  EngineClient,
  EngineJob,
  JobHandler,
  WorkerSubscription,
} from "../core/host.ts";

export interface RestEngineOptions {
  /** Base URL including the /v2 suffix, e.g. http://localhost:8080/v2. */
  baseUrl: string;
  /** Optional bearer token. */
  token?: string;
  /** Long-poll request timeout (ms) for job activation. Default 15000. */
  longPollMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

function normBase(u: string): string {
  const t = u.replace(/\/+$/, "");
  return /\/v\d+$/.test(t) ? t : `${t}/v2`;
}

export class RestEngineClient implements EngineClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly longPollMs: number;
  private readonly log: NonNullable<RestEngineOptions["log"]>;
  private readonly subs = new Set<{ stop: () => void }>();

  constructor(opts: RestEngineOptions) {
    this.base = normBase(opts.baseUrl);
    this.token = opts.token;
    this.longPollMs = opts.longPollMs ?? 15000;
    this.log = opts.log ?? (() => {});
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async req(path: string, body: unknown, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
    return res;
  }

  private async okJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.req(path, body);
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async deployResources(
    resources: { name: string; content: string; contentType: string }[],
  ): Promise<{ deployed: number }> {
    const form = new FormData();
    for (const r of resources) {
      form.append("resources", new Blob([r.content], { type: r.contentType }), r.name);
    }
    const headers: Record<string, string> = {};
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    const res = await fetch(`${this.base}/deployments`, { method: "POST", headers, body: form });
    if (!res.ok) {
      throw new Error(`deploy → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return { deployed: resources.length };
  }

  async createInstance(input: {
    processDefinitionId: string;
    variables?: Record<string, unknown>;
    awaitCompletion?: boolean;
  }): Promise<{ processInstanceKey: string; variables?: Record<string, unknown> }> {
    const r = await this.okJson<{ processInstanceKey?: string; key?: string; variables?: Record<string, unknown> }>(
      "/process-instances",
      {
        processDefinitionId: input.processDefinitionId,
        variables: input.variables ?? {},
        awaitCompletion: input.awaitCompletion ?? false,
      },
    );
    return { processInstanceKey: String(r.processInstanceKey ?? r.key ?? ""), variables: r.variables };
  }

  async publishMessage(input: {
    name: string;
    correlationKey?: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    await this.okJson("/messages/publication", {
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
    const r = await this.okJson<{ items?: Record<string, unknown>[] }>("/user-tasks/search", {
      filter: filter ?? {},
    });
    return (r.items ?? []).map((it) => ({
      userTaskKey: String(it.userTaskKey ?? it.key ?? ""),
      elementId: it.elementId as string | undefined,
      variables: it.variables as Record<string, unknown> | undefined,
    }));
  }

  async completeUserTask(userTaskKey: string, variables?: Record<string, unknown>): Promise<void> {
    const res = await this.req(`/user-tasks/${userTaskKey}/completion`, { variables: variables ?? {} });
    if (!res.ok && res.status !== 204) {
      throw new Error(`complete user-task → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  async registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription> {
    const workerName = options?.workerName ?? `urban:${jobType}`;
    const maxJobs = options?.maxParallelJobs ?? 8;
    let running = true;
    const control = { stop: () => (running = false) };
    this.subs.add(control);

    const activateOnce = async (): Promise<Record<string, unknown>[]> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.longPollMs + 5000);
      try {
        const res = await this.req(
          "/jobs/activation",
          {
            type: jobType,
            worker: workerName,
            timeout: 5 * 60 * 1000,
            maxJobsToActivate: maxJobs,
            requestTimeout: this.longPollMs,
            fetchVariable: options?.fetchVariables ?? [],
          },
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          if (res.status !== 408) {
            this.log("warn", `activation ${jobType} → ${res.status}`);
          }
          return [];
        }
        const body = (await res.json()) as { jobs?: Record<string, unknown>[] };
        return body.jobs ?? [];
      } catch (err) {
        if (running) this.log("warn", `activation ${jobType} error`, { err: String(err) });
        return [];
      } finally {
        clearTimeout(timer);
      }
    };

    const runOne = async (raw: Record<string, unknown>): Promise<void> => {
      const key = String(raw.jobKey ?? raw.key ?? "");
      const job: EngineJob = {
        jobKey: key,
        jobType,
        processInstanceKey: raw.processInstanceKey ? String(raw.processInstanceKey) : undefined,
        elementId: raw.elementId as string | undefined,
        variables: (raw.variables as Record<string, unknown>) ?? {},
      };
      try {
        const out = await handler(job);
        const res = await this.req(`/jobs/${key}/completion`, { variables: out ?? {} });
        if (!res.ok && res.status !== 204) {
          this.log("warn", `complete ${jobType} → ${res.status}`);
        }
      } catch (err) {
        await this.req(`/jobs/${key}/failure`, {
          retries: 0,
          errorMessage: String(err).slice(0, 500),
        }).catch(() => {});
        this.log("error", `handler ${jobType} threw`, { err: String(err) });
      }
    };

    const loop = async (): Promise<void> => {
      while (running) {
        const jobs = await activateOnce();
        if (!running) break;
        if (jobs.length === 0) continue;
        await Promise.all(jobs.map(runOne));
      }
    };
    void loop();

    return {
      jobType,
      unsubscribe: async () => {
        control.stop();
        this.subs.delete(control);
      },
    };
  }

  async close(): Promise<void> {
    for (const s of this.subs) s.stop();
    this.subs.clear();
  }
}
