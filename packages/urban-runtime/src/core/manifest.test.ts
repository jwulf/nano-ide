import { test } from "node:test";
import assert from "node:assert/strict";
import { expandEnvString, expandEnv, parseManifest, workerJobType } from "./manifest.ts";

test("expandEnvString: var, default, and empty fallback", () => {
  const env: Record<string, string> = { FOO: "bar" };
  const look = (n: string) => env[n];
  assert.equal(expandEnvString("${FOO}", look), "bar");
  assert.equal(expandEnvString("${MISSING:-def}", look), "def");
  assert.equal(expandEnvString("${MISSING}", look), "");
  assert.equal(expandEnvString("x-${FOO}-${MISSING:-y}", look), "x-bar-y");
});

test("expandEnv recurses through objects and arrays", () => {
  const out = expandEnv(
    { a: "${X}", b: ["${Y:-2}", { c: "${X}" }], n: 5 },
    (n) => ({ X: "1" })[n],
  );
  assert.deepEqual(out, { a: "1", b: ["2", { c: "1" }], n: 5 });
});

test("parseManifest expands env in place", () => {
  const m = parseManifest('{"schemaVersion":1,"id":"x","name":"${NAME:-App}"}', () => undefined);
  assert.equal(m.name, "App");
});

test("workerJobType prefers taskType then type", () => {
  assert.equal(workerJobType({ taskType: "a", handler: "h" }), "a");
  assert.equal(workerJobType({ type: "b", handler: "h" }), "b");
  assert.equal(workerJobType({ handler: "h" }), undefined);
});
