// MQTT trigger source driver (nano-ide-trigger-mqtt, ADR 0025 §6 / phase 4).
//
// Auto-launched and supervised by the Urban runtime while an App that declares
// an `mqtt` trigger is running. It subscribes to the configured topics and
// POSTs each received message to the trigger ingress (the universal emit
// endpoint); the runtime owns the durable inbox, dispatch, and retry. This
// process only produces events.
//
// Runtime contract (env, set by the host — see extensions.rs / ADR 0025 §6):
//   NANOBPMN_HOOK_URL          POST events here
//   NANOBPMN_TRIGGER_CONFIG    JSON of the trigger's `config` ({ url, topics, qos })
//   NANOBPMN_TRIGGER_CONNECTION JSON of the referenced connection, or "null"
//   NANOBPMN_WEBHOOK_TOKEN     shared secret to present as X-Webhook-Token (if set)
//   NANOBPMN_TRIGGER_ID / _TYPE / NANOBPMN_PROJECT  identity (for logs)
//
// Runs on Node >=22.6 (`--experimental-strip-types`, the host default) or Deno.
// Written in erasable TypeScript so Node can strip the types without a build.

import mqtt from "mqtt";
import type { IClientOptions, IClientSubscribeOptions } from "mqtt";

/** Read an env var portably across Node (`process.env`) and Deno (`Deno.env`). */
function env(name: string): string | undefined {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } }; process?: { env: Record<string, string | undefined> } };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env?.[name];
}

function log(msg: string): void {
  // stdout is streamed to the App's trigger log by the supervisor.
  console.log(`[mqtt] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[mqtt] ${msg}`);
  const g = globalThis as { Deno?: { exit(code: number): never }; process?: { exit(code: number): never } };
  (g.Deno ?? g.process)?.exit(1);
  throw new Error(msg);
}

interface Config {
  url?: string;
  topics?: string | string[];
  qos?: number | string;
}

interface Connection {
  url?: string;
  username?: string;
  password?: string;
  clientId?: string;
  // Any extra keys are passed through to the mqtt client options untouched.
  [k: string]: unknown;
}

const hookUrl = env("NANOBPMN_HOOK_URL");
if (!hookUrl) fail("NANOBPMN_HOOK_URL is not set; refusing to start");

const token = env("NANOBPMN_WEBHOOK_TOKEN");

let config: Config = {};
try {
  config = JSON.parse(env("NANOBPMN_TRIGGER_CONFIG") || "{}") as Config;
} catch {
  fail("NANOBPMN_TRIGGER_CONFIG is not valid JSON");
}

let connection: Connection = {};
try {
  const raw = JSON.parse(env("NANOBPMN_TRIGGER_CONNECTION") || "null");
  if (raw && typeof raw === "object") connection = raw as Connection;
} catch {
  fail("NANOBPMN_TRIGGER_CONNECTION is not valid JSON");
}

const brokerUrl = connection.url || config.url || "mqtt://localhost:1883";
const qos = clampQos(config.qos);
const topics = parseTopics(config.topics);
if (topics.length === 0) fail("no topics configured; set config.topics (comma-separated)");

function clampQos(v: number | string | undefined): 0 | 1 | 2 {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return n === 0 || n === 2 ? n : 1;
}

function parseTopics(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

// A driver-run id + monotonic sequence gives every emitted event a stable
// idempotency key, so a POST retried after a transient failure is collapsed by
// the inbox (ADR 0025 §2 step 1) rather than double-delivered.
const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

const utf8 = new TextDecoder("utf-8");

async function emit(topic: string, payloadRaw: Uint8Array): Promise<void> {
  const idem = `${runId}-${(seq++).toString(36)}`;
  const text = utf8.decode(payloadRaw);
  let payload: unknown = text;
  // Convenience: surface JSON payloads as objects so the App's FEEL can read
  // `body.payload.field` directly; non-JSON stays a string.
  try {
    payload = JSON.parse(text);
  } catch {
    /* keep raw string */
  }
  const body = JSON.stringify({ topic, payload, ts: new Date().toISOString() });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idem,
  };
  if (token) headers["x-webhook-token"] = token;

  // Bounded retry so a brief ingress hiccup doesn't drop a message; the stable
  // idempotency key makes the retry safe.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(hookUrl as string, { method: "POST", headers, body });
      if (res.ok) return;
      // 401/403 => auth misconfigured; retrying won't help.
      if (res.status === 401 || res.status === 403) {
        log(`ingress rejected event (${res.status}); check the trigger's auth secret`);
        return;
      }
      log(`ingress returned ${res.status} for ${topic} (attempt ${attempt})`);
    } catch (e) {
      log(`POST failed for ${topic} (attempt ${attempt}): ${(e as Error).message}`);
    }
    await sleep(Math.min(250 * 2 ** (attempt - 1), 4000));
  }
  log(`giving up on event for ${topic} after retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RESERVED_CONN_KEYS = new Set(["url", "username", "password", "clientId"]);
const options: IClientOptions = {
  reconnectPeriod: 2000,
  connectTimeout: 30000,
};
// Pass any extra connection keys straight through to the mqtt client options
// (e.g. `rejectUnauthorized`, `ca`, `keepalive`), excluding the ones we map
// explicitly and `url` (used to dial, not an option).
for (const [k, v] of Object.entries(connection)) {
  if (!RESERVED_CONN_KEYS.has(k) && v !== undefined) (options as Record<string, unknown>)[k] = v;
}
if (connection.username) options.username = connection.username;
if (connection.password) options.password = connection.password;
if (connection.clientId) options.clientId = connection.clientId;

// Redact any userinfo (user:pass@) so credentials embedded in the URL never
// reach the trigger log.
function redact(u: string): string {
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    return parsed.toString();
  } catch {
    return u.replace(/\/\/[^@/]*@/, "//***@");
  }
}

log(`connecting to ${redact(brokerUrl)}; topics=[${topics.join(", ")}] qos=${qos}`);
const client = mqtt.connect(brokerUrl, options);

client.on("connect", () => {
  log("connected");
  client.subscribe(topics, { qos } as IClientSubscribeOptions, (err, granted) => {
    if (err) {
      log(`subscribe failed: ${err.message}`);
      return;
    }
    const g = (granted ?? []).map((x) => `${x.topic}@${x.qos}`).join(", ");
    log(`subscribed: ${g || "(none granted)"}`);
  });
});

client.on("message", (topic, payload) => {
  void emit(topic, payload);
});

client.on("reconnect", () => log("reconnecting…"));
client.on("error", (err) => log(`client error: ${err.message}`));
client.on("close", () => log("connection closed"));

// Terminate cleanly when the supervisor sends SIGTERM/SIGINT (kill on App stop),
// under both Node (`process.on`) and Deno (`Deno.addSignalListener`).
const shutdown = () => {
  log("shutting down");
  client.end(true, {}, () => {
    const g = globalThis as { Deno?: { exit(code: number): never }; process?: { exit(code: number): never } };
    (g.Deno ?? g.process)?.exit(0);
  });
};
const g = globalThis as {
  process?: { on(ev: string, cb: () => void): void };
  Deno?: { addSignalListener(sig: string, cb: () => void): void };
};
if (g.Deno?.addSignalListener) {
  g.Deno.addSignalListener("SIGTERM", shutdown);
  g.Deno.addSignalListener("SIGINT", shutdown);
} else if (g.process) {
  g.process.on("SIGTERM", shutdown);
  g.process.on("SIGINT", shutdown);
}
