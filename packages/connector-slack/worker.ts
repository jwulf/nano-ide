// Slack "Send Message" worker (nano-ide-connector-slack, outbound edge).
//
// The *runtime* half of the "Send Slack Message" component: a long-lived job
// worker (Zeebe-style) that subscribes by the job type `slack:send-message` —
// the same `zeebe:taskDefinition:type` the element template stamps onto a
// service task (components/send-message.json). When the connector is enabled and
// the App runs, the runtime launches and supervises this worker (ADR 0050,
// amending ADR 0033 §4; supervision reuses ADR 0025 §4 / 0036 / 0038).
//
// At-least-once outbound delivery is inherited from the engine's durable job
// queue — the job is held until we complete it, and re-activated on a crash — so
// this worker needs no durable outbox of its own (the symmetric dual of the
// trigger inbox, ADR 0025 §2). Slack's chat.postMessage is not idempotent, so a
// re-activated job can post twice; makers who need exactly-once should pass a
// client-side de-dupe key in a follow-up (tracked in the connector README).
//
// Runs on Node >=22.6 (`--experimental-strip-types`) or Deno; erasable
// TypeScript, no build step. The bot token is read from the connector's config
// env-pointer (SLACK_BOT_TOKEN by default) — never inlined in the manifest
// (ADR 0027 §5).

import { defineWorker, type WorkerJob } from "@nanobpm/worker";

/** Read an env var portably across Node (`process.env`) and Deno (`Deno.env`). */
function env(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(k: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env?.[name];
}

const SLACK_POST_MESSAGE = "https://slack.com/api/chat.postMessage";

const botToken = env("SLACK_BOT_TOKEN");
if (!botToken) {
  console.error("[slack:send-message] SLACK_BOT_TOKEN is not set; refusing to start");
  const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } };
  (g.Deno ?? g.process)?.exit(1);
}

interface SlackPostResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  warning?: string;
}

/** Coerce a variable to a non-empty trimmed string, or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

async function handle(job: WorkerJob): Promise<Record<string, unknown>> {
  const channel = str(job.variables.channel);
  const text = str(job.variables.text);
  const threadTs = str(job.variables.threadTs);

  // Bad inputs are a modeling error, not a transient fault: raise a BPMN error
  // so a boundary event can route it, rather than retrying forever.
  if (!channel) {
    await job.error("SLACK_BAD_INPUT", "channel is required");
    return {};
  }
  if (!text) {
    await job.error("SLACK_BAD_INPUT", "text is required");
    return {};
  }

  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  let res: Response;
  try {
    res = await fetch(SLACK_POST_MESSAGE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Network hiccup — retryable; let the engine re-activate the job.
    await job.fail(`slack request failed: ${(e as Error).message}`);
    return {};
  }

  // Slack signals both transport and application errors; a 429 is retryable.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    await job.fail(`slack rate-limited; retry after ${retryAfter}s`);
    return {};
  }

  let payload: SlackPostResult;
  try {
    payload = (await res.json()) as SlackPostResult;
  } catch {
    await job.fail(`slack returned non-JSON (${res.status})`);
    return {};
  }

  if (!payload.ok) {
    // Auth/permission/config errors won't fix themselves on retry → BPMN error.
    await job.error("SLACK_API_ERROR", payload.error ?? "unknown slack error");
    return {};
  }

  // Success: map the sent message back to the process (element template's
  // `zeebe:output` reads `ts` and `channel`).
  return { ts: payload.ts, channel: payload.channel };
}

defineWorker({
  type: "slack:send-message",
  maxParallelJobs: Number(env("SLACK_MAX_PARALLEL_JOBS") ?? "10"),
  handle,
});
