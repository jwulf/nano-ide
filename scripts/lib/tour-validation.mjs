// Guided-journey (tour) validation for pack manifests (ADR 0049 §7).
//
// Extracted from validate-manifests.mjs as a pure, importable unit for two
// reasons: the rules can now be unit-tested (the validator script runs its
// directory scan on import, so it cannot be imported by a test), and the
// script and its tests share one source of truth for the tour contract — no
// drift. A deliberate mirror of the rules the console adapter applies at
// runtime and of the host parser in nanobpmn server/src/console/extensions.rs.

// Guided-journey vocabulary (ADR 0049); mirror of TourGate / TourStepKind in
// packages/ext-types and TourGate / TourStepKind in the host's extensions.rs.
export const TOUR_GATES = new Set([
  "hasJsRuntime",
  "hasProject",
  "hasCluster",
  "hasTraces",
]);
export const TOUR_STEP_KINDS = new Set(["spotlight", "note", "handoff"]);
export const TOUR_PROFILES = new Set(["studio", "observe"]);
// Gates that can resolve to "repair" rather than just skipping a step. A step
// gated on one of these without a `repair` is silently dropped by the console —
// which is the honest degradation, but it costs the user the very hint they
// needed, so make the author supply one.
export const TOUR_REPAIRABLE_GATES = new Set(["hasJsRuntime", "hasCluster"]);

// A pack manifest is untrusted third-party JSON, so a field the host types as an
// optional string must be exactly that: absent, or a non-empty string. Truthiness
// checks alone let `""` and non-strings like `123` slip through publish-time
// validation, only for the host's serde to reject the whole manifest — or the
// console to silently drop the step — which is worse than a clean error here.
const isMissing = (v) => v === undefined || v === null;
const badString = (v) => typeof v !== "string" || v.trim() === "";

/** Validate one tour step. `nested` marks a `repair` step: those do not nest. */
export function checkTourStep(s, at, fail, stepIds, nested) {
  const where = `${at} step ${s?.id ?? "(no id)"}`;
  if (!s?.id) fail(`${at}: step needs an id`);
  else if (stepIds.has(s.id)) fail(`${at}: duplicate step id: ${s.id}`);
  else stepIds.add(s.id);
  if (!s?.title) fail(`${where}: needs a title`);
  if (!s?.body) fail(`${where}: needs a body`);
  const kind = s?.kind ?? "spotlight";
  if (!TOUR_STEP_KINDS.has(kind)) fail(`${where}: bad kind: ${s.kind}`);
  if (s?.route !== undefined && !String(s.route).startsWith("/")) {
    fail(`${where}: route must be an absolute console path`);
  }
  // A spotlight anchors on a selector; a handoff hands the user a command to
  // copy. Each must be a non-empty string when its kind requires it, and absent
  // on the kinds it does not apply to.
  if (kind === "spotlight" && badString(s?.selector)) {
    fail(`${where}: a spotlight step needs a selector`);
  }
  if (kind === "handoff" && badString(s?.copy)) {
    fail(`${where}: a handoff step needs something to copy`);
  }
  if (
    kind !== "handoff" &&
    (!isMissing(s?.copy) || !isMissing(s?.verifyPollingJobType))
  ) {
    fail(`${where}: copy/verifyPollingJobType only apply to a handoff step`);
  }
  if (kind !== "spotlight" && !isMissing(s?.selector)) {
    fail(`${where}: selector only applies to a spotlight step`);
  }
  // verifyPollingJobType is optional on a handoff, but when present it names a
  // job type the console polls for — an empty or non-string value can never match.
  if (
    kind === "handoff" &&
    !isMissing(s?.verifyPollingJobType) &&
    badString(s?.verifyPollingJobType)
  ) {
    fail(`${where}: verifyPollingJobType must be a non-empty string`);
  }
  if (s?.precondition !== undefined) {
    if (!TOUR_GATES.has(s.precondition)) {
      fail(`${where}: unknown precondition gate: ${s.precondition}`);
    } else if (TOUR_REPAIRABLE_GATES.has(s.precondition) && !s.repair) {
      fail(
        `${where}: gated on ${s.precondition}, which can demand a repair step, but none is authored`,
      );
    }
  }
  if (s?.repair !== undefined) {
    if (nested) fail(`${where}: a repair step cannot itself have a repair`);
    else checkTourStep(s.repair, at, fail, stepIds, true);
  }
}

/** Validate one tour. `tourIds` accumulates ids across a manifest for dup detection. */
export function checkTour(t, fail, tourIds) {
  const at = `tour ${t?.id ?? "(no id)"}`;
  if (!t?.id) fail("tour needs an id");
  else if (tourIds.has(t.id)) fail(`duplicate tour id: ${t.id}`);
  else tourIds.add(t.id);
  if (!t?.title) fail(`${at}: needs a title`);
  // The picker renders blurb on the card, so an empty one ships a blank card.
  if (!t?.blurb) fail(`${at}: needs a blurb (the journey-picker card line)`);
  // profiles/preconditions are optional string arrays; a non-array (e.g.
  // `profiles: 1`) must be reported as a structured error, never crash the
  // for..of below with a "not iterable" TypeError that aborts the whole run.
  if (t?.profiles !== undefined && !Array.isArray(t.profiles)) {
    fail(`${at}: profiles must be an array`);
  }
  for (const p of Array.isArray(t?.profiles) ? t.profiles : []) {
    if (!TOUR_PROFILES.has(p)) fail(`${at}: bad profile: ${p}`);
  }
  if (t?.preconditions !== undefined && !Array.isArray(t.preconditions)) {
    fail(`${at}: preconditions must be an array`);
  }
  for (const g of Array.isArray(t?.preconditions) ? t.preconditions : []) {
    if (!TOUR_GATES.has(g)) fail(`${at}: unknown precondition gate: ${g}`);
  }
  if (t?.successWhen !== undefined && !TOUR_GATES.has(t.successWhen)) {
    fail(`${at}: unknown successWhen gate: ${t.successWhen}`);
  }
  if (!Array.isArray(t?.steps) || t.steps.length === 0) {
    fail(`${at}: needs a non-empty steps array`);
    return;
  }
  // ADR 0049 caps a journey at five steps: one needing a detour is split, not padded.
  if (t.steps.length > 5) fail(`${at}: ${t.steps.length} steps — the cap is 5`);
  const stepIds = new Set();
  for (const s of t.steps) {
    checkTourStep(s, at, fail, stepIds, false);
  }
}

/** Validate a manifest's whole `tours` field. Absent is valid (tours are optional). */
export function checkTours(tours, fail) {
  if (tours === undefined) return;
  if (!Array.isArray(tours)) {
    fail("tours must be an array");
    return;
  }
  const tourIds = new Set();
  for (const t of tours) checkTour(t, fail, tourIds);
}
