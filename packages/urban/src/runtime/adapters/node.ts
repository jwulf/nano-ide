// Node adapter — implements HostContext against `node:*`. This is one of only two files
// (with deno.ts) allowed to touch a concrete runtime.

import { readFile, readdir, stat } from "node:fs/promises";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpServer,
  SqliteDb,
  WatchHandle,
} from "../core/host.ts";

export interface NodeHostOptions {
  /** Base directory relative paths resolve against. Default process.cwd(). */
  cwd?: string;
  log?: HostContext["log"];
  /**
   * When set, appended as a `?v=<nonce>` query to dynamic import URLs so a changed
   * handler/worker module is re-evaluated instead of served from the ESM cache. The
   * dev server bumps this on every reload; production leaves it unset.
   */
  importNonce?: string;
}

export function createNodeHost(opts: NodeHostOptions = {}): HostContext {
  const cwd = opts.cwd ?? process.cwd();
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
    runtime: "node",
    env: (name) => process.env[name],
    readTextFile: (p) => readFile(abs(p), "utf8"),
    async listDir(dir) {
      try {
        const entries = await readdir(abs(dir), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async exists(p) {
      try {
        await stat(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    openSqlite(path) {
      const db = new DatabaseSync(abs(path));
      return wrapNodeSqlite(db);
    },
    importModule: (p) => {
      const href =
        pathToFileURL(abs(p)).href + (opts.importNonce ? `?v=${opts.importNonce}` : "");
      return import(href) as Promise<Record<string, unknown>>;
    },
    async serveHttp(port, handler) {
      return await startNodeServer(port, handler);
    },
    watch(onChange) {
      const onFsEvent = (_event: unknown, filename: string | Buffer | null) => {
        if (filename) onChange(String(filename));
      };
      // Recursive watch is supported on macOS, Windows, and — since Node 19.1.0 — Linux.
      // This package requires Node >=22.6, so the recursive path is available on all three;
      // the try/catch only trips on an unusual platform, where we degrade honestly to a
      // non-recursive root watch (and warn) rather than silently miss nested changes.
      let w: FSWatcher;
      try {
        w = fsWatch(cwd, { recursive: true }, onFsEvent);
      } catch (err) {
        log("warn", "recursive file watch unavailable — nested changes may be missed", {
          error: String(err),
        });
        w = fsWatch(cwd, onFsEvent);
      }
      // A watcher error (e.g. the dir is removed) must not crash the dev server.
      w.on("error", (err) => log("warn", "file watch error", { error: String(err) }));
      return { close: () => w.close() } satisfies WatchHandle;
    },
    now: () => Date.now(),
    log,
  };
}

function wrapNodeSqlite(db: DatabaseSync): SqliteDb {
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

async function startNodeServer(port: number, handler: HttpHandler): Promise<HttpServer> {
  const server = createServer(async (nreq, nres) => {
    const chunks: Buffer[] = [];
    for await (const c of nreq) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(nreq.url ?? "/", "http://localhost");
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const req: HttpRequest = {
      method: nreq.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      text: () => Promise.resolve(bodyText),
    };
    try {
      const res = await handler(req);
      nres.statusCode = res.status ?? 200;
      for (const [k, v] of Object.entries(res.headers ?? {})) nres.setHeader(k, v);
      nres.end(res.body ?? "");
    } catch (err) {
      nres.statusCode = 500;
      nres.end(String(err));
    }
  });
  await new Promise<void>((res) => server.listen(port, res));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    stop: () => new Promise<void>((res) => server.close(() => res())),
  };
}
