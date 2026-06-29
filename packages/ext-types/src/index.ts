// nano-ide.ext.json manifest contract (ADR 0007). Mirrors the host parser in
// nanobpmn server/src/console/extensions.rs — keep in sync.

export type ExtKind = "lang" | "app" | "example";

export interface FileType {
  /** File extension including the dot, e.g. ".rs". */
  ext: string;
  /** Monaco language id; the editor lazy-loads it only for matching files. */
  monacoLang: string;
}

export interface Toolchain {
  /** Probe argv proving the toolchain is installed (e.g. ["cargo","--version"]). */
  detect?: string[];
  /** argv to run the project (cwd = project dir). Empty => built-in Deno runner. */
  run?: string[];
  /** argv to compile the project. Empty => Deno compile. */
  compile?: string[];
  /** Cross-compile target triples this toolchain offers. */
  targets?: string[];
}

export interface TemplateSpec {
  id: string;
  label: string;
}

export interface ExtManifest {
  id: string;
  kind: ExtKind;
  displayName: string;
  fileTypes?: FileType[];
  templates?: TemplateSpec[];
  toolchain?: Toolchain;
  /** example packs: lang pack ids required to build/run this example. */
  requires?: string[];
  /** example packs: subdir holding the ready-to-copy project. */
  appDir?: string;
  /** example packs: one-line description for the picker. */
  summary?: string;
  /** Built-in packs set this; published packs omit it. */
  builtin?: boolean;
}

export const MANIFEST_FILE = "nano-ide.ext.json";
