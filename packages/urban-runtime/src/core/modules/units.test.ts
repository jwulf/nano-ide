import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHandler } from "./workers.ts";
import { evalCorrelation } from "./triggers.ts";

test("resolveHandler prefers handlers[jobType], then segment, then default", () => {
  const fn = () => {};
  assert.equal(resolveHandler({ handlers: { "a.b": fn } }, "a.b"), fn);
  assert.equal(resolveHandler({ "a.b": fn }, "a.b"), fn);
  assert.equal(resolveHandler({ handlers: { b: fn } }, "a.b"), fn); // last segment
  assert.equal(resolveHandler({ default: fn }, "a.b"), fn);
  assert.equal(resolveHandler({}, "a.b"), undefined);
});

test("evalCorrelation resolves = body.path, literals, and misses", () => {
  const scope = { body: { taskId: "T1", nested: { k: 7 } }, headers: {}, query: {} };
  assert.equal(evalCorrelation("= body.taskId", scope), "T1");
  assert.equal(evalCorrelation("=body.nested.k", scope), "7");
  assert.equal(evalCorrelation("literal", scope), "literal");
  assert.equal(evalCorrelation("= body.missing", scope), undefined);
  assert.equal(evalCorrelation(undefined, scope), undefined);
});
