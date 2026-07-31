// The runtime orchestrator: createUrbanApp() takes a manifest + a host + an engine and
// materializes the app by mounting each module. Hosts (CLI/IDE/console/bare process) call
// this the same way; a host may mount a subset via `mount` flags (e.g. the console mounts
// its own surfaces but reuses deploy + workers + datasource).

import type { AppApi, Mounted } from "./context.ts";
import type { EngineClient, HostContext, HttpServer } from "./host.ts";
import { loadManifest, type AppManifest } from "./manifest.ts";
import { validateManifest } from "./validate.ts";
import { makeRouter, type Route } from "./router.ts";
import { deployModels } from "./modules/deploy.ts";
import { provisionData, DataLayer } from "./modules/datasource.ts";
import { mountWorkers } from "./modules/workers.ts";
import { mountSurfaces } from "./modules/surfaces.ts";
import { mountTriggers } from "./modules/triggers.ts";
import { mountSecurity, type SecurityPolicy } from "./modules/security.ts";

export interface MountFlags {
  deploy?: boolean;
  data?: boolean;
  workers?: boolean;
  surfaces?: boolean;
  triggers?: boolean;
  security?: boolean;
}

export interface CreateUrbanAppOptions {
  host: HostContext;
  engine: EngineClient;
  /** App root directory; manifest paths resolve relative to it. Default ".". */
  root?: string;
  /** Provide a manifest object directly, or… */
  manifest?: AppManifest;
  /** …a path to load it from (relative to root). Default "nano.app.json". */
  manifestPath?: string;
  /** HTTP port for surfaces/triggers. Default from PORT env or 8090. */
  port?: number;
  /** Which modules to mount (all true by default). */
  mount?: MountFlags;
}

export interface UrbanApp {
  readonly manifest: AppManifest;
  readonly root: string;
  /** Materialize the app (deploy → data → workers → surfaces/triggers). */
  start(): Promise<void>;
  /** Tear everything down cleanly (graceful worker unsubscribe, close DB + server). */
  stop(): Promise<void>;
  /** A structured snapshot of what is mounted. */
  inspect(): Record<string, unknown>;
  /** The provisioned data layer (available after start when `data` is mounted). */
  readonly data: DataLayer | undefined;
  readonly security: SecurityPolicy | undefined;
  readonly httpPort: number | undefined;
}

export async function createUrbanApp(opts: CreateUrbanAppOptions): Promise<UrbanApp> {
  const host = opts.host;
  const root = opts.root ?? ".";
  const manifest = validateManifest(
    opts.manifest ?? (await loadManifest(host, `${root.replace(/\/+$/, "")}/${opts.manifestPath ?? "nano.app.json"}`)),
  );
  const engine = opts.engine;
  const flags: Required<MountFlags> = {
    deploy: opts.mount?.deploy ?? true,
    data: opts.mount?.data ?? true,
    workers: opts.mount?.workers ?? true,
    surfaces: opts.mount?.surfaces ?? true,
    triggers: opts.mount?.triggers ?? true,
    security: opts.mount?.security ?? true,
  };
  const ctx = { manifest, host, engine, root };

  let data: DataLayer | undefined;
  let security: SecurityPolicy | undefined;
  let server: HttpServer | undefined;
  const mounted: Mounted[] = [];
  const describe: Record<string, unknown> = {};
  let started = false;
  let httpPort: number | undefined;

  const port = opts.port ?? Number(host.env("PORT") ?? "8090");

  const app: UrbanApp = {
    manifest,
    root,
    get data() {
      return data;
    },
    get security() {
      return security;
    },
    get httpPort() {
      return httpPort;
    },

    async start() {
      if (started) throw new Error("app already started");
      started = true;

      if (flags.security) security = mountSecurity(ctx);
      if (flags.deploy) describe.deploy = await deployModels(ctx);

      data = flags.data ? await provisionData(ctx) : new DataLayer(new Map(), undefined, {});
      const api: AppApi = {
        manifest,
        data,
        engine,
        env: (n) => host.env(n),
        log: (l, m, f) => host.log(l, m, f),
      };

      if (flags.workers) {
        const w = await mountWorkers(ctx, api);
        mounted.push(w);
        describe.workers = w.describe?.();
      }

      const routes: Route[] = [];
      if (flags.surfaces) {
        const s = mountSurfaces(ctx, api);
        routes.push(...s.routes);
        describe.surfaces = s.describe();
      }
      if (flags.triggers) {
        const t = mountTriggers(ctx, api);
        routes.push(...t.routes);
        describe.triggers = t.describe();
      }
      if (security) describe.security = security.describe();
      if (data) describe.data = data.describe();

      if (routes.length > 0) {
        // A tiny liveness route.
        routes.push({
          method: "GET",
          path: "/healthz",
          handler: () => ({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true, app: manifest.id }),
          }),
        });
        server = await host.serveHttp(port, makeRouter(routes));
        httpPort = server.port;
        host.log("info", "urban app serving surfaces/triggers", { port: httpPort, routes: routes.length });
      }
      host.log("info", `urban app "${manifest.id}" started`, {});
    },

    async stop() {
      if (server) await server.stop();
      for (const m of mounted) await m.stop();
      if (data) data.closeAll();
      await engine.close();
      started = false;
    },

    inspect() {
      return { app: manifest.id, name: manifest.name, root, httpPort, ...describe };
    },
  };

  return app;
}
