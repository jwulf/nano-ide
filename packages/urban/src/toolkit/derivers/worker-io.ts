// Deriver: BPMN models → `worker-io.d.ts`, the worker type map (ADR 0033 §3). Scans each
// process for service tasks and extracts the Zeebe task type plus the data-envelope in/out
// contract (io.nanobpm.dataEnvelope.in / .out, carried as zeebe:property). It emits the SAME
// `worker-io.d.ts` the console generates (a faithful port of `emitWorkerBindings` in the
// server's domain_types.ts), so the toolkit is a drop-in for the IDE's codegen (ADR 0053).

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";

export interface ModelSource {
  /** Path (used only for diagnostics/ordering). */
  path: string;
  xml: string;
}

/** Deterministic comparator for ordering `ModelSource` lists by path. Returns 0 on equal
 * paths so it satisfies the JS sort contract (a comparator that reports both `a>b` and
 * `b>a` can reorder equal elements unpredictably) — keeping the derivers' cross-model
 * fold order stable even if a manifest pattern yields duplicate paths. Shared by every
 * model-scanning deriver so there is one canonical ordering. */
export function byModelPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface WorkerIo {
  taskType: string;
  elementId?: string;
  process?: string;
  /** Data-envelope input type id (io.nanobpm.dataEnvelope.in). */
  in?: string;
  /** Data-envelope output type id (io.nanobpm.dataEnvelope.out). */
  out?: string;
}

/** Filename the console uses; kept identical so the artifact is a drop-in. */
export const WORKER_BINDINGS_DTS = "worker-io.d.ts";
/** The domain type declarations `worker-io.d.ts` imports from (console: domain-rows.d.ts). */
export const DOMAIN_DTS = "domain-rows.d.ts";

const ENVELOPE_IN = "io.nanobpm.dataEnvelope.in";
const ENVELOPE_OUT = "io.nanobpm.dataEnvelope.out";

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

function processId(xml: string): string | undefined {
  const m = xml.match(/<bpmn:process\b[^>]*>/);
  return m ? attr(m[0], "id") : undefined;
}

/** Scan one BPMN document for service-task worker I/O. */
export function scanModelWorkers(xml: string): WorkerIo[] {
  const proc = processId(xml);
  const out: WorkerIo[] = [];
  const blockRe = /<bpmn:serviceTask\b([^>]*)>([\s\S]*?)<\/bpmn:serviceTask>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const openAttrs = m[1];
    const body = m[2];
    const elementId = attr(`<x ${openAttrs}>`, "id");
    const tdMatch = body.match(/<zeebe:taskDefinition\b[^>]*>/);
    if (!tdMatch) continue;
    const taskType = attr(tdMatch[0], "type");
    if (!taskType) continue;

    const io: WorkerIo = { taskType, elementId, process: proc };
    const propRe = /<zeebe:property\b[^>]*>/g;
    let p: RegExpExecArray | null;
    while ((p = propRe.exec(body)) !== null) {
      const pname = attr(p[0], "name");
      const pvalue = attr(p[0], "value");
      if (pname === ENVELOPE_IN && pvalue) io.in = pvalue;
      else if (pname === ENVELOPE_OUT && pvalue) io.out = pvalue;
    }
    out.push(io);
  }
  return out;
}

// --- Faithful port of the console's emitWorkerBindings (domain_types.ts) so the emitted
//     worker-io.d.ts is byte-compatible with the IDE's own codegen. ---

/** A `DomainTypes[...]` ref for a declared type id (else undefined). The one canonical
 * ref helper shared by the worker- and message-IO emitters (matches the console's single
 * `typeRefFor` in domain_types.ts), so both stay identical to the host codegen. */
export function typeRefFor(id: string | undefined, declared: Set<string>): string | undefined {
  return id != null && declared.has(id) ? `DomainTypes[${JSON.stringify(id)}]` : undefined;
}

export interface WorkerBindingDecl {
  taskType?: string;
  inputType?: string;
  outputType?: string;
}

/** Emit `worker-io.d.ts` from worker bindings + the set of declared domain type ids. */
export function emitWorkerBindings(
  workers: WorkerBindingDecl[],
  declaredTypeIds: Iterable<string>,
): string {
  const declared = new Set(declaredTypeIds);
  const propKey = (t: string) => JSON.stringify(t);
  const taskTypes = [
    ...new Set(
      workers
        .map((w) => w?.taskType)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    ),
  ];
  const taskTypeUnion = taskTypes.length > 0
    ? taskTypes.map((t) => JSON.stringify(t)).join(" | ")
    : "string";
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const w of workers) {
    if (typeof w?.taskType !== "string" || w.taskType.length === 0) continue;
    const inRef = typeRefFor(w.inputType, declared);
    if (inRef) inputs.push(`  ${propKey(w.taskType)}: ${inRef};`);
    const outRef = typeRefFor(w.outputType, declared);
    if (outRef) outputs.push(`  ${propKey(w.taskType)}: ${outRef};`);
  }

  const header =
    "// AUTO-GENERATED by nanobpmn from the App manifest (ADR 0033 §3).\n" +
    "// The bridge from the process model to the worker type system: each declared\n" +
    "// worker's `taskType` maps to the TS type of its input payload (`job.variables`)\n" +
    "// and result, so the typed `defineWorker` types a handler by its job type. Do\n" +
    "// not edit — regenerated from the manifest. Erased to plain JS at compile.\n" +
    "// eslint-disable\n";

  const needsRegistry = inputs.length > 0 || outputs.length > 0;
  const importTypes = needsRegistry
    ? `import type { DomainTypes } from "./${DOMAIN_DTS}";\n`
    : "";

  const inputsIface = inputs.length > 0
    ? `export interface WorkerInputs {\n${inputs.join("\n")}\n}\n`
    : `export interface WorkerInputs {}\n`;
  const outputsIface = outputs.length > 0
    ? `export interface WorkerOutputs {\n${outputs.join("\n")}\n}\n`
    : `export interface WorkerOutputs {}\n`;
  const headersIface = `export interface WorkerHeaders {}\n`;

  return `${header}\n` +
    importTypes +
    `\n/** Untyped fallback for a job whose worker declares no input/output type. */\n` +
    `export type WorkerVars = Record<string, unknown>;\n\n` +
    `/** Untyped fallback for a job whose worker declares no custom headers. */\n` +
    `export type WorkerHdrs = Record<string, unknown>;\n\n` +
    `/** Every declared worker \`taskType\` (ADR 0033 §3): the model-derived set the\n` +
    ` * typed \`defineWorker\` accepts, so \`type\` autocompletes and rejects unknown jobs. */\n` +
    `export type WorkerTaskType = ${taskTypeUnion};\n\n` +
    `/** Input payload (\`job.variables\`) per declared worker, keyed by \`taskType\`. */\n` +
    inputsIface +
    `\n/** Output payload (worker result) per declared worker, keyed by \`taskType\`. */\n` +
    outputsIface +
    `\n/** Custom headers (\`job.customHeaders\`) per declared worker, keyed by \`taskType\`.\n` +
    ` * Header values are strings on the wire, so each declared key maps to \`string\`;\n` +
    ` * the extra index signature keeps undeclared headers accessible (non-breaking). */\n` +
    headersIface;
}

/**
 * Derive `nano-generated/worker-io.d.ts` from BPMN models. `declaredTypeIds` is the set of
 * domain type ids declared in the manifest `types` — an envelope in/out only becomes a typed
 * ref when it names a declared type (matches the console's typeRefFor).
 */
export function deriveWorkerBindings(
  models: ModelSource[],
  declaredTypeIds: Iterable<string> = [],
): DerivedArtifact[] {
  const workers: WorkerBindingDecl[] = [];
  for (const model of [...models].sort(byModelPath)) {
    for (const w of scanModelWorkers(model.xml)) {
      workers.push({ taskType: w.taskType, inputType: w.in, outputType: w.out });
    }
  }
  const content = emitWorkerBindings(workers, declaredTypeIds);
  return [{ path: `${GENERATED_DIR}/${WORKER_BINDINGS_DTS}`, content }];
}

export const workerIoDeriver: Deriver<{ models: ModelSource[]; declaredTypeIds: Iterable<string> }> = {
  id: "model->worker-io",
  describe: "Derive worker-io.d.ts (task type + data-envelope in/out) from BPMN models.",
  derive: ({ models, declaredTypeIds }) => deriveWorkerBindings(models, declaredTypeIds),
};
