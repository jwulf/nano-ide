// runFromEnv — the one-call entrypoint a scaffolded app's main and the `urban run` CLI both
// use: select the host for the current runtime, build a REST engine client from env, create
// the Urban app, start it, and install a graceful-shutdown handler.

import { createUrbanApp, type CreateUrbanAppOptions, type UrbanApp } from "./core/runtime.ts";
import { selectHost } from "./adapters/detect.ts";
import { RestEngineClient } from "./engine/rest.ts";
import { createNanoSdkEngineClient } from "./engine/nanosdk.ts";
import type { EngineClient } from "./core/host.ts";

export interface RunOptions extends Partial<CreateUrbanAppOptions> {
  /** App root. Default ".". */
  root?: string;
  /** Engine REST base. Default $CAMUNDA_REST_ADDRESS or http://localhost:8080/v2. */
  restAddress?: string;
  /**
   * Engine transport: "rest" (default) uses the built-in REST client; "auto" | "falcon" try
   * `@nanobpm/nano-sdk` (Falcon on instance creation, REST fallback), falling back to REST if the
   * SDK is not installed. Overridable via $CAMUNDA_TRANSPORT.
   */
  transport?: string;
  /** Install SIGINT/SIGTERM handlers to stop the app. Default true. */
  handleSignals?: boolean;
}

export async function runFromEnv(opts: RunOptions = {}): Promise<UrbanApp> {
  const host = opts.host ?? selectHost({ cwd: opts.root });
  const restAddress =
    opts.restAddress ?? host.env("CAMUNDA_REST_ADDRESS") ?? "http://localhost:8080/v2";
  const transport = opts.transport ?? host.env("CAMUNDA_TRANSPORT") ?? "rest";

  let engine: EngineClient | undefined = opts.engine;
  if (!engine && transport !== "rest") {
    engine =
      (await createNanoSdkEngineClient({ restAddress, token: host.env("CAMUNDA_TOKEN"), transport, log: host.log })) ??
      undefined;
  }
  engine ??= new RestEngineClient({ baseUrl: restAddress, token: host.env("CAMUNDA_TOKEN"), log: host.log });

  const app = await createUrbanApp({
    host,
    engine,
    root: opts.root ?? ".",
    manifest: opts.manifest,
    manifestPath: opts.manifestPath,
    port: opts.port,
    mount: opts.mount,
  });
  await app.start();

  if (opts.handleSignals !== false) installSignalHandlers(() => app.stop());
  return app;
}

function installSignalHandlers(stop: () => Promise<void>): void {
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await stop();
    } finally {
      // Let the process exit naturally once resources are released.
    }
  };
  const g = globalThis as {
    Deno?: { addSignalListener(sig: string, cb: () => void): void };
    process?: { on(sig: string, cb: () => void): void };
  };
  if (g.Deno) {
    try {
      g.Deno.addSignalListener("SIGINT", onSignal);
      g.Deno.addSignalListener("SIGTERM", onSignal);
    } catch {
      /* signal listeners may be unavailable (e.g. Windows) */
    }
  } else if (g.process) {
    g.process.on("SIGINT", onSignal);
    g.process.on("SIGTERM", onSignal);
  }
}
