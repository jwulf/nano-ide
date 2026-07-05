// nano-ide.ext.json manifest contract (ADR 0007). Mirrors the host parser in
// nanobpmn server/src/console/extensions.rs — keep in sync.

export type ExtKind = "lang" | "app" | "example" | "theme";

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

/**
 * The console's design-token vocabulary (nanobpmn
 * console/src/theme/tokens.css). A theme restyles the whole console by giving
 * CSS colours for these keys; missing keys fall back to the base appearance.
 */
export const THEME_TOKEN_KEYS = [
  "app",
  "panel",
  "raised",
  "inset",
  "hover",
  "edge",
  "edgeStrong",
  "text",
  "textMuted",
  "textFaint",
  "accent",
  "accentStrong",
  "accent2",
  "onAccent",
  "ok",
  "warn",
  "danger",
  "info",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/** One console colour theme a `kind: "theme"` pack contributes. Pure data. */
export interface ThemeSpec {
  /** Stable id, unique across packs (e.g. "nord-dark"). */
  id: string;
  /** Human-facing name shown in the console's theme picker. */
  label: string;
  /** Base palette the tokens override — controls color-scheme and any token
   * the theme doesn't specify. */
  appearance: "light" | "dark";
  /** Design-token name -> CSS colour. Unknown keys are ignored by the host. */
  tokens: Partial<Record<ThemeTokenKey, string>>;
}

export interface ExtManifest {
  id: string;
  kind: ExtKind;
  displayName: string;
  fileTypes?: FileType[];
  templates?: TemplateSpec[];
  toolchain?: Toolchain;
  /** example/app packs: lang pack ids required to build/run this pack's
   * projects. The FIRST entry sets the scaffolded project's language — which
   * drives the host's run/compile toolchain — so any app or example pack that
   * isn't Deno-based must declare it (else new projects fall back to the Deno
   * runtime). Required for example packs; required for app packs whose
   * toolchain declares a detect probe. */
  requires?: string[];
  /** example packs: subdir holding the ready-to-copy project. */
  appDir?: string;
  /** example packs: one-line description for the picker. */
  summary?: string;
  /** theme packs: the console colour themes this pack contributes. */
  themes?: ThemeSpec[];
  /** Built-in packs set this; published packs omit it. */
  builtin?: boolean;
}

export const MANIFEST_FILE = "nano-ide.ext.json";
