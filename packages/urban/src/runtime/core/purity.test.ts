import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Architectural guard (ADR 0052): core/ is runtime-agnostic. It must not import `node:*`
// modules or reference the `Deno` global. The only runtime-coupled code lives in adapters/.

const coreDir = dirname(fileURLToPath(import.meta.url));

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("core/ has zero runtime-specific imports", async () => {
  const offenders: string[] = [];
  for (const file of await tsFiles(coreDir)) {
    const src = await readFile(file, "utf8");
    if (/from\s+["']node:/.test(src)) offenders.push(`${file}: imports node:*`);
    // `Deno` as an identifier (not inside a comment word like "Deno adapter")
    if (/\bDeno\s*\./.test(src)) offenders.push(`${file}: references Deno.*`);
  }
  assert.deepEqual(offenders, [], `core purity violations:\n${offenders.join("\n")}`);
});
