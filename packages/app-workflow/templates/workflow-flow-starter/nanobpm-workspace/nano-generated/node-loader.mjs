// nanobpmn Node ESM loader (ADR 0036).
//
// Makes Node honor the project's `deno.json` import map so worker/App code
// authored for Deno runs unchanged under Node — the fallback worker runtime on
// hosts with no Deno build (e.g. 32-bit ARM). Node's built-in type stripping
// (`--experimental-strip-types`) handles the `.ts` sources; this loader only
// rewrites *specifiers*. Registered off-thread by `node-register.mjs`.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

// The run's working directory is the directory that holds the `deno.json` whose
// import map applies — the project root for a RAD project run (`main.ts`), or the
// worker directory for a standalone worker (`worker.ts`). Both the map file and
// its relative values are resolved against it.
const baseDir = process.cwd();

function readImportMap() {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const raw = readFileSync(resolvePath(baseDir, name), "utf8");
      return JSON.parse(raw).imports ?? {};
    } catch {
      // not present / unreadable — try the next candidate
    }
  }
  return {};
}
const MAP = readImportMap();

// Deno import maps support exact keys and "prefix" keys ending in `/`.
function mapSpecifier(spec) {
  if (Object.prototype.hasOwnProperty.call(MAP, spec)) return MAP[spec];
  for (const [key, val] of Object.entries(MAP)) {
    if (key.endsWith("/") && spec.startsWith(key)) return val + spec.slice(key.length);
  }
  return null;
}

export async function resolve(specifier, context, next) {
  const mapped = mapSpecifier(specifier);
  if (mapped == null) return next(specifier, context);

  if (mapped.startsWith("npm:")) {
    // `npm:pkg@range` -> bare `pkg`, resolved from node_modules (run
    // `npm install` first). Strips the version range; keeps a leading @scope.
    let bare = mapped.slice(4);
    const at = bare.lastIndexOf("@");
    if (at > 0) bare = bare.slice(0, at);
    return next(bare, context);
  }
  if (mapped.startsWith("jsr:") || mapped.startsWith("http:") || mapped.startsWith("https:")) {
    throw new Error(
      `Node worker runtime cannot resolve '${specifier}' -> '${mapped}': ` +
        `jsr:/https: imports require Deno. Install Deno, or vendor the dependency via npm.`,
    );
  }
  // A relative path from the import map, resolved against the base dir.
  return next(pathToFileURL(resolvePath(baseDir, mapped)).href, context);
}
