// Slack trigger source driver (nano-ide-connector-slack, inbound edge).
//
// The *inbound* half of the connector: it opens a Slack **Socket Mode**
// connection (no public URL needed) and forwards each Events-API event / slash
// command to the trigger ingress — the universal emit endpoint — so each one can
// **start a process** or **correlate a message** (ADR 0025). The runtime owns the
// durable inbox, dispatch, retry, and this driver's lifecycle (auto-launch +
// supervision, ADR 0025 §6 phase 4); the driver only *produces* events.
//
// Runtime contract (env, set by the host — see nanobpmn extensions.rs / ADR 0025 §6):
//   NANOBPMN_HOOK_URL           POST events here
//   NANOBPMN_TRIGGER_CONFIG     JSON of the trigger's `config` ({ appToken?, events? })
//   NANOBPMN_TRIGGER_CONNECTION JSON of the referenced connection, or "null"
//   NANOBPMN_WEBHOOK_TOKEN      shared secret to present as X-Webhook-Token (if set)
//   SLACK_APP_TOKEN             app-level token (xapp-...) if not carried in config/connection
//
// Runs on Node >=22.6 (`--experimental-strip-types`, global WebSocket + fetch)
// or Deno. Erasable TypeScript, no build step.

/** Read an env var portably across Node (`process.env`) and Deno (`Deno.env`). */
function env(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(k: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env?.[name];
}

function log(msg: string): void {
  console.log(`[slack] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[slack] ${msg}`);
  const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } };
  (g.Deno ?? g.process)?.exit(1);
  throw new Error(msg);
}

interface Config {
  appToken?: string;
  events?: string;
}
interface Connection {
  appToken?: string;
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

const appToken = connection.appToken || config.appToken || env("SLACK_APP_TOKEN");
if (!appToken) fail("no Slack app-level token; set SLACK_APP_TOKEN or the trigger's appToken config");

// Which event types to forward. Empty = all. A slash command is matched as
// `slash:/command` (or just its type "slash_commands").
const eventFilter = new Set(
  (config.events || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean),
);
function forwarded(kind: string, subtype: string | undefined): boolean {
  if (eventFilter.size === 0) return true;
  if (eventFilter.has(kind)) return true;
  if (subtype && eventFilter.has(subtype)) return true;
  return false;
}

let stopped = false;

async function emit(idem: string, payload: unknown): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idem,
  };
  if (token) headers["x-webhook-token"] = token;
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(hookUrl as string, { method: "POST", headers, body });
      if (res.ok) return;
      if (res.status === 401 || res.status === 403) {
        log(`ingress rejected event (${res.status}); check the trigger's auth secret`);
        return;
      }
      log(`ingress returned ${res.status} (attempt ${attempt})`);
    } catch (e) {
      log(`POST failed (attempt ${attempt}): ${(e as Error).message}`);
    }
    await sleep(Math.min(250 * 2 ** (attempt - 1), 4000));
  }
  log(`giving up on event ${idem} after retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Open a fresh Socket Mode WebSocket URL (they are single-use / ephemeral). */
async function openSocketUrl(): Promise<string> {
  const res = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) throw new Error(`apps.connections.open failed: ${data.error ?? res.status}`);
  return data.url;
}

interface Envelope {
  type: string;
  envelope_id?: string;
  payload?: {
    event?: { type?: string; event_ts?: string; channel_type?: string };
    event_id?: string;
    command?: string;
    [k: string]: unknown;
  };
  command?: string;
}

// Slack subscribes to messages per scope (message.channels/.groups/.im/.mpim);
// the event itself only carries a `channel_type` (channel/group/im/mpim), so map
// it back to the subscription-style key makers put in the `events` filter.
const MESSAGE_SCOPE: Record<string, string> = {
  channel: "channels",
  group: "groups",
  im: "im",
  mpim: "mpim",
};

function handleEnvelope(ws: WebSocket, env_: Envelope): void {
  // Socket Mode requires acking every enveloped message by echoing its id.
  if (env_.envelope_id) {
    ws.send(JSON.stringify({ envelope_id: env_.envelope_id }));
  }
  switch (env_.type) {
    case "hello":
      log("connected (socket mode)");
      return;
    case "disconnect":
      log("server requested disconnect; reconnecting");
      ws.close();
      return;
    case "events_api": {
      const ev = env_.payload?.event;
      const kind = ev?.type ?? "events_api";
      // A `message` event matches a scoped subscription key (message.channels,
      // message.im, …) derived from its channel_type, so those filters work.
      const subtype =
        kind === "message" && ev?.channel_type
          ? `message.${MESSAGE_SCOPE[ev.channel_type] ?? ev.channel_type}`
          : undefined;
      if (!forwarded(kind, subtype)) return;
      const idem = env_.payload?.event_id || env_.envelope_id || `${Date.now()}`;
      void emit(idem, { source: "events_api", type: kind, event: ev, raw: env_.payload });
      return;
    }
    case "slash_commands": {
      const command = env_.payload?.command;
      if (!forwarded("slash_commands", command ? `slash:${command}` : undefined)) return;
      const idem = env_.envelope_id || `${Date.now()}`;
      void emit(idem, { source: "slash_commands", type: "slash_commands", command, raw: env_.payload });
      return;
    }
    default:
      // interactive, etc. — forward generically when not filtered out.
      if (!forwarded(env_.type, undefined)) return;
      void emit(env_.envelope_id || `${Date.now()}`, { source: env_.type, type: env_.type, raw: env_.payload });
  }
}

async function connectLoop(): Promise<void> {
  let backoff = 500;
  while (!stopped) {
    let url: string;
    try {
      url = await openSocketUrl();
    } catch (e) {
      log(`open failed: ${(e as Error).message}; retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    backoff = 500;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => log("websocket open"));
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          handleEnvelope(ws, JSON.parse(String(ev.data)) as Envelope);
        } catch (e) {
          log(`bad frame: ${(e as Error).message}`);
        }
      });
      ws.addEventListener("error", () => log("websocket error"));
      ws.addEventListener("close", () => {
        log("websocket closed");
        resolve();
      });
    });
  }
}

function shutdown(): void {
  log("shutting down");
  stopped = true;
  const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } };
  (g.Deno ?? g.process)?.exit(0);
}
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

log(`starting; forwarding ${eventFilter.size === 0 ? "all events" : [...eventFilter].join(", ")}`);
void connectLoop();
