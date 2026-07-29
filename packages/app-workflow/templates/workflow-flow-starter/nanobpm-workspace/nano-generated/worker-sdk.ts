// nanobpmn embedded worker SDK (Deno-preferred, Node-capable).
//
// This file is written verbatim into <workspace>/nano-generated/worker-sdk.ts by the
// console worker supervisor and imported by each worker's `worker.ts`. It speaks
// the nanobpmn Falcon protocol directly over the platform's native WebSocket
// (no `ws`, no node:events) so a worker is a single self-contained process.
//
// It runs under **Deno** (preferred) or, on hosts with no Deno build (e.g.
// 32-bit ARM), under **Node** (>= 22.6, launched with type stripping + the
// import-map loader). The only host calls that differ between the two runtimes
// are isolated behind the `RT` adapter below; see ADR 0036.
//
// A worker file looks like:
//
//   import { defineWorker } from "@nanobpm/worker";
//   defineWorker({
//     type: "my-job",
//     maxParallelJobs: 10,
//     async handle(job) {
//       // ...do work with job.variables...
//       return { result: 42 };           // resolves -> completeJob({ result: 42 })
//       // or: await job.fail("boom");    // or job.error("CODE", "msg")
//     },
//   });
//
// The handler may either return output variables (the job is completed with
// them) or call one of job.complete/job.fail/job.error explicitly. Throwing
// fails the job. npm libraries are available via `npm:` specifiers.

/** A row from a datasource query. */
export type WorkerRow = Record<string, unknown>;

/** A typed table gateway (the RAD "TTable") over one table — manipulate rows as
 * typed records instead of hand-writing SQL. Structurally mirrors `Table` in the
 * `@nanobpm/data` SDK; `T` comes from the generated `domain-rows.d.ts` (ADR 0029 §6).
 * For the full named accessor (`db.orders.insert(...)`) import `openDomain` from
 * `@nanobpm/domain`. */
export interface WorkerTable<T extends object = WorkerRow> {
  insert(row: Partial<T>): Promise<number | bigint>;
  get(id: unknown): Promise<T | undefined>;
  all(limit?: number): Promise<T[]>;
  find(where?: Partial<T>): Promise<T[]>;
  findOne(where?: Partial<T>): Promise<T | undefined>;
  update(id: unknown, patch: Partial<T>): Promise<number>;
  delete(id: unknown): Promise<number>;
  count(where?: Partial<T>): Promise<number>;
}

/** The datasource handle returned by `ctx.data()`. Mirrors the DataSource
 * contract in the `@nanobpm/data` SDK (ADR 0024); typed structurally here so the
 * worker SDK stays a single self-contained file. `query` is generic so a caller
 * can supply a row type from the generated `domain-rows.d.ts` (ADR 0029 §4.1):
 * `db.query<DomainTables["customers"]>("SELECT * FROM customers")`. */
export interface WorkerDataSource {
  query<T extends object = WorkerRow>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(
    sql: string,
    params?: unknown[],
  ): Promise<{ changed: number; lastInsertId?: number | bigint }>;
  tx<T>(fn: (t: WorkerDataSource) => Promise<T>): Promise<T>;
  schema(): Promise<unknown[]>;
  /** A typed table gateway (the RAD "TTable", ADR 0029 §6): manipulate rows as
   * records instead of hand-writing SQL. `pk` defaults to "id". */
  table<T extends object = WorkerRow>(name: string, pk?: string): WorkerTable<T>;
  close(): void;
}

/** The App runtime handed to a worker handler as its 2nd argument. */
export interface WorkerContext {
  /** Open a declared datasource by name (default when omitted), per ADR 0024. */
  data(name?: string): Promise<WorkerDataSource>;
}

/** A worker's variable shapes default to untyped JSON; declaring them (from the
 * generated `domain-rows.d.ts` or the manifest `types` registry, ADR 0029) types the
 * handler's inputs and outputs while authoring — erased at runtime. */
export type WorkerVars = Record<string, unknown>;

export interface WorkerJob<In extends object = WorkerVars, Out extends object = WorkerVars> {
  readonly jobKey: string;
  readonly type: string;
  readonly processInstanceKey: string;
  readonly processDefinitionId?: string;
  readonly processDefinitionKey?: string;
  readonly elementId?: string;
  readonly retries?: number;
  readonly variables: In;
  readonly customHeaders: Record<string, unknown>;
  /** Complete the job, optionally setting output variables. */
  complete(variables?: Out): void;
  /** Fail the job (optionally with remaining retries and a message). */
  fail(opts?: { retries?: number; errorMessage?: string } | string): void;
  /** Throw a BPMN error from the job. */
  error(errorCode: string, errorMessage?: string): void;
}

export interface WorkerOptions<In extends object = WorkerVars, Out extends object = WorkerVars> {
  /** BPMN job type to work on. */
  type: string;
  /** Handler invoked per job. Return output vars, or call a job action. The
   * optional 2nd arg exposes the App runtime: `ctx.data(name?)` opens a
   * declared datasource (ADR 0024). Single-arg handlers keep working. */
  handle: (
    job: WorkerJob<In, Out>,
    ctx: WorkerContext,
  ) => Promise<void | Out> | void | Out;
  /** Max jobs in flight (also the streaming credit window). Default 10. */
  maxParallelJobs?: number;
  /** Job activation lock timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Restrict fetched variables to these names (default: all). */
  fetchVariables?: string[];
  /** Gateway base URL. Defaults to env NANOBPMN_BASE_URL or http://127.0.0.1:8080. */
  baseUrl?: string;
  /** Worker name recorded on activation. Defaults to env NANOBPMN_WORKER_NAME. */
  worker?: string;
}

// Control lines the supervisor parses out of stdout. Anything else on stdout is
// treated as worker log output.
const METRIC = "@@NBPM_METRIC@@";
const STATUS = "@@NBPM_STATUS@@";

// Runtime adapter: the handful of host calls that differ between Deno (native
// `Deno.*`) and Node (`process`). Everything else the worker uses — WebSocket,
// fetch, timers, TextEncoder — is standard on both. Detected once at load.
interface Runtime {
  env(key: string): string | undefined;
  write(line: string): void;
  onSigterm(handler: () => void): void;
  exit(code: number): void;
}
const RT: Runtime = ((): Runtime => {
  const g = globalThis as unknown as {
    Deno?: {
      env: { get(k: string): string | undefined };
      stdout: { writeSync(b: Uint8Array): number };
      addSignalListener(sig: string, h: () => void): void;
      exit(code: number): void;
    };
    process?: {
      env: Record<string, string | undefined>;
      stdout: { write(s: string): boolean };
      on(sig: string, h: () => void): void;
      exit(code: number): void;
    };
  };
  if (g.Deno) {
    const d = g.Deno;
    const enc = new TextEncoder();
    return {
      env: (k) => d.env.get(k),
      write: (line) => void d.stdout.writeSync(enc.encode(line)),
      onSigterm: (h) => d.addSignalListener("SIGTERM", h),
      exit: (c) => d.exit(c),
    };
  }
  const p = g.process!;
  return {
    env: (k) => p.env[k],
    write: (line) => void p.stdout.write(line),
    onSigterm: (h) => p.on("SIGTERM", h),
    exit: (c) => p.exit(c),
  };
})();

function emit(prefix: string, payload: unknown): void {
  // Write directly so it is one atomic line, independent of console.log.
  RT.write(prefix + JSON.stringify(payload) + "\n");
}

function falconUrl(baseUrl: string, worker?: string): string {
  let base = baseUrl.replace(/\/+$/, "").replace(/\/v2$/, "");
  if (base.startsWith("http://")) base = "ws://" + base.slice("http://".length);
  else if (base.startsWith("https://")) base = "wss://" + base.slice("https://".length);
  const url = new URL(base + "/falcon");
  if (worker) url.searchParams.set("worker", worker);
  return url.toString();
}

/** Untyped fallback payload for a message with no declared envelope. */
export type MessageVars = Record<string, unknown>;

/** Options for [`publishMessage`]. `variables` is the message payload (typed by
 * the generated `messages.ts` wrapper against the model's envelope). */
export interface PublishMessageOptions<V extends object = MessageVars> {
  /** The correlation key selecting the target subscription (default ""). */
  correlationKey?: string;
  /** The message payload delivered to correlated instances. */
  variables?: V;
  /** Buffer lifetime in ms. nanobpmn does not buffer, so this is advisory. */
  timeToLive?: number;
  /** Idempotency id for the publish (dedup on the gateway when supported). */
  messageId?: string;
  /** Gateway base URL. Defaults to env NANOBPMN_BASE_URL or http://127.0.0.1:8080. */
  baseUrl?: string;
}

/** The result of a successful [`publishMessage`]. */
export interface PublishMessageResult {
  /** The minted message key. */
  messageKey: string;
  /** The tenant the message was published to, when the gateway reports one. */
  tenantId?: string;
}

/**
 * Publish a message and correlate it to any matching open subscription, via the
 * gateway's `POST /v2/messages/publication` endpoint (the same call an SDK client
 * makes, ADR 0025). nanobpmn does not buffer messages: the message is minted,
 * correlated to every matching open subscription, then dropped. The generated
 * `messages.ts` wrapper narrows `name` to the model's declared message names and
 * types `variables` from the message's data envelope (ADR 0040 slice 2); this raw
 * form moves untyped JSON on the wire. Throws on a non-2xx response.
 */
export async function publishMessage(
  name: string,
  opts: PublishMessageOptions = {},
): Promise<PublishMessageResult> {
  const baseUrl = opts.baseUrl ?? RT.env("NANOBPMN_BASE_URL") ?? "http://127.0.0.1:8080";
  const url = baseUrl.replace(/\/+$/, "").replace(/\/v2$/, "") + "/v2/messages/publication";
  const body: Record<string, unknown> = {
    name,
    correlationKey: opts.correlationKey ?? "",
    variables: opts.variables ?? {},
  };
  if (opts.timeToLive != null) body.timeToLive = opts.timeToLive;
  if (opts.messageId != null) body.messageId = opts.messageId;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`publishMessage "${name}" failed: ${resp.status} ${detail}`.trim());
  }
  // The gateway mints and returns a `messageKey` on every 2xx (ADR 0025), so a
  // missing/empty key or an unparseable body is a broken response, not a success
  // — fail fast rather than hand back an empty key.
  const json = (await resp.json().catch(() => null)) as
    | { messageKey?: unknown; tenantId?: unknown }
    | null;
  if (json?.messageKey == null || json.messageKey === "") {
    throw new Error(
      `publishMessage "${name}" returned HTTP ${resp.status} but no messageKey`,
    );
  }
  return {
    messageKey: String(json.messageKey),
    tenantId: json.tenantId == null ? undefined : String(json.tenantId),
  };
}

export function defineWorker<
  In extends object = WorkerVars,
  Out extends object = WorkerVars,
>(typedOpts: WorkerOptions<In, Out>): void {
  // The machinery below is type-agnostic (it moves JSON on the wire); the
  // generics are an authoring-time contract only, so erase them internally.
  const opts = typedOpts as unknown as WorkerOptions;
  const baseUrl = opts.baseUrl ?? RT.env("NANOBPMN_BASE_URL") ?? "http://127.0.0.1:8080";
  const workerName = opts.worker ?? RT.env("NANOBPMN_WORKER_NAME") ?? "embedded-worker";
  const maxParallel = opts.maxParallelJobs ?? 10;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const url = falconUrl(baseUrl, workerName);

  let corr = 0;
  const nextCorr = () => (corr = (corr + 1) >>> 0);

  let completed = 0;
  let failed = 0;
  let inFlight = 0;
  let lastError: string | null = null;
  const startedAt = Date.now();
  let lastTotal = 0;
  let lastTick = startedAt;
  let connected = false;

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let metricTimer: ReturnType<typeof setInterval> | undefined;
  let ws: WebSocket;

  const acted = new Set<string>();

  function send(frame: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  function snapshot() {
    return {
      completed,
      failed,
      inFlight,
      lastError,
      uptimeMs: Date.now() - startedAt,
      connected,
    };
  }

  function emitMetrics(): void {
    const now = Date.now();
    const total = completed + failed;
    const dt = (now - lastTick) / 1000;
    const throughput = dt > 0 ? (total - lastTotal) / dt : 0;
    lastTotal = total;
    lastTick = now;
    emit(METRIC, { ...snapshot(), throughput: Math.round(throughput * 100) / 100 });
  }

  function enrich(raw: Record<string, unknown>): WorkerJob {
    const jobKey = String(raw.jobKey ?? raw.key ?? "");
    const markActed = () => acted.add(jobKey);
    return {
      jobKey,
      type: String(raw.type ?? opts.type),
      processInstanceKey: String(raw.processInstanceKey ?? ""),
      processDefinitionId: raw.processDefinitionId as string | undefined,
      processDefinitionKey: raw.processDefinitionKey as string | undefined,
      elementId: raw.elementId as string | undefined,
      retries: raw.retries as number | undefined,
      variables: (raw.variables as Record<string, unknown>) ?? {},
      customHeaders: (raw.customHeaders as Record<string, unknown>) ?? {},
      complete: (variables?: Record<string, unknown>) => {
        markActed();
        send({ type: "completeJob", corr: nextCorr(), jobKey, variables: variables ?? null });
        completed += 1;
      },
      fail: (o?: { retries?: number; errorMessage?: string } | string) => {
        markActed();
        const n = typeof o === "string" ? { errorMessage: o } : o ?? {};
        send({
          type: "failJob",
          corr: nextCorr(),
          jobKey,
          retries: n.retries ?? null,
          errorMessage: n.errorMessage ?? null,
        });
        failed += 1;
      },
      error: (errorCode: string, errorMessage?: string) => {
        markActed();
        send({ type: "throwError", corr: nextCorr(), jobKey, errorCode, errorMessage: errorMessage ?? null });
        completed += 1;
      },
    };
  }

  // The App runtime handed to handlers. `ctx.data()` lazily loads the sibling
  // datasource SDK (materialised next to this file as ./data-sdk.ts) so a worker
  // that never touches data pays nothing and needs no import-map entry.
  const ctx: WorkerContext = {
    data: (name?: string) =>
      import("./data-sdk.ts").then((m) =>
        (m as { openDataSource(n?: string): Promise<WorkerDataSource> }).openDataSource(name)
      ),
  };

  async function dispatch(raw: Record<string, unknown>): Promise<void> {
    const job = enrich(raw);
    inFlight += 1;
    try {
      const out = await opts.handle(job, ctx);
      if (!acted.has(job.jobKey)) {
        // Handler returned without acting: complete with any returned vars.
        job.complete(out && typeof out === "object" ? (out as Record<string, unknown>) : undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (!acted.has(job.jobKey)) job.fail({ errorMessage: msg });
    } finally {
      acted.delete(job.jobKey);
      inFlight -= 1;
      // Replenish one credit so demand stays at maxParallel.
      send({ type: "jobCredits", jobType: opts.type, n: 1 });
    }
  }

  function connect(): void {
    ws = new WebSocket(url);
    ws.onopen = () => {
      emit(STATUS, { state: "connecting", message: `socket open to ${url}` });
    };
    ws.onmessage = (ev: MessageEvent) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      switch (frame.type) {
        case "welcome": {
          connected = true;
          lastError = null;
          emit(STATUS, { state: "running", message: "subscribed to " + opts.type });
          send({
            type: "subscribe",
            jobType: opts.type,
            jobCredits: maxParallel,
            worker: workerName,
            timeout: timeoutMs,
            fetchVariable: opts.fetchVariables ?? null,
          });
          const hbMs = Number(frame.heartbeatMs ?? 0);
          if (hbMs > 0) {
            clearInterval(heartbeat);
            heartbeat = setInterval(() => send({ type: "heartbeat" }), hbMs);
          }
          break;
        }
        case "job":
          void dispatch((frame.job as Record<string, unknown>) ?? {});
          break;
        case "commandResult": {
          const status = Number(frame.status ?? 0);
          // 404/409 on a fire-and-forget completion is benign (job already gone).
          if (status >= 400 && status !== 404 && status !== 409) {
            lastError = `command failed with status ${status}`;
          }
          break;
        }
        // pressure / submissionCredits / heartbeat: nothing to do for a worker.
      }
    };
    ws.onerror = () => {
      connected = false;
      lastError = "websocket error";
      emit(STATUS, { state: "error", message: "websocket error" });
    };
    ws.onclose = (ev: CloseEvent) => {
      connected = false;
      clearInterval(heartbeat);
      emit(STATUS, { state: "reconnecting", message: `socket closed (${ev.code}); retrying` });
      setTimeout(connect, 1000);
    };
  }

  metricTimer = setInterval(emitMetrics, 1000);
  emit(STATUS, { state: "starting", message: `worker '${workerName}' type '${opts.type}'` });
  connect();

  const shutdown = () => {
    clearInterval(heartbeat);
    clearInterval(metricTimer);
    try {
      ws?.close(1000, "shutdown");
    } catch { /* ignore */ }
  };
  RT.onSigterm(() => {
    shutdown();
    RT.exit(0);
  });
}
