// The stub-scaffolder's one impure edge (ADR 0056): read the manifest + models, run the pure
// planner, and — write-if-absent only — create each handler stub and wire it into the manifest.
// Dry-run by default (`write: false`); nothing is touched unless `write` is set. Stubs are
// human-owned, so an existing file is KEPT verbatim, never clobbered (the opposite of `runGen`).

import type { GenIO } from "./gen.ts";
import { joinPath, readModels } from "./gen.ts";
import {
  planWorkerScaffold,
  type ScaffoldWorker,
  type SkippedWorker,
  type StubManifestEntry,
} from "./scaffold/workers.ts";

/** The manifest fields the scaffolder reads. */
interface ScaffoldManifest {
  types?: Record<string, unknown>;
  models?: { processes?: string[] };
  workers?: ScaffoldWorker[];
}

export interface ScaffoldOptions {
  root: string;
  io: GenIO;
  manifestFile?: string;
  /** Apply changes (create files + patch manifest). Default false = dry-run. */
  write?: boolean;
}

export type StubStatus = "created" | "would-create" | "kept";

export interface StubOutcome {
  taskType: string;
  handlerPath: string;
  status: StubStatus;
  typedIn: boolean;
  typedOut: boolean;
}

export interface ScaffoldRun {
  outcomes: StubOutcome[];
  skipped: SkippedWorker[];
  /**
   * Manifest entries that would be appended to `workers[]` — one per planned stub, so this is
   * populated on a dry-run too (letting a caller preview the wiring). They are actually written
   * to the manifest only when `write` is set (see `manifestPatched`).
   */
  wired: StubManifestEntry[];
  manifestPatched: boolean;
  write: boolean;
}

/** Scaffold write-once worker stubs from the model, wiring them into `manifest.workers[]`. */
export async function scaffoldWorkers(opts: ScaffoldOptions): Promise<ScaffoldRun> {
  const { root, io } = opts;
  const write = opts.write ?? false;
  const manifestFile = opts.manifestFile ?? "nano.app.json";
  const manifestPath = joinPath(root, manifestFile);

  const manifest = JSON.parse(await io.readText(manifestPath)) as ScaffoldManifest;
  const models = await readModels(root, io, manifest);
  const declaredTypeIds = Object.keys(manifest.types ?? {});

  const { plans, skipped } = planWorkerScaffold(models, manifest.workers ?? [], declaredTypeIds);

  const outcomes: StubOutcome[] = [];
  const wired: StubManifestEntry[] = [];

  for (const plan of plans) {
    const abs = joinPath(root, plan.handlerPath);
    const exists = await io.exists(abs);
    let status: StubStatus;
    if (exists) {
      status = "kept"; // human-owned — never clobber
    } else if (write) {
      await io.writeText(abs, plan.stub);
      status = "created";
    } else {
      status = "would-create";
    }
    outcomes.push({
      taskType: plan.taskType,
      handlerPath: plan.handlerPath,
      status,
      typedIn: plan.typedIn,
      typedOut: plan.typedOut,
    });
    // The planner already excluded already-wired task types, so every plan needs wiring —
    // including an orphan stub file that exists on disk but isn't in the manifest yet.
    wired.push(plan.manifestEntry);
  }

  let manifestPatched = false;
  if (write && wired.length > 0) {
    const withWorkers = {
      ...manifest,
      workers: [...(manifest.workers ?? []), ...wired],
    };
    await io.writeText(manifestPath, `${JSON.stringify(withWorkers, null, 2)}\n`);
    manifestPatched = true;
  }

  return { outcomes, skipped, wired, manifestPatched, write };
}
