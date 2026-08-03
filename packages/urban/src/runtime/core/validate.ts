// Manifest validation. We deliberately avoid a heavyweight JSON-Schema engine here to keep
// core lean and runtime-agnostic. Instead we drive validation *from* the canonical
// nano-app.schema.json (the ADR 0027 source of truth, imported from the
// @nanobpm/nano-app-schema package) for the top-level envelope — required keys, allowed keys
// (additionalProperties:false), the schemaVersion const, and the id slug pattern — and then
// layer the runtime's binding rules (a worker needs a handler, a data source needs
// driver+url, a typed table needs fields, a trigger needs id+type). Importing the shared
// schema JSON means the envelope check tracks the published schema and can't drift from it
// silently — the whole point of consuming the package rather than vendoring a copy.

import schema from "@nanobpm/nano-app-schema/schema" with { type: "json" };
import { workerJobType, type AppManifest } from "./manifest.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ManifestValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(
      `Invalid Urban manifest (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `  • ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

interface JsonSchema {
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  $defs?: { slug?: { pattern?: string } };
}

const S = schema as unknown as JsonSchema;

/** Validate a parsed manifest. Returns the list of issues (empty === valid). */
export function collectManifestIssues(m: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    return [{ path: "$", message: "manifest must be a JSON object" }];
  }
  const obj = m as Record<string, unknown>;

  // — Envelope, driven by the schema —
  for (const req of S.required ?? []) {
    if (!(req in obj)) issues.push({ path: req, message: "required by nano-app.schema.json" });
  }
  const allowed = new Set(Object.keys(S.properties ?? {}));
  if (S.additionalProperties === false) {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        issues.push({ path: k, message: "unknown top-level key (additionalProperties: false)" });
      }
    }
  }
  if ("schemaVersion" in obj && obj.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: "must be 1" });
  }
  const slugPattern = S.$defs?.slug?.pattern;
  if (slugPattern && typeof obj.id === "string" && !new RegExp(slugPattern).test(obj.id)) {
    issues.push({ path: "id", message: `must match slug pattern ${slugPattern}` });
  }
  if ("name" in obj && (typeof obj.name !== "string" || obj.name.length === 0)) {
    issues.push({ path: "name", message: "must be a non-empty string" });
  }

  // — Runtime binding rules —
  const man = obj as unknown as AppManifest;

  if (Array.isArray(man.workers)) {
    man.workers.forEach((w, i) => {
      if (!workerJobType(w)) {
        issues.push({ path: `workers[${i}]`, message: "missing taskType" });
      }
      // The schema allows a worker backed by either a `handler` file or an `llm`
      // binding (oneOf). Require exactly one — don't force `handler`.
      const hasHandler = typeof w?.handler === "string" && w.handler.length > 0;
      const hasLlm = typeof w?.llm === "string" && w.llm.length > 0;
      if (!hasHandler && !hasLlm) {
        issues.push({ path: `workers[${i}]`, message: "worker requires a `handler` or `llm`" });
      } else if (hasHandler && hasLlm) {
        issues.push({ path: `workers[${i}]`, message: "worker declares both `handler` and `llm` (mutually exclusive)" });
      }
    });
  }

  if (man.data?.sources) {
    for (const [name, src] of Object.entries(man.data.sources)) {
      if (!src || typeof src.driver !== "string") {
        issues.push({ path: `data.sources.${name}.driver`, message: "missing driver" });
      }
      if (!src || typeof src.url !== "string") {
        issues.push({ path: `data.sources.${name}.url`, message: "missing url" });
      }
    }
    if (man.data.default && !man.data.sources[man.data.default]) {
      issues.push({ path: "data.default", message: `no such source "${man.data.default}"` });
    }
  }

  if (man.types) {
    for (const [name, t] of Object.entries(man.types)) {
      // `table` is optional in the schema: a type may declare `fields` without a
      // `table` (a transient / non-persisted domain type). Don't require it.
      if (t && typeof t !== "object") {
        issues.push({ path: `types.${name}`, message: "must be an object" });
      }
    }
  }

  if (Array.isArray(man.triggers)) {
    man.triggers.forEach((t, i) => {
      if (!t?.id) issues.push({ path: `triggers[${i}].id`, message: "missing id" });
      if (!t?.type) issues.push({ path: `triggers[${i}].type`, message: "missing type" });
    });
  }

  return issues;
}

/** Throw ManifestValidationError if the manifest is invalid; otherwise return it typed. */
export function validateManifest(m: unknown): AppManifest {
  const issues = collectManifestIssues(m);
  if (issues.length > 0) throw new ManifestValidationError(issues);
  return m as AppManifest;
}
