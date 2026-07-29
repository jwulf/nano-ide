// nanobpmn Deno global shim for the Node fallback runtime (ADR 0036).
//
// The Node-first Run path (ADR 0038) spawns app code with
// `--experimental-strip-types` but no `Deno` global, so app/template sources
// that call `Deno.serve`/`Deno.env`/`Deno.readTextFile` throw "Deno is not
// defined". This module installs a minimal `globalThis.Deno` backed by Node
// built-ins so Deno-authored apps — and the scaffolder's URBAN/GUI templates —
// run unchanged under Node, honoring node-loader.mjs's stated intent.
//
// Scope: the surface the app tier + embedded SDK adapters actually use. The
// portable SDK adapters (`globalThis.Deno ?? process`) branch on this global,
// so it must satisfy every method they call (env/cwd/exit/readTextFile/
// writeTextFile/mkdir/readDir/stdin/stdout/addSignalListener) as well as
// `Deno.serve`. Loaded before app code via `--import node-register.mjs`.
import { writeSync as fsWriteSync } from "node:fs";
import {
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";

// Real Deno (or an earlier shim) already present — leave it untouched.
if (globalThis.Deno === undefined) {
  const enc = new TextEncoder();

  async function* readDir(path) {
    const ents = await fsReaddir(path, { withFileTypes: true });
    for (const e of ents) {
      yield {
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      };
    }
  }

  function toBytes(data) {
    return typeof data === "string" ? enc.encode(data) : data;
  }

  // Bridge one Node request/response pair through a web-standard handler, the
  // contract `Deno.serve` hands callers (Web `Request` in, `Response` out).
  function bridge(handler, hostname) {
    return async (nodeReq, nodeRes) => {
      try {
        // Node's IncomingMessage can leave `url`/`method` undefined on atypical
        // requests; default them so we never build a malformed web `Request`.
        const method = nodeReq.method ?? "GET";
        const path = nodeReq.url ?? "/";
        const url = `http://${nodeReq.headers.host ?? hostname}${path}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
          else if (v != null) headers.set(k, v);
        }
        const hasBody = method !== "GET" && method !== "HEAD";
        const init = { method, headers };
        if (hasBody) {
          const chunks = [];
          for await (const c of nodeReq) chunks.push(c);
          init.body = Buffer.concat(chunks);
        }
        const remoteAddr = {
          transport: "tcp",
          hostname: nodeReq.socket?.remoteAddress ?? "",
          port: nodeReq.socket?.remotePort ?? 0,
        };
        const webRes = await handler(new Request(url, init), { remoteAddr });
        nodeRes.statusCode = webRes.status;
        // `Headers.forEach` comma-joins duplicates, which is invalid for
        // `Set-Cookie` (Node wants an array). Set those separately from
        // `getSetCookie()` and skip the joined value in the general copy.
        webRes.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "set-cookie") nodeRes.setHeader(key, value);
        });
        const cookies = webRes.headers.getSetCookie?.() ?? [];
        if (cookies.length) nodeRes.setHeader("set-cookie", cookies);
        // Honour backpressure: when `write` returns false the socket buffer is
        // full, so await `drain` before writing more — otherwise a large
        // response accumulates in memory and stalls the event loop.
        const writeChunk = (chunk) =>
          nodeRes.write(chunk)
            ? Promise.resolve()
            : new Promise((resolve) => nodeRes.once("drain", resolve));
        if (webRes.body) {
          const reader = webRes.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) await writeChunk(value);
          }
        } else {
          const buf = Buffer.from(await webRes.arrayBuffer());
          if (buf.length) await writeChunk(buf);
        }
        nodeRes.end();
      } catch (err) {
        // Match Deno's default: log the handler error server-side and return a
        // generic 500 body, never the stack trace — leaking internals over the
        // wire is both an info-disclosure risk and a divergence from Deno.
        console.error(err);
        if (!nodeRes.headersSent) nodeRes.statusCode = 500;
        try {
          nodeRes.end("Internal Server Error");
        } catch {
          // response already destroyed — nothing more to do
        }
      }
    };
  }

  // Deno.serve(handler) | Deno.serve(options, handler) | Deno.serve({...,handler})
  function serve(arg1, arg2) {
    let options = {};
    let handler;
    if (typeof arg1 === "function") {
      handler = arg1;
    } else {
      options = arg1 ?? {};
      handler = arg2 ?? options.handler;
    }
    const port = options.port ?? 8000;
    const hostname = options.hostname ?? "0.0.0.0";
    // Real `Deno.serve` rejects a missing/invalid handler synchronously with a
    // TypeError; match that so misuse surfaces at call time, not on the first
    // request (where an undefined handler would otherwise 500 late).
    if (typeof handler !== "function") {
      throw new TypeError("Deno.serve requires a handler function");
    }
    // The actually-bound port; with `port: 0` Node picks an ephemeral one, so
    // resolve it from `server.address()` after listen (Deno reports the real
    // port, not the requested 0).
    let boundPort = port;
    const server = createServer(bridge(handler, hostname));
    // A Server-level `error` is a bind failure (e.g. AddrInUse); Deno.serve
    // treats that as fatal. Surface it cleanly instead of crashing on an
    // unhandled `error` event.
    server.on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
    const finished = new Promise((resolve) => server.once("close", resolve));
    server.listen(port, hostname, () => {
      const bound = server.address();
      if (bound && typeof bound === "object") boundPort = bound.port;
      const addr = { hostname, port: boundPort, transport: "tcp" };
      if (typeof options.onListen === "function") options.onListen(addr);
    });
    const shutdown = () =>
      new Promise((resolve) => server.close(() => resolve()));
    if (options.signal instanceof AbortSignal) {
      options.signal.addEventListener("abort", () => void shutdown(), { once: true });
    }
    return {
      finished,
      shutdown,
      ref: () => server.ref(),
      unref: () => server.unref(),
      get addr() {
        return { hostname, port: boundPort, transport: "tcp" };
      },
    };
  }

  class NotFound extends Error {}

  globalThis.Deno = {
    args: process.argv.slice(2),
    pid: process.pid,
    env: {
      get: (k) => process.env[k],
      set: (k, v) => {
        process.env[k] = v;
      },
      has: (k) => Object.prototype.hasOwnProperty.call(process.env, k),
      delete: (k) => {
        delete process.env[k];
      },
      toObject: () => ({ ...process.env }),
    },
    cwd: () => process.cwd(),
    exit: (code) => process.exit(code),
    addSignalListener: (sig, handler) => {
      process.on(sig, handler);
    },
    removeSignalListener: (sig, handler) => {
      process.off(sig, handler);
    },
    readTextFile: (path) => fsReadFile(path, "utf8"),
    writeTextFile: (path, data) => fsWriteFile(path, data),
    readFile: async (path) => new Uint8Array(await fsReadFile(path)),
    writeFile: (path, data) => fsWriteFile(path, data),
    mkdir: (path, opts) => fsMkdir(path, opts ?? {}),
    // Real `Deno.remove` throws `NotFound` on a missing path (no `force`), so
    // map Node's ENOENT to it rather than silently succeeding — otherwise
    // `Deno.errors.NotFound` would be unreachable and mask app bugs.
    remove: async (path, opts) => {
      try {
        await fsRm(path, { recursive: !!opts?.recursive });
      } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new NotFound(`No such file or directory: remove '${path}'`);
        }
        throw err;
      }
    },
    readDir,
    stat: async (path) => {
      const s = await fsStat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime };
    },
    stdout: {
      writeSync: (data) => fsWriteSync(1, toBytes(data)),
      // Deno's async `write` resolves to the byte count; use the non-blocking
      // stream write so heavy telemetry doesn't stall the event loop.
      write: (data) => {
        const bytes = toBytes(data);
        return new Promise((resolve, reject) =>
          process.stdout.write(bytes, (err) =>
            err ? reject(err) : resolve(bytes.length),
          ),
        );
      },
    },
    stderr: {
      writeSync: (data) => fsWriteSync(2, toBytes(data)),
      write: (data) => {
        const bytes = toBytes(data);
        return new Promise((resolve, reject) =>
          process.stderr.write(bytes, (err) =>
            err ? reject(err) : resolve(bytes.length),
          ),
        );
      },
    },
    stdin: {
      get readable() {
        return Readable.toWeb(process.stdin);
      },
    },
    errors: { NotFound },
    serve,
  };
}
