// triggers — the inbound I/O edge (ADR 0025). Turns each `webhook` trigger in the manifest
// into an HTTP route that verifies the request, maps the payload, and publishes the declared
// message to the engine for correlation. HMAC verification uses Web Crypto (global in both
// Node 18+ and Deno), so this stays runtime-agnostic.

import type { AppApi, RuntimeContext } from "../context.ts";
import type { HttpRequest } from "../host.ts";
import { json, normalizeRoutePath, type Route } from "../router.ts";
import type { TriggerDecl } from "../manifest.ts";

export interface TriggersHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

/** Evaluate a tiny correlation expression: `= body.a.b`, or a literal string. */
export function evalCorrelation(
  expr: string | undefined,
  scope: { body: unknown; headers: Record<string, string>; query: Record<string, string> },
): string | undefined {
  if (!expr) return undefined;
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
  return cur == null ? undefined : String(cur);
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

/** Mount webhook triggers and return their routes. */
export function mountTriggers(ctx: RuntimeContext, app: AppApi): TriggersHandle {
  const routes: Route[] = [];
  const mounted: string[] = [];
  const seenDeliveries = new Set<string>();

  for (const trig of (ctx.manifest.triggers ?? []) as TriggerDecl[]) {
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

        const message = trig.action?.message;
        if (!message) {
          app.log("warn", `trigger "${trig.id}": no action.message; nothing published`);
          return json({ ok: true, published: false });
        }
        const correlationKey = evalCorrelation(trig.action?.correlationKey, {
          body,
          headers,
          query: Object.fromEntries(req.query),
        });
        await app.engine.publishMessage({
          name: message,
          correlationKey,
          variables: (body && typeof body === "object" ? (body as Record<string, unknown>) : {}),
        });
        app.log("info", `trigger "${trig.id}" published`, { message, correlationKey });
        return json({ ok: true, published: true, message, correlationKey });
      },
    });
  }

  ctx.host.log("info", "triggers mounted", { mounted });
  return { name: "triggers", routes, describe: () => ({ mounted }) };
}
