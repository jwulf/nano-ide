import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

// Guard for the `@nanobpm/urban/worker` authoring surface. Its job is to keep urban's OWN
// host adapters (runtime/adapters/node.ts, runtime/adapters/deno.ts and their node:* imports)
// out of the type graph a worker handler imports — the coupling that otherwise forces
// `@types/node` / `skipLibCheck` on a consumer just to typecheck a handler.
//
// This walks the *relative*-import closure from worker.ts, so it covers urban's own reachable
// sources. It does NOT follow the bare `@nanobpm/nano-sdk` dependency behind `AppApi.sdk`
// (engine/sdk.ts) — that dependency's own node-freeness is enforced separately by the
// `@nanobpm/nano-sdk` >= 1.2.2 floor in package.json (which pulls @camunda8 >= 10.0.0-alpha.20,
// whose public types no longer reference node:worker_threads). Together, urban's node-free
// relative closure + that SDK floor make a scaffolded stub (ADR 0056) typecheck on Node or Deno
// with no `@types/node` and no `skipLibCheck`.

const here = dirname(fileURLToPath(import.meta.url));

/** Collect relative-specifier imports/re-exports from a source file. */
function relativeSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Skip template-placeholder specifiers (e.g. `./${DOMAIN_DTS}` emitted as codegen strings),
    // which are not real static import paths.
    if (!m[1].includes("${")) out.push(m[1]);
  }
  return out;
}

/** Resolve a relative specifier (with explicit .ts) against a containing file. */
function resolveSpec(fromFile: string, spec: string): string {
  return normalize(join(dirname(fromFile), spec));
}

async function closureFrom(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      // A statically-extracted specifier that doesn't resolve to a real file (dynamic/generated
      // path). Skip it — the purity assertions below only care about files that actually exist.
      continue;
    }
    for (const spec of relativeSpecifiers(src)) {
      stack.push(resolveSpec(file, spec));
    }
  }
  return [...seen];
}

test("@nanobpm/urban/worker closure is free of node:* and Deno", async () => {
  const files = await closureFrom(join(here, "worker.ts"));
  // Sanity: the walk actually reached the core authoring modules.
  assert.ok(
    files.some((f) => f.endsWith(join("core", "modules", "workers.ts"))),
    "closure should include core/modules/workers.ts",
  );
  const offenders: string[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    if (/from\s+["']node:/.test(src)) offenders.push(`${file}: imports node:*`);
    if (/\bDeno\s*\./.test(src)) offenders.push(`${file}: references Deno.*`);
  }
  assert.deepEqual(offenders, [], `worker surface purity violations:\n${offenders.join("\n")}`);
});

test("@nanobpm/urban/worker excludes urban's host adapters (the barrel includes them)", async () => {
  const workerClosure = await closureFrom(join(here, "worker.ts"));
  const barrelClosure = await closureFrom(join(here, "index.ts"));
  const adapters = [
    join("runtime", "adapters", "node.ts"),
    join("runtime", "adapters", "deno.ts"),
  ];
  for (const a of adapters) {
    assert.ok(
      !workerClosure.some((f) => f.endsWith(a)),
      `worker closure must NOT include ${a}`,
    );
    assert.ok(
      barrelClosure.some((f) => f.endsWith(a)),
      `barrel closure is expected to include ${a} (control)`,
    );
  }
});

test("@nanobpm/urban/worker re-exports the authoring types", async () => {
  const src = await readFile(join(here, "worker.ts"), "utf8");
  for (const sym of ["AppJobHandler", "EngineJob", "JobHandler", "AppApi"]) {
    assert.match(src, new RegExp(`\\b${sym}\\b`), `worker.ts should export ${sym}`);
  }
  // Types-only surface: no value exports (nothing that would emit runtime code).
  assert.doesNotMatch(src, /^export\s+(?!type\b)/m, "worker.ts must be a types-only re-export");
});
