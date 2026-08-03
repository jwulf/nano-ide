import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGenIO } from "./fsio.ts";

test("listDir returns file names only, excluding subdirectories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-fsio-"));
  await writeFile(join(dir, "a.bpmn"), "<definitions/>");
  await writeFile(join(dir, "b.txt"), "x");
  await mkdir(join(dir, "nested"));
  const io = createNodeGenIO();
  const names = (await io.listDir(dir)).sort();
  assert.deepEqual(names, ["a.bpmn", "b.txt"]);
});

test("listDir returns empty for a missing directory", async () => {
  const io = createNodeGenIO();
  assert.deepEqual(await io.listDir(join(tmpdir(), "urban-fsio-does-not-exist-xyz")), []);
});

test("importModule caches on mtime: unchanged reuses, edit reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-fsio-imp-"));
  const file = join(dir, "mod.mjs");
  await writeFile(file, "export const v = 1;");
  const io = createNodeGenIO();

  const first = await io.importModule!(file);
  assert.equal(first.v, 1);
  // Same mtime → same module URL → cached instance (same object identity).
  const again = await io.importModule!(file);
  assert.equal(again, first);

  // Edit with a strictly newer mtime → new URL → fresh module with the new value.
  await new Promise((r) => setTimeout(r, 10));
  await writeFile(file, "export const v = 2;");
  const utimes = (await import("node:fs/promises")).utimes;
  const t = Date.now() / 1000 + 5;
  await utimes(file, t, t);
  const edited = await io.importModule!(file);
  assert.equal(edited.v, 2);
  assert.notEqual(edited, first);
});
