// Unit tests for the pack tour contract (ADR 0049 §7), the rules
// scripts/validate-manifests.mjs enforces at publish time. Run:
//   node --test "scripts/lib/**/*.test.mjs"
//
// These guard the defect classes raised in review of the tours[] PR:
//   1. required/optional string fields (id / title / body / blurb / route /
//      copy / verifyPollingJobType / selector) accepted empty or non-string
//      values via truthiness checks, and
//   2. optional array fields (profiles / preconditions) crashed the validator
//      with a "not iterable" TypeError when given a non-array, instead of
//      reporting a structured error.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTour,
  checkTours,
  checkTourStep,
} from "./tour-validation.mjs";

/** Collect the messages a validation run reports. */
function collect(run) {
  const errs = [];
  run((m) => errs.push(m));
  return errs;
}

/** A minimal valid tour (one note step), spread-overridable per test. */
const validTour = () => ({
  id: "t1",
  title: "A journey",
  blurb: "Learn the thing",
  steps: [{ id: "s1", title: "Start", body: "Do this", kind: "note" }],
});

test("a well-formed tour passes with no errors", () => {
  const errs = collect((fail) => checkTours([validTour()], fail));
  assert.deepEqual(errs, []);
});

// --- Defect class 1: optional string fields must be non-empty strings --------

test("a handoff step with copy: '' is rejected", () => {
  const errs = collect((fail) =>
    checkTourStep(
      { id: "s", title: "t", body: "b", kind: "handoff", copy: "" },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(
    errs.some((e) => e.includes("needs something to copy")),
    `expected a copy error, got: ${JSON.stringify(errs)}`,
  );
});

test("a handoff step with a non-string copy is rejected", () => {
  const errs = collect((fail) =>
    checkTourStep(
      { id: "s", title: "t", body: "b", kind: "handoff", copy: 123 },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(
    errs.some((e) => e.includes("needs something to copy")),
    `expected a copy error, got: ${JSON.stringify(errs)}`,
  );
});

test("a spotlight step with a non-string selector is rejected", () => {
  const errs = collect((fail) =>
    checkTourStep(
      { id: "s", title: "t", body: "b", kind: "spotlight", selector: 42 },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(
    errs.some((e) => e.includes("needs a selector")),
    `expected a selector error, got: ${JSON.stringify(errs)}`,
  );
});

test("a non-handoff step carrying copy: '' still trips the 'only on handoff' rule", () => {
  // Empty string is present-but-invalid; a truthiness check would have missed it.
  const errs = collect((fail) =>
    checkTourStep(
      { id: "s", title: "t", body: "b", kind: "note", copy: "" },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(
    errs.some((e) => e.includes("only apply to a handoff step")),
    `expected an 'only on handoff' error, got: ${JSON.stringify(errs)}`,
  );
});

test("a handoff step with a non-string verifyPollingJobType is rejected", () => {
  const errs = collect((fail) =>
    checkTourStep(
      {
        id: "s",
        title: "t",
        body: "b",
        kind: "handoff",
        copy: "run it",
        verifyPollingJobType: 123,
      },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(
    errs.some((e) => e.includes("verifyPollingJobType must be a non-empty string")),
    `expected a verifyPollingJobType error, got: ${JSON.stringify(errs)}`,
  );
});

// A required string field typed by the host must be a non-empty string; a
// truthiness check would let `id: 123` / `title: true` / `route: 5` through.

test("a step with a non-string id/title/body is rejected", () => {
  const errs = collect((fail) =>
    checkTourStep(
      { id: 123, title: true, body: 0, kind: "note" },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(errs.some((e) => e.includes("step needs an id")));
  assert.ok(errs.some((e) => e.includes("needs a title")));
  assert.ok(errs.some((e) => e.includes("needs a body")));
});

test("a step with a non-string route is rejected as a bad path", () => {
  const errs = collect((fail) =>
    checkTourStep(
      { id: "s", title: "t", body: "b", kind: "note", route: 123 },
      "tour x",
      fail,
      new Set(),
      false,
    ),
  );
  assert.ok(errs.some((e) => e.includes("route must be an absolute console path")));
});

test("a tour with a non-string title/blurb is rejected", () => {
  const errs = collect((fail) =>
    checkTour({ ...validTour(), title: 1, blurb: true }, fail, new Set()),
  );
  assert.ok(errs.some((e) => e.includes("needs a title")));
  assert.ok(errs.some((e) => e.includes("needs a blurb")));
});

// --- Defect class 2: optional arrays must not crash the validator ------------

test("profiles as a non-array reports a structured error instead of throwing", () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = collect((fail) =>
      checkTour({ ...validTour(), profiles: 1 }, fail, new Set()),
    );
  });
  assert.ok(
    errs.some((e) => e.includes("profiles must be an array")),
    `expected a profiles error, got: ${JSON.stringify(errs)}`,
  );
});

test("preconditions as a non-array reports a structured error instead of throwing", () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = collect((fail) =>
      checkTour(
        { ...validTour(), preconditions: "hasProject" },
        fail,
        new Set(),
      ),
    );
  });
  assert.ok(
    errs.some((e) => e.includes("preconditions must be an array")),
    `expected a preconditions error, got: ${JSON.stringify(errs)}`,
  );
});

// --- Regression guards for rules that already worked -------------------------

test("valid profiles and preconditions arrays still pass", () => {
  const errs = collect((fail) =>
    checkTour(
      { ...validTour(), profiles: ["studio"], preconditions: ["hasProject"] },
      fail,
      new Set(),
    ),
  );
  assert.deepEqual(errs, []);
});

test("an unknown profile in an array is still reported", () => {
  const errs = collect((fail) =>
    checkTour({ ...validTour(), profiles: ["nope"] }, fail, new Set()),
  );
  assert.ok(errs.some((e) => e.includes("bad profile: nope")));
});

test("duplicate tour ids are reported across a manifest", () => {
  const errs = collect((fail) =>
    checkTours([validTour(), validTour()], fail),
  );
  assert.ok(errs.some((e) => e.includes("duplicate tour id: t1")));
});

test("tours as a non-array is rejected without iterating", () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = collect((fail) => checkTours(1, fail));
  });
  assert.deepEqual(errs, ["tours must be an array"]);
});
