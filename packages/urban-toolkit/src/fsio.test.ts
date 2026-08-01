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
