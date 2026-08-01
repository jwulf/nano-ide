// The unit of derivation output: a file the derivers produce. Everything a deriver emits is a
// (path, content) pair. Derivers are pure — inputs in, artifacts out, no IO — so they are
// trivially testable and deterministic (the property that makes `urban gen --check` a reliable
// drift gate). IO (reading models, writing artifacts, comparing on --check) lives in `gen.ts`.

/** A single generated file. `path` is relative to the app root. */
export interface DerivedArtifact {
  path: string;
  content: string;
}

/**
 * A deriver: a named, pure function from some input to artifacts. The IDE and the `urban gen`
 * CLI are peer callers of the same derivers (ADR: derivation is a shared library).
 */
export interface Deriver<I> {
  readonly id: string;
  readonly describe: string;
  derive(input: I): DerivedArtifact[];
}

/** Where all derived output lands — the console's `nano-generated/` dir, so the toolkit is a
 * drop-in for the IDE's own codegen (ADR 0053). One drift domain, gitignored, never committed. */
export const GENERATED_DIR = "nano-generated";

/** Stable ordering so artifact lists compare deterministically. */
export function sortArtifacts(a: DerivedArtifact[]): DerivedArtifact[] {
  return [...a].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
