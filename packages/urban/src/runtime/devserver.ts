// `urban dev` — a hot-reload dev server. It runs the derivers once, starts the app, then
// watches the app root and, on a relevant source change, regenerates artifacts and restarts
// the app in-process. A per-reload import nonce busts the module cache so changed worker/
// action handlers are re-evaluated. main.ts is NOT re-run in dev (the CLI drives the runtime
// directly), so main.ts edits don't need a reload.
//
// The reload strategy is a full in-process restart: regenerate + build a fresh host, then
// stop the old app and start the new one. Regenerating first means a bad edit (invalid
// manifest/model) fails before the running app is torn down, so it keeps serving. It is the
// same start path as a fresh `urban run`, so every change kind — manifest, BPMN/DMN, forms,
// migrations/types, worker code — is picked up. A finer-grained surface remount + browser
// live-reload can layer on later behind this same seam.

import { runFromEnv } from "./run.ts";
import { selectHost } from "./adapters/detect.ts";
import type { HostContext, WatchHandle } from "./core/host.ts";
import type { UrbanApp } from "./core/runtime.ts";
import { createNodeGenIO, runGen } from "../toolkit/index.ts";

const SOURCE_EXT = [".bpmn", ".dmn", ".form", ".ts", ".js", ".mjs", ".sql"] as const;
// Directories whose churn must never trigger a reload: generated output (gen writes here —
// watching it would loop forever), dependencies, VCS, and build output.
const IGNORE_SEGMENTS = ["nano-generated", "node_modules", ".git", "dist"] as const;

/** True when a changed path should trigger a dev reload. Pure, so it is unit-tested.
 *  `manifestFile` (the app's configured manifest, default nano.app.json) always triggers,
 *  so `urban dev --manifest other.json` reloads on edits to that file too. */
export function shouldReload(rawPath: string, manifestFile = "nano.app.json"): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "");
  const p = norm(rawPath);
  if (p === "") return false;
  for (const seg of IGNORE_SEGMENTS) {
    if (p === seg || p.startsWith(`${seg}/`) || p.includes(`/${seg}/`)) return false;
  }
  // Ignore SQLite database files and their WAL/SHM/journal sidecars — they change on every
  // write and would otherwise wedge the server in a reload loop.
  if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(p)) return false;
  const mf = norm(manifestFile);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (p === mf || base === mf.slice(mf.lastIndexOf("/") + 1)) return true;
  return SOURCE_EXT.some((e) => p.toLowerCase().endsWith(e));
}

export interface DevOptions {
  root?: string;
  manifestPath?: string;
  port?: number;
  /** Quiet-period after the last change before reloading, in ms. Default 150. */
  debounceMs?: number;
  /** Log sink (default console.log). */
  log?: (msg: string) => void;
}

/** Injectable seams so the loop is testable without a live engine or filesystem. */
export interface DevDeps {
  makeHost(nonce: string): HostContext;
  startApp(host: HostContext, o: { manifestPath: string; port?: number }): Promise<UrbanApp>;
  regenerate(root: string, manifestFile: string): Promise<{ count: number }>;
  now(): number;
}

function defaultDeps(root: string): DevDeps {
  return {
    makeHost: (nonce) => selectHost({ cwd: root, importNonce: nonce }),
    startApp: (host, o) =>
      // The host is anchored at `root`; runFromEnv keeps its own root at "." accordingly.
      runFromEnv({ host, manifestPath: o.manifestPath, port: o.port, handleSignals: false }),
    regenerate: async (r, mf) => {
      const res = await runGen({ root: r, io: createNodeGenIO(), manifestFile: mf });
      return { count: res.artifacts.length };
    },
    now: () => Date.now(),
  };
}

export interface DevServer {
  stop(): Promise<void>;
}

/**
 * Start the dev server: gen once, start the app, then watch + hot-reload. Returns a handle
 * whose stop() tears the watcher and the running app down. Never rejects on a reload error —
 * a bad edit logs and leaves the previous app running.
 */
export async function runDev(opts: DevOptions = {}, deps?: Partial<DevDeps>): Promise<DevServer> {
  const root = opts.root ?? ".";
  const manifestFile = opts.manifestPath ?? "nano.app.json";
  const debounceMs = opts.debounceMs ?? 150;
  const log = opts.log ?? ((m: string) => console.log(m));
  const d: DevDeps = { ...defaultDeps(root), ...deps };

  const startCycle = async (): Promise<{ host: HostContext; app: UrbanApp }> => {
    const host = await prepareHost();
    const app = await d.startApp(host, { manifestPath: manifestFile, port: opts.port });
    return { host, app };
  };

  // Derive artifacts and build a fresh host (with a new import nonce). This is pure/FS work
  // that does NOT touch the running app, so it can run *before* a reload tears the old app
  // down — most bad edits (invalid manifest/model) fail here, leaving the app serving.
  const prepareHost = async (): Promise<HostContext> => {
    const nonce = String(d.now());
    const { count } = await d.regenerate(root, manifestFile);
    if (count > 0) log(`  derived ${count} artifact(s)`);
    return d.makeHost(nonce);
  };

  let { host, app } = await startCycle();
  log("▲ dev server ready — watching for changes (Ctrl-C to stop)");

  let reloading = false;
  let queued = false;
  let stopped = false;
  let appRunning = true;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    if (stopped) return;
    if (reloading) {
      queued = true;
      return;
    }
    reloading = true;
    try {
      log("↻ change detected — reloading…");
      // Regenerate + rebuild the host BEFORE stopping the running app, so a bad edit
      // throws here and the current app keeps serving untouched.
      const nextHost = await prepareHost();
      if (stopped) return; // shutdown began mid-prepare: leave the running app to stop()
      await app.stop();
      appRunning = false;
      // Re-check after the async stop: if shutdown began while we were tearing the old
      // app down, don't start a replacement just to have stop() immediately kill it.
      if (stopped) return;
      app = await d.startApp(nextHost, { manifestPath: manifestFile, port: opts.port });
      appRunning = true;
      host = nextHost;
      log("✔ reloaded");
    } catch (err) {
      // Keep the dev server alive on a bad edit; the next save will retry.
      log(`✖ reload failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      reloading = false;
      if (queued && !stopped) {
        queued = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = reload();
    }, debounceMs);
  };

  let watcher: WatchHandle | undefined;
  if (host.watch) {
    watcher = host.watch((path) => {
      if (shouldReload(path, manifestFile)) schedule();
    });
  } else {
    log("⚠ file watching is not supported on this host — running once (no hot reload)");
  }

  return {
    async stop() {
      // Order matters: flag first so a queued/in-flight reload won't start a new app, cancel
      // any pending debounce, stop watching, then let any in-flight reload settle before the
      // final teardown so we stop exactly the app that is (or ends up) current.
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher?.close();
      await inFlight?.catch(() => {});
      if (appRunning) await app.stop();
    },
  };
}
