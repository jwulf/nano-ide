// Feature coverage for the Slack connector pack. Guards the *design→runtime
// seam* drift class (ADR 0033 §1): the element template a maker drags from the
// palette (`zeebe:taskDefinition:type`) must resolve to a declared, existing
// worker of the same job `type`. If any of the manifest / template / worker
// artifacts drift apart, a task would stamp with no backing worker — the exact
// failure mode ADR 0033 turns into a typed diagnostic. Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p: string): any => JSON.parse(readFileSync(join(here, p), "utf8"));

const manifest = readJson("nano-ide.ext.json");

test("manifest declares the inbound + outbound edges", () => {
  assert.equal(manifest.id, "nano-ide-connector-slack");
  assert.equal(manifest.kind, "trigger");
  assert.ok(Array.isArray(manifest.triggerSources) && manifest.triggerSources.length > 0, "inbound triggerSources[]");
  assert.ok(Array.isArray(manifest.components) && manifest.components.length > 0, "component templates");
  assert.ok(Array.isArray(manifest.workers) && manifest.workers.length > 0, "outbound workers[]");
});

test("every declared file exists on disk", () => {
  for (const s of manifest.triggerSources ?? []) {
    if (s.driver) assert.ok(existsSync(join(here, s.driver)), `driver missing: ${s.driver}`);
  }
  for (const c of manifest.components ?? []) {
    assert.ok(existsSync(join(here, c)), `component template missing: ${c}`);
  }
  for (const w of manifest.workers ?? []) {
    assert.ok(existsSync(join(here, w.entry)), `worker entry missing: ${w.entry}`);
  }
});

// Extract the `zeebe:taskDefinition:type` value from an element template.
function taskDefType(tmpl: any) {
  const p = (tmpl.properties ?? []).find(
    (x: any) => x?.binding?.type === "zeebe:taskDefinition:type",
  );
  return p?.value;
}

test("each component template's taskDefinition:type has a backing worker (the seam)", () => {
  const workerTypes = new Set((manifest.workers ?? []).map((w: any) => w.type));
  for (const rel of manifest.components ?? []) {
    const tmpl = readJson(rel);
    const type = taskDefType(tmpl);
    assert.ok(type, `${rel}: no zeebe:taskDefinition:type binding`);
    assert.ok(
      workerTypes.has(type),
      `${rel}: taskDefinition:type "${type}" has no backing workers[] entry (declares: ${[...workerTypes].join(", ")})`,
    );
  }
});

test("the worker entry registers defineWorker for its declared type", () => {
  for (const w of manifest.workers ?? []) {
    const src = readFileSync(join(here, w.entry), "utf8");
    assert.ok(src.includes("defineWorker"), `${w.entry}: does not call defineWorker`);
    assert.ok(
      src.includes(`type: "${w.type}"`),
      `${w.entry}: does not register the declared type "${w.type}"`,
    );
  }
});

test("no secret is inlined — credential config fields are env-pointers (ADR 0027 §5)", () => {
  const fields = [
    ...(manifest.workers ?? []).flatMap((w: any) => w.configFields ?? []),
    ...(manifest.triggerSources ?? []).flatMap((s: any) => s.configFields ?? []),
  ];
  for (const f of fields) {
    // A credential field must offer an env pointer, never a default value that
    // could carry a token into the committed manifest.
    if (/token|secret|password|key/i.test(f.key)) {
      assert.ok(f.env, `configField "${f.key}" looks like a secret but has no env pointer`);
      assert.ok(!f.default, `configField "${f.key}" must not carry a default secret value`);
    }
  }
});
