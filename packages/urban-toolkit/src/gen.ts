// The gen orchestrator: the one impure edge of the toolkit. It reads an app's manifest, models,
// and flows, runs the pure derivers, and either writes the artifacts to disk (`urban gen`) or
// compares them against what's on disk and reports drift (`urban gen --check`). The derivers stay
// pure; all IO is confined here behind a tiny FS port so the same code runs on Node and Deno.

import type { DerivedArtifact } from "./artifact.ts";
import { sortArtifacts } from "./artifact.ts";
import { deriveMigrations, type ToolkitManifest } from "./derivers/migrations.ts";
import { deriveWorkerBindings, type ModelSource } from "./derivers/worker-io.ts";
import { deriveModelFromFlow } from "./derivers/model.ts";
import type { CodeFlow } from "./bpmn.ts";

/** Minimal filesystem port. Node/Deno impls live in `fsio.ts`. */
export interface GenIO {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** File names (not paths) in a directory; empty if it does not exist. */
  listDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export interface GenOptions {
  root: string;
  io: GenIO;
  manifestFile?: string;
}

export interface GenResult {
  artifacts: DerivedArtifact[];
  /** Paths that differ from disk (only populated by `check`). */
  drift: string[];
}

function join(root: string, rel: string): string {
  // Trim either separator so callers may pass Windows-style paths; GenIO
  // implementations accept forward slashes on all platforms.
  return `${root.replace(/[/\\]+$/, "")}/${rel.replace(/^[/\\]+/, "")}`;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

/** Resolve a `dir/*.ext` (or literal) manifest pattern to file paths relative to root. */
async function expandPattern(root: string, io: GenIO, pattern: string): Promise<string[]> {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return (await io.exists(join(root, pattern))) ? [pattern] : [];
  }
  const slash = pattern.lastIndexOf("/", star);
  const dir = slash === -1 ? "." : pattern.slice(0, slash);
  const tail = pattern.slice(slash + 1); // e.g. "*.bpmn"
  const ext = tail.startsWith("*") ? tail.slice(1) : tail;
  const names = await io.listDir(join(root, dir));
  return names
    .filter((n) => n.endsWith(ext))
    .map((n) => (dir === "." ? n : `${dir}/${n}`))
    .sort();
}

/** Collect all artifacts a run would produce, without touching disk beyond reads. */
export async function collectArtifacts(opts: GenOptions): Promise<DerivedArtifact[]> {
  const { root, io } = opts;
  const manifestPath = join(root, opts.manifestFile ?? "nano.app.json");
  const manifest = JSON.parse(await io.readText(manifestPath)) as ToolkitManifest & {
    models?: { processes?: string[]; flows?: string[] };
  };

  const artifacts: DerivedArtifact[] = [];

  // 1. types → migrations
  if (manifest.types && Object.keys(manifest.types).length > 0) {
    artifacts.push(...deriveMigrations(manifest));
  }

  // 2. models → worker I/O index
  const procPatterns = manifest.models?.processes ?? [];
  const models: ModelSource[] = [];
  for (const pat of procPatterns) {
    for (const rel of await expandPattern(root, io, pat)) {
      models.push({ path: rel, xml: await io.readText(join(root, rel)) });
    }
  }
  if (models.length > 0) {
    const declaredTypeIds = Object.keys(manifest.types ?? {});
    artifacts.push(...deriveWorkerBindings(models, declaredTypeIds));
  }

  // 3. code-first flows → BPMN models
  const flowPatterns = manifest.models?.flows ?? ["flows/*.flow.json"];
  for (const pat of flowPatterns) {
    for (const rel of await expandPattern(root, io, pat)) {
      const flow = JSON.parse(await io.readText(join(root, rel))) as CodeFlow;
      artifacts.push(...deriveModelFromFlow(flow));
    }
  }

  return sortArtifacts(artifacts);
}

/** Run the derivers and write artifacts (or, with `check`, report drift without writing). */
export async function runGen(opts: GenOptions & { check?: boolean }): Promise<GenResult> {
  const artifacts = await collectArtifacts(opts);
  const { root, io } = opts;
  const drift: string[] = [];

  for (const a of artifacts) {
    const abs = join(root, a.path);
    if (opts.check) {
      const current = (await io.exists(abs)) ? await io.readText(abs) : null;
      if (current !== a.content) drift.push(a.path);
    } else {
      await io.writeText(abs, a.content);
    }
  }
  return { artifacts, drift };
}

export { dirOf, join as joinPath };
