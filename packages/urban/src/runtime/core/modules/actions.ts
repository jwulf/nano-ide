// actions — per-app action handler files (ADR 0055 phase 3). The pages surface serves
// generic start/cancel/message actions; a real app usually needs to wrap those with
// business logic (register a domain row before starting, reconcile app-owned rest state
// on cancel, correlate a message to an aggregate). An app declares such overrides in the
// manifest `actions[]` and authors a small module per action. Each module is injected with
// the app's `AppApi` (typed datasource + engine + sdk + host utils) — the same contract as
// a worker handler — so the handler code reads exactly like the app's own service layer.
//
// Precedence: action routes are mounted BEFORE the generic pages action routes (the router
// is first-match-wins), so an override at `/app/actions/cancel` shadows the generic one,
// while an unmatched process still falls through to the generic `/app/actions/start/` route.

import type { AppApi, RuntimeContext } from "../context.ts";
import type { HttpRequest } from "../host.ts";
import type { ActionDecl } from "../manifest.ts";
import { json, normalizeRoutePath, type Route } from "../router.ts";

/** The request handed to an action handler: the raw request plus its parsed JSON body. */
export interface ActionRequest {
  /** The raw HTTP request (method, path, query, headers). */
  req: HttpRequest;
  /**
   * The request body parsed as JSON (`{}` when the body is empty). A body that is present
   * but not valid JSON is rejected with `400` before the handler runs.
   */
  body: unknown;
}

/** What an action handler returns; the runtime serializes `body` as JSON. */
export interface ActionResult {
  /** HTTP status. Default `200`, or `204` when the handler returns nothing. */
  status?: number;
  /** Response payload, serialized as JSON. Omit for an empty response. */
  body?: unknown;
  /** Response headers merged over `content-type: application/json`. */
  headers?: Record<string, string>;
}

/**
 * An app-authored action handler: the parsed request plus the injected app API. Return an
 * {@link ActionResult}, or nothing for an empty `204`. Throwing yields a `500` with the
 * error message.
 */
export type ActionHandler = (
  input: ActionRequest,
  app: AppApi,
) => Promise<ActionResult | void> | ActionResult | void;

/**
 * Resolve an action handler from a loaded module, in priority order:
 *   1. `default` (when it is a function — the common one-handler-per-file case)
 *   2. a named export `handler`
 */
export function resolveActionHandler(mod: Record<string, unknown>): ActionHandler | undefined {
  if (typeof mod.default === "function") return mod.default as ActionHandler;
  if (typeof mod.handler === "function") return mod.handler as ActionHandler;
  return undefined;
}

export interface ActionsHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

/**
 * Mount the declared action handlers. Each declaration contributes one route; the handler
 * module is imported lazily (and cached) on first request, so a missing or malformed module
 * surfaces as a clear `500` on that route rather than failing the whole boot.
 */
export function mountActions(ctx: RuntimeContext, app: AppApi): ActionsHandle {
  const decls = (ctx.manifest.actions ?? []) as ActionDecl[];
  const routes: Route[] = [];
  const mounted: Array<{ path: string; method: string; module: string; prefix: boolean }> = [];

  const joinRoot = (p: string): string =>
    p.startsWith("/") ? p : `${ctx.root.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;

  // Cache module loads so a module reused across several declarations is imported once.
  const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
  const loadModule = (path: string): Promise<Record<string, unknown>> => {
    const key = joinRoot(path);
    let pending = moduleCache.get(key);
    if (!pending) {
      // Evict the entry if the import rejects, so a transient failure doesn't
      // permanently wedge the route (a cached rejected Promise would reject forever).
      pending = ctx.host.importModule(key).catch((err) => {
        moduleCache.delete(key);
        throw err;
      });
      moduleCache.set(key, pending);
    }
    return pending;
  };

  for (const decl of decls) {
    if (!decl?.path || !decl?.module) {
      ctx.host.log("warn", "skipping action: needs both `path` and `module`", {
        action: decl as unknown as Record<string, unknown>,
      });
      continue;
    }
    const method = (decl.method ?? "POST").toUpperCase();
    const prefix = decl.prefix === true;
    // The router's prefix match is a raw `startsWith`, so a prefix route needs a trailing
    // slash to stay boundary-safe (otherwise "/hooks" would also match "/hooks2"). Exact
    // routes keep the normalized (trailing-slash-stripped) path. Guard the root case so a
    // prefix path of "/" doesn't become "//" (which would never match).
    const base = normalizeRoutePath(decl.path, decl.path);
    const path = prefix ? (base.endsWith("/") ? base : `${base}/`) : base;

    routes.push({
      method,
      path,
      prefix,
      source: `actions:${decl.module}`,
      handler: async (req: HttpRequest) => {
        const raw = await req.text();
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json({ error: "request body must be JSON" }, 400);
        }

        let handler: ActionHandler | undefined;
        try {
          handler = resolveActionHandler(await loadModule(decl.module));
        } catch (e) {
          ctx.host.log("error", "action handler module failed to load", {
            path,
            module: decl.module,
            error: String((e as Error)?.message ?? e),
          });
          return json({ error: `action handler ${decl.module} failed to load` }, 500);
        }
        if (!handler) {
          return json(
            { error: `action handler ${decl.module} exports no default function or named \`handler\`` },
            500,
          );
        }

        try {
          const result = await handler({ req, body }, app);
          if (!result) return { status: 204 };
          return {
            status: result.status ?? 200,
            headers: { "content-type": "application/json", ...(result.headers ?? {}) },
            body: result.body === undefined ? undefined : JSON.stringify(result.body),
          };
        } catch (e) {
          return json({ error: String((e as Error)?.message ?? e) }, 500);
        }
      },
    });
    mounted.push({ path, method, module: decl.module, prefix });
  }

  return { name: "actions", routes, describe: () => ({ actions: mounted }) };
}
