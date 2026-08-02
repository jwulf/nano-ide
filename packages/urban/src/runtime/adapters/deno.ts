// Deno adapter — implements HostContext against the `Deno` global (plus `node:*` compat
// modules Deno supports). This and node.ts are the only files that touch a concrete runtime.
// A minimal ambient `Deno` declaration lets this compile under Node's tsc; at runtime the
// adapter is only ever selected when the real `Deno` global is present (see detect.ts).

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpServer,
  SqliteDb,
} from "../core/host.ts";

interface DenoHttpServer {
  finished: Promise<void>;
  shutdown(): Promise<void>;
}
interface DenoFsWatcher extends AsyncIterable<{ kind: string; paths: string[] }> {
  close(): void;
}
interface DenoGlobal {
  env: { get(name: string): string | undefined };
  cwd(): string;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): AsyncIterable<{ name: string; isFile: boolean }>;
  stat(path: string): Promise<unknown>;
  watchFs(paths: string | string[], options?: { recursive?: boolean }): DenoFsWatcher;
  serve(
    opts: { port: number; onListen?: (a: { port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): DenoHttpServer;
}
declare const Deno: DenoGlobal;

export interface DenoHostOptions {
  cwd?: string;
  log?: HostContext["log"];
  /** See NodeHostOptions.importNonce — appended as `?v=<nonce>` to dynamic imports. */
  importNonce?: string;
}

export function createDenoHost(opts: DenoHostOptions = {}): HostContext {
  const cwd = opts.cwd ?? Deno.cwd();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const log: HostContext["log"] =
    opts.log ??
    ((level, msg, fields) => {
      const line = fields ? `${msg} ${JSON.stringify(fields)}` : msg;
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
        `[urban] ${line}`,
      );
    });

  return {
    runtime: "deno",
    env: (name) => Deno.env.get(name),
    readTextFile: (p) => Deno.readTextFile(abs(p)),
    async listDir(dir) {
      try {
        const names: string[] = [];
        for await (const e of Deno.readDir(abs(dir))) {
          if (e.isFile) names.push(e.name);
        }
        return names;
      } catch {
        return [];
      }
    },
    async exists(p) {
      try {
        await Deno.stat(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    openSqlite(path) {
      const db = new DatabaseSync(abs(path));
      return wrapSqlite(db);
    },
    importModule: (p) => {
      const href =
        pathToFileURL(abs(p)).href + (opts.importNonce ? `?v=${opts.importNonce}` : "");
      return import(href) as Promise<Record<string, unknown>>;
    },
    async serveHttp(port, handler) {
      return startDenoServer(port, handler);
    },
    watch(onChange) {
      const w = Deno.watchFs(cwd, { recursive: true });
      let closed = false;
      (async () => {
        try {
          for await (const ev of w) {
            for (const p of ev.paths) onChange(p);
          }
        } catch {
          /* the iterator throws when close() is called mid-await; ignore */
        }
      })();
      return {
        close: () => {
          if (closed) return;
          closed = true;
          w.close();
        },
      };
    },
    now: () => Date.now(),
    log,
  };
}

function wrapSqlite(db: DatabaseSync): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const stmt = db.prepare(sql);
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    close: () => db.close(),
  };
}

function startDenoServer(port: number, handler: HttpHandler): Promise<HttpServer> {
  return new Promise<HttpServer>((resolveServer) => {
    const server = Deno.serve({ port, onListen: ({ port: p }) => {
      resolveServer({
        port: p,
        stop: () => server.shutdown(),
      });
    } }, async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const bodyText = request.body ? await request.text() : "";
      const req: HttpRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        text: () => Promise.resolve(bodyText),
      };
      const res = await handler(req);
      return new Response(res.body ?? "", { status: res.status ?? 200, headers: res.headers });
    });
  });
}
