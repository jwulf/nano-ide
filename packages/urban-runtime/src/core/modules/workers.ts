// workers — load each declared worker's handler module and register it as a push worker
// on the engine. Handlers are resolved by a small, documented contract and are injected
// with the app's runtime API (datasource + engine + host utils).

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import type { EngineJob, JobHandler, WorkerSubscription } from "../host.ts";
import { workerJobType, type WorkerDecl } from "../manifest.ts";

/** A handler as authored by an app: the job plus the injected app API. */
export type AppJobHandler = (
  job: EngineJob,
  app: AppApi,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/**
 * Resolve a handler for `jobType` from a loaded module, in priority order:
 *   1. `handlers[jobType]`            (a map keyed by job type — the multi-type module case)
 *   2. a named export matching jobType (or its last dotted segment)
 *   3. `default` (when it is a function)
 */
export function resolveHandler(
  mod: Record<string, unknown>,
  jobType: string,
): AppJobHandler | undefined {
  const map = mod.handlers as Record<string, unknown> | undefined;
  if (map && typeof map[jobType] === "function") return map[jobType] as AppJobHandler;
  const seg = jobType.includes(".") ? jobType.slice(jobType.lastIndexOf(".") + 1) : jobType;
  if (typeof mod[jobType] === "function") return mod[jobType] as AppJobHandler;
  if (map && typeof map[seg] === "function") return map[seg] as AppJobHandler;
  if (typeof mod[seg] === "function") return mod[seg] as AppJobHandler;
  if (typeof mod.default === "function") return mod.default as AppJobHandler;
  return undefined;
}

export interface WorkersHandle extends Mounted {
  readonly jobTypes: string[];
}

/** Load handler modules and register a push worker per declared worker. */
export async function mountWorkers(ctx: RuntimeContext, app: AppApi): Promise<WorkersHandle> {
  const decls = ctx.manifest.workers ?? [];
  const subs: WorkerSubscription[] = [];
  const jobTypes: string[] = [];

  // Cache module loads so a multi-type handler module is imported once.
  const moduleCache = new Map<string, Record<string, unknown>>();
  const joinRoot = (p: string): string =>
    p.startsWith("/") ? p : `${ctx.root.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  const loadModule = async (path: string): Promise<Record<string, unknown>> => {
    const key = joinRoot(path);
    const cached = moduleCache.get(key);
    if (cached) return cached;
    const mod = await ctx.host.importModule(key);
    moduleCache.set(key, mod);
    return mod;
  };

  for (const decl of decls as WorkerDecl[]) {
    const jobType = workerJobType(decl);
    if (!jobType) continue;
    const mod = await loadModule(decl.handler);
    const handler = resolveHandler(mod, jobType);
    if (!handler) {
      throw new Error(
        `worker "${jobType}": ${decl.handler} exports no handler for it ` +
          `(expected handlers["${jobType}"], a named export, or a default function)`,
      );
    }
    const wrapped: JobHandler = (job) => handler(job, app);
    const sub = await ctx.engine.registerWorker(jobType, wrapped, {
      workerName: `${ctx.manifest.id}:${jobType}`,
    });
    subs.push(sub);
    jobTypes.push(jobType);
    ctx.host.log("info", "worker registered", { jobType, handler: decl.handler });
  }

  return {
    name: "workers",
    jobTypes,
    async stop() {
      // Graceful unsubscribe on exit (defensive against the Falcon dead-subscriber stall).
      await Promise.allSettled(subs.map((s) => s.unsubscribe()));
    },
    describe: () => ({ jobTypes }),
  };
}
