// Tests for the scaffolder: token substitution and the full/headless presets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, slugify } from "./scaffold.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("slugify normalizes names", () => {
  assert.equal(slugify("My Cool App"), "my-cool-app");
  assert.equal(slugify("  --Weird__Name!!  "), "weird-name");
  assert.equal(slugify("!!!"), "urban-app");
});

test("full preset scaffolds a runnable app with substituted tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-full-"));
  const res = await scaffold({ name: "Hello Urban", dir, preset: "full" });
  assert.equal(res.id, "hello-urban");
  assert.ok(res.files.includes("nano.app.json"));

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.id, "hello-urban");
  assert.equal(manifest.name, "Hello Urban");
  assert.ok(manifest.surfaces, "full keeps surfaces");
  assert.ok(manifest.triggers, "full keeps triggers");
  assert.ok(manifest.models.forms, "full keeps form models");
  assert.ok(await exists(join(dir, "forms")), "full keeps the forms dir");

  // _gitignore is materialized as .gitignore
  assert.ok(await exists(join(dir, ".gitignore")));
});

test("headless preset drops surfaces, triggers and forms (workers only)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-headless-"));
  const res = await scaffold({ name: "Batch Job", dir, preset: "headless" });

  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.surfaces, undefined);
  assert.equal(manifest.triggers, undefined);
  assert.equal(manifest.models?.forms, undefined);
  assert.ok(manifest.workers, "headless keeps workers");
  assert.ok(!res.files.some((f) => f.startsWith("forms/")), "no form files written");
  assert.ok(!(await exists(join(dir, "forms"))), "no forms dir");
});
