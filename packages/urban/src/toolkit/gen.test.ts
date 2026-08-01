import { test } from "node:test";
import assert from "node:assert/strict";
import { runGen, collectArtifacts, type GenIO } from "./gen.ts";

/** In-memory filesystem for deterministic, IO-free gen tests. */
function memIO(files: Record<string, string>): GenIO & { files: Record<string, string> } {
  return {
    files,
    async readText(p) {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    async writeText(p, c) {
      files[p] = c;
    },
    async listDir(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes("/")) names.add(rest);
        }
      }
      return [...names];
    },
    async exists(p) {
      return p in files;
    },
  };
}

const MANIFEST = JSON.stringify({
  id: "demo",
  data: { default: "app" },
  models: { processes: ["processes/*.bpmn"] },
  types: { greeting: { table: "greetings", fields: { who: { type: "string" } } } },
});

const BPMN = `<bpmn:process id="p" xmlns:bpmn="x" xmlns:zeebe="y">
  <bpmn:serviceTask id="T"><bpmn:extensionElements>
    <zeebe:taskDefinition type="demo.do" />
  </bpmn:extensionElements></bpmn:serviceTask>
</bpmn:process>`;

function fixture(): Record<string, string> {
  return {
    "/app/nano.app.json": MANIFEST,
    "/app/processes/p.bpmn": BPMN,
  };
}

test("runGen writes migrations and the worker index", async () => {
  const io = memIO(fixture());
  const res = await runGen({ root: "/app", io });
  const paths = res.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, [
    "nano-generated/app.schema.sql",
    "nano-generated/worker-io.d.ts",
  ]);
  assert.ok(io.files["/app/nano-generated/app.schema.sql"].includes("CREATE TABLE"));
  assert.ok(io.files["/app/nano-generated/worker-io.d.ts"].includes("demo.do"));
});

test("gen --check reports no drift right after a write", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  const res = await runGen({ root: "/app", io, check: true });
  assert.deepEqual(res.drift, []);
});

test("gen --check detects drift when a generated file is stale", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  io.files["/app/nano-generated/worker-io.d.ts"] = "// stale";
  const res = await runGen({ root: "/app", io, check: true });
  assert.deepEqual(res.drift, ["nano-generated/worker-io.d.ts"]);
});

test("collectArtifacts touches no writes", async () => {
  const io = memIO(fixture());
  const before = Object.keys(io.files).length;
  await collectArtifacts({ root: "/app", io });
  assert.equal(Object.keys(io.files).length, before);
});
