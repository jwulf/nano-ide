// triggers — the inbound I/O edge (ADR 0025). Turns each `webhook` trigger in the manifest
// into an HTTP route that verifies the request, maps the payload, and publishes the declared
// message to the engine for correlation. HMAC verification uses Web Crypto (global in both
// Node 18+ and Deno), so this stays runtime-agnostic.

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import type { HttpRequest } from "../host.ts";
import { json, normalizeRoutePath, type Route } from "../router.ts";
import type { TriggerDecl } from "../manifest.ts";
import { nextCronFire, parseCron } from "./cron.ts";

export interface TriggersHandle extends Mounted {
  routes: Route[];
}

/** Injectable timer + clock seam so cron scheduling is deterministic under test. */
export interface SchedulerDeps {
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Current wall-clock time in ms since epoch. */
  now: () => number;
}

type Scope = { body: unknown; headers: Record<string, string>; query: Record<string, string> };

/**
 * Resolve a tiny FEEL-ish expression against the event scope: a `= body.a.b` path walk
 * returns the raw value at that path (or `undefined` if any segment is missing); a literal
 * (non-`=`) string is returned verbatim.
 */
export function resolveExpr(expr: string, scope: Scope): unknown {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("=")) return trimmed; // literal
  const pathExpr = trimmed.slice(1).trim(); // e.g. "body.taskId"
  let cur: unknown = scope;
  for (const seg of pathExpr.split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Evaluate a correlation expression to a string key: `= body.a.b`, or a literal string. */
export function evalCorrelation(expr: string | undefined, scope: Scope): string | undefined {
  if (!expr) return undefined;
  const cur = resolveExpr(expr, scope);
  return cur == null ? undefined : String(cur);
}

/**
 * Resolve `action.variables` to the record handed to the engine (schema: a FEEL string over
 * the event body — `#/$defs/triggerAction.variables`). A `= body.<path>` expression must
 * resolve to an object; a plain object literal is accepted for convenience; anything else
 * (missing, or a non-object result) falls back to the raw event body when that is an object,
 * else `{}`.
 */
export function resolveActionVariables(
  expr: unknown,
  scope: Scope,
): Record<string, unknown> {
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

  if (typeof expr === "string") {
    return asRecord(resolveExpr(expr, scope)) ?? asRecord(scope.body) ?? {};
  }
  // Back-compat: an inline object literal used directly as the variables.
  return asRecord(expr) ?? asRecord(scope.body) ?? {};
}

async function verifyHmac(secret: string, body: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const provided = signature.replace(/^sha256=/, "").trim().toLowerCase();
  // Constant-time-ish compare.
  if (provided.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/** Env var holding the secret for an `hmac:<connection>` auth ref. */
function secretEnvName(connection: string): string {
  return `URBAN_TRIGGER_SECRET_${connection.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function headerRecord(req: HttpRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

/**
 * Fire a trigger's action against the engine: start a process or publish a message
 * (ADR 0025 §1). `scope` supplies the event body/headers/query for FEEL-ish resolution
 * of `correlationKey`/`variables`; cron passes an empty body. Returns what was done.
 */
export async function runTriggerAction(
  app: AppApi,
  action: TriggerDecl["action"],
  scope: Scope,
): Promise<{ kind: "start" | "message" | "none"; target?: string; correlationKey?: string }> {
  if (!action) return { kind: "none" };
  const variables = resolveActionVariables(action.variables, scope);

  if (action.start) {
    await app.engine.createInstance({ processDefinitionId: action.start, variables });
    return { kind: "start", target: action.start };
  }
  if (action.message) {
    const correlationKey = evalCorrelation(action.correlationKey, scope);
    await app.engine.publishMessage({ name: action.message, correlationKey, variables });
    return { kind: "message", target: action.message, correlationKey };
  }
  return { kind: "none" };
}

const emptyScope = { body: {}, headers: {} as Record<string, string>, query: {} as Record<string, string> };

/** Default (live) scheduler seam, backed by the global timer functions. */
function defaultScheduler(): SchedulerDeps {
  return {
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

/** Mount webhook + cron triggers. Webhooks contribute HTTP routes; cron triggers arm
 *  background timers that fire their action on schedule. `stop()` clears every timer. */
export function mountTriggers(
  ctx: RuntimeContext,
  app: AppApi,
  sched: SchedulerDeps = defaultScheduler(),
): TriggersHandle {
  const routes: Route[] = [];
  const mounted: string[] = [];
  const scheduled: string[] = [];
  const seenDeliveries = new Set<string>();
  const timers = new Set<unknown>();
  let stopped = false;

  // Arm a cron trigger: compute the next UTC fire, sleep until it, fire the action, repeat.
  const armCron = (trig: TriggerDecl): void => {
    const spec = trig.spec;
    if (!spec) {
      ctx.host.log("warn", `trigger "${trig.id}": cron trigger has no spec, skipped`);
      return;
    }
    let schedule;
    try {
      schedule = parseCron(spec);
    } catch (e) {
      app.log("error", `trigger "${trig.id}": invalid cron spec "${spec}": ${String(e)}`);
      return;
    }
    if (!trig.action?.start && !trig.action?.message) {
      // A timer that can never do anything is pure waste — don't arm it (unlike a webhook,
      // which is request-driven and costs nothing while idle).
      app.log("warn", `trigger "${trig.id}": cron trigger has no action.start/message; not scheduled`);
      return;
    }
    if (trig.onMissed && trig.onMissed !== "skip") {
      // once/all catch-up needs a durable last-fire timestamp the runtime does not persist;
      // without it, honour the safe default (skip) and say so rather than silently dropping.
      app.log("warn", `trigger "${trig.id}": onMissed="${trig.onMissed}" not supported without ` +
        `durable trigger state; scheduling forward as "skip"`);
    }
    // Probe the first fire before recording the trigger as scheduled, so an impossible spec
    // (e.g. Feb 30) is reported honestly and never shows up in describe()/startup logs.
    if (!nextCronFire(schedule, new Date(sched.now()))) {
      app.log("warn", `trigger "${trig.id}": cron spec "${spec}" never fires; not scheduled`);
      return;
    }
    scheduled.push(`${trig.id}@${spec}`);

    const arm = (): void => {
      if (stopped) return;
      const next = nextCronFire(schedule, new Date(sched.now()));
      if (!next) return; // spec became unsatisfiable (defensive; the probe above already vetted it)
      const delay = Math.max(0, next.getTime() - sched.now());
      // Declare `handle` before arming so the callback can reference it even if a scheduler
      // double invokes it synchronously (avoids a TDZ ReferenceError on `timers.delete`).
      let handle: unknown;
      handle = sched.setTimer(() => {
        timers.delete(handle);
        if (stopped) return;
        void (async () => {
          try {
            const res = await runTriggerAction(app, trig.action, {
              ...emptyScope,
              body: { firedAt: next.toISOString() },
            });
            app.log("info", `trigger "${trig.id}" fired`, { firedAt: next.toISOString(), ...res });
          } catch (err) {
            app.log("error", `trigger "${trig.id}": action failed`, { error: String(err) });
          } finally {
            arm(); // reschedule regardless of success (at-least-once, idempotent handlers)
          }
        })();
      }, delay);
      timers.add(handle);
    };
    arm();
  };

  for (const trig of (ctx.manifest.triggers ?? []) as TriggerDecl[]) {
    if (trig.type === "cron") {
      armCron(trig);
      continue;
    }
    if (trig.type !== "webhook") {
      ctx.host.log("warn", `trigger "${trig.id}": type "${trig.type}" not implemented, skipped`);
      continue;
    }
    const path = normalizeRoutePath(trig.path, `/hooks/${trig.id}`);
    mounted.push(`${trig.id}@${path}`);

    routes.push({
      method: "POST",
      path,
      source: `trigger:${trig.id}`,
      handler: async (req) => {
        const raw = await req.text();
        const headers = headerRecord(req);

        // Auth (hmac:<connection>).
        if (trig.auth?.startsWith("hmac:")) {
          const conn = trig.auth.slice("hmac:".length);
          const secret = app.env(secretEnvName(conn));
          if (!secret) {
            app.log("error", `trigger "${trig.id}": missing secret ${secretEnvName(conn)}`);
            return json({ error: "server not configured for hmac" }, 500);
          }
          const sig = headers["x-signature"] ?? headers["x-hub-signature-256"] ?? "";
          if (!sig || !(await verifyHmac(secret, raw, sig))) {
            return json({ error: "invalid signature" }, 401);
          }
        }

        // Idempotency by delivery id (bounded set).
        const delivery = headers["x-delivery-id"] ?? headers["x-github-delivery"];
        if (delivery) {
          if (seenDeliveries.has(delivery)) return json({ ok: true, deduped: true });
          seenDeliveries.add(delivery);
          if (seenDeliveries.size > 10_000) {
            seenDeliveries.delete(seenDeliveries.values().next().value as string);
          }
        }

        let body: unknown = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json({ error: "body must be JSON" }, 400);
        }

        if (!trig.action?.message && !trig.action?.start) {
          app.log("warn", `trigger "${trig.id}": no action.message/start; nothing to do`);
          return json({ ok: true, fired: false });
        }
        const res = await runTriggerAction(app, trig.action, {
          body,
          headers,
          query: Object.fromEntries(req.query),
        });
        // `res.kind` is the honest verb (start | message); don't hard-code "published".
        app.log("info", `trigger "${trig.id}" fired`, { ...res });
        return json({ ok: true, fired: true, ...res });
      },
    });
  }

  ctx.host.log("info", "triggers mounted", { mounted, scheduled });
  return {
    name: "triggers",
    routes,
    describe: () => ({ mounted, scheduled }),
    async stop() {
      stopped = true;
      for (const h of timers) sched.clearTimer(h);
      timers.clear();
    },
  };
}
