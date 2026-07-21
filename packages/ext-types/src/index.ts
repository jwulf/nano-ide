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
  /** argv to run the project (cwd = project dir). Empty => built-in Deno runner.
   * Serves as a fallback when the active run config's `run` argv is empty. */
  run?: string[];
  /** argv to compile the project. Empty => Deno compile. Serves as a fallback
   * when the active run config's `compile` argv is empty. */
  compile?: string[];
  /** Cross-compile target triples this toolchain offers. */
  targets?: string[];
  /** Named run configurations the console surfaces in a Run/Target dropdown.
   * When set, the supervisor prefers the active one (pinned →
   * `default: true` → first) over the flat `run`/`compile`. */
  runConfigs?: RunConfig[];
  /** Official install instructions for this toolchain, surfaced in the IDE
   * config panel when the `detect` probe fails (e.g. the Rust toolchain page). */
  installUrl?: string;
  /** One-line, actionable hint shown when the toolchain is missing (e.g.
   * "`cargo` was not found. Install the Rust toolchain…"). */
  installHint?: string;
}

/**
 * One named run/compile combo a pack exposes — e.g. an example that swaps
 * transports or build profiles. The console persists the picked id in the
 * project's `nanobpm.project.json` as `toolchain.activeRunConfig`.
 */
export interface RunConfig {
  /** Stable id, unique within the pack (e.g. "stock-grpc"). */
  id: string;
  /** Human-facing label shown in the Run dropdown. */
  label: string;
  /** When no id is pinned by the user, this entry is picked; else the first. */
  default?: boolean;
  /** argv override for this config. Empty => fall back to `Toolchain.run`. */
  run?: string[];
  /** argv override for this config. Empty => fall back to `Toolchain.compile`. */
  compile?: string[];
  /** Env vars layered on top of the base spawn env (last wins on key clash). */
  env?: Record<string, string>;
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

/**
 * IntelliSense data a lang pack ships for the console's Monaco editor. The
 * console has a real language service only for TypeScript/JavaScript (Monaco's
 * built-in TS worker); every other language gets tokenisation only. A pack can
 * light up completion, hover, and signature help for its `monacoLang` by
 * shipping this curated data — no in-browser language server required. The host
 * registers one provider per `monacoLang` and feeds it every pack's entries.
 */
export interface LangIntellisense {
  /** Monaco language id these entries apply to (e.g. "csharp", "rust"). */
  monacoLang: string;
  /** Extra characters that reopen the completion popup (e.g. ["."]). The word
   * character set always triggers completion; add member-access dots etc. */
  triggerCharacters?: string[];
  /** Completion items offered in files of this language. */
  completions?: CompletionSpec[];
  /** Hover cards keyed by the exact symbol under the cursor. */
  hovers?: HoverSpec[];
  /** Signature-help entries shown while typing a call's arguments. */
  signatures?: SignatureSpec[];
}

/**
 * Monaco `CompletionItemKind` names a pack may use. The listed names are the
 * commonly-emitted ones and exist only as authoring hints — the real authority
 * is the host's kind→Monaco mapping, which renders any unknown value as
 * `Value`. The union is intentionally open (`string & {}`) because the mapping
 * lives in a separate repo (the console), so a closed set here can't be
 * compile-time reconciled with it and would only drift; keeping it open means a
 * new generator-emitted kind never breaks consumers of this package.
 */
export type CompletionKind =
  | "keyword"
  | "snippet"
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "module"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "value"
  | (string & {});

/** One completion item. `insertText` defaults to `label`. */
export interface CompletionSpec {
  /** Text shown in the completion list. */
  label: string;
  /** Icon/category. Defaults to "value" when omitted. */
  kind?: CompletionKind;
  /** Text inserted on accept. Defaults to `label`. */
  insertText?: string;
  /** When true, `insertText` is a Monaco snippet (`${1:name}` placeholders). */
  snippet?: boolean;
  /** Short right-aligned signature/type (e.g. the return type). */
  detail?: string;
  /** Markdown documentation shown in the details flyout. */
  documentation?: string;
}

/** A hover card: shown when the pointer rests on `symbol`. */
export interface HoverSpec {
  /** Exact identifier that triggers this hover (whole-word match). */
  symbol: string;
  /** Markdown rendered in the hover card. */
  contents: string;
}

/** One function/method signature surfaced by signature help. */
export interface SignatureSpec {
  /** Identifier that, when followed by `(`, triggers this help (e.g.
   * "CreateProcessInstanceAsync"). */
  trigger: string;
  /** Full signature line shown in the popup. */
  label: string;
  /** Markdown documentation for the call. */
  documentation?: string;
  /** Ordered parameters; the active one is highlighted by comma position. */
  parameters?: SignatureParam[];
}

/** One parameter within a {@link SignatureSpec}. */
export interface SignatureParam {
  /** Parameter label as it appears in the signature (e.g. "id: string"). */
  label: string;
  /** Markdown documentation for this parameter. */
  documentation?: string;
}

export interface ExtManifest {
  id: string;
  kind: ExtKind;
  displayName: string;
  /** Optional pack icon: an inline SVG XML string (preferred; use single-quoted
   * attributes so it nests in JSON) or a data:/http: URL. Lang packs supply this
   * so the console can badge project cards with a language icon. */
  icon?: string;
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
  /** lang packs: curated IntelliSense (completion/hover/signature) for the
   * pack's languages, since the console has no in-browser language server for
   * anything but TypeScript. One entry per `monacoLang`. */
  intellisense?: LangIntellisense[];
  /** Built-in packs set this; published packs omit it. */
  builtin?: boolean;
}

export const MANIFEST_FILE = "nano-ide.ext.json";
