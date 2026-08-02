// Tests for the scaffolder: token substitution and the full/headless presets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, slugify } from "./scaffold.ts";
import { main } from "./cli.ts";

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

test("names with quotes/backslashes/control chars stay valid JSON in the manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-scaffold-"));
  const tricky = 'Ac "me"\\Co\tInc';
  await scaffold({ name: tricky, dir, preset: "full" });
  const manifest = JSON.parse(await readFile(join(dir, "nano.app.json"), "utf8"));
  assert.equal(manifest.name, tricky);
});

test("Node is the default host: no deno.json, README drops the Deno block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-node-"));
  const res = await scaffold({ name: "Node App", dir });
  assert.ok(!res.files.includes("deno.json"), "no deno.json in the file list");
  assert.ok(!(await exists(join(dir, "deno.json"))), "no deno.json on disk");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(!/deno task/.test(readme), "Deno usage block is stripped");
  assert.ok(!/if:deno/.test(readme), "conditional markers are stripped");
});

test("scaffolded package.json exposes gen and gen:check scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-gen-"));
  await scaffold({ name: "Gen App", dir });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.gen, "urban gen");
  assert.equal(pkg.scripts["gen:check"], "urban gen --check");
  assert.equal(pkg.scripts.dev, "urban dev");
});

test("--deno keeps deno.json and the Deno block, with markers removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-deno-"));
  const res = await scaffold({ name: "Deno App", dir, deno: true });
  assert.ok(res.files.includes("deno.json"), "deno.json in the file list");
  assert.ok(await exists(join(dir, "deno.json")), "deno.json on disk");
  const denoCfg = JSON.parse(await readFile(join(dir, "deno.json"), "utf8"));
  assert.ok(denoCfg.tasks.gen, "deno gen task present");
  assert.ok(denoCfg.tasks["gen:check"], "deno gen:check task present");
  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.ok(/deno task check/.test(readme), "Deno usage block is kept");
  assert.ok(!/if:deno/.test(readme), "conditional markers are removed");
});

test("CLI tolerates a `--` end-of-options delimiter (npm create injects it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-delim-"));
  // e.g. `npm create urban-app -- "Delim App" --dir <dir> --deno`
  const code = await main(["Delim App", "--dir", dir, "--", "--deno"]);
  assert.equal(code, 0, "does not error on `--`");
  assert.ok(await exists(join(dir, "deno.json")), "--deno after `--` still applied");
});
