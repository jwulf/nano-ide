// Template substitution for deployed model resources. A model file (`.bpmn`/`.dmn`/`.form`) may
// carry `{{ name }}` placeholders — e.g. an agent service task whose prompt lives in a
// `zeebe:header` value. Before deploy we replace each placeholder with the named template's
// content, escaped for the resource's content-type, so a large asset (a prompt) is authored once
// in a file and inlined into the model at deploy time rather than hand-pasted into XML or shipped
// as a bulky per-instance process variable.
//
// Templates come from two sources, merged in order (later wins on a name collision):
//   1. the manifest `models.templates` (globs, or a bare directory that is scanned), and
//   2. a programmatic `templates` deploy option (globs, or an explicit `name → content` map).
// A template's name is its file's stem (basename without extension): `prompts/review-round.md`
// resolves the placeholder `{{review-round}}`.

import type { HostContext } from "../host.ts";
import { expandPatterns } from "../glob.ts";

/** A template source: a list of globs/directories/files (name = file stem), or an explicit
 *  `name → content` map. */
export type TemplateSource = string[] | Record<string, string>;

/** A file's stem: basename without its final extension (`a/b/review-round.md` → `review-round`). */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Files contributed by one entry: a glob (`prompts/*.md`), a bare directory (scanned, non-glob),
 *  or a literal file. Returns root-prefixed paths, matching `expandPatterns`. */
async function filesFor(host: HostContext, root: string, entry: string): Promise<string[]> {
  if (entry.includes("*")) return expandPatterns(host, root, [entry]);
  // A non-glob entry is either a directory (scan it) or a literal file. `listDir` can't be used to
  // tell them apart (the host adapters return `[]` for both a file and an empty directory), so
  // scan as a directory first; if that yields nothing, fall back to treating the entry as a file.
  // A stray directory path surviving to the read step is handled there (readTextFile guarded).
  const scanned = await expandPatterns(host, root, [`${entry.replace(/\/+$/, "")}/*`]);
  if (scanned.length > 0) return scanned;
  return expandPatterns(host, root, [entry]);
}

/** Build the `name → content` template map from the given sources in order (later sources win on
 *  a name collision). Array sources are resolved to files (stem = name) and read; map sources are
 *  merged verbatim. */
export async function resolveTemplates(
  host: HostContext,
  root: string,
  sources: ReadonlyArray<TemplateSource | undefined>,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      const seen = new Set<string>();
      for (const entry of source) {
        for (const file of await filesFor(host, root, entry)) {
          if (seen.has(file)) continue;
          seen.add(file);
          try {
            map[stem(file)] = await host.readTextFile(file);
          } catch (err) {
            // A directory path that slipped through the file fallback, or an unreadable file.
            host.log("warn", "template: skipped unreadable entry", { file, error: String(err) });
          }
        }
      }
    } else {
      Object.assign(map, source);
    }
  }
  return map;
}

// `{{ name }}` — a double-brace placeholder around a template name. Double braces avoid clashing
// with FEEL's single-brace context syntax used elsewhere in BPMN.
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Escape template content for an XML attribute value (e.g. a `zeebe:header` `value="…"`). Beyond
 *  the markup-significant characters, newlines and tabs MUST become character references:
 *  XML attribute-value normalization collapses literal newlines/tabs to spaces, which would
 *  destroy a multi-line prompt. Character references are exempt from that normalization, so
 *  `&#10;` round-trips as a newline. This escaping is also valid for XML element text, so it is
 *  the safe default for any `.bpmn`/`.dmn` placeholder position. */
function xmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

/** Escape template content for embedding inside a JSON string literal (a `.form` value). */
function jsonStringEscape(s: string): string {
  // Stringify to a valid JSON string, then drop the surrounding quotes → an inner-string fragment.
  const quoted = JSON.stringify(s);
  return quoted.slice(1, quoted.length - 1);
}

function escaperFor(contentType: string): (s: string) => string {
  if (contentType === "application/json") return jsonStringEscape;
  return xmlAttrEscape; // text/xml (.bpmn/.dmn) and any other markup
}

export interface TemplateApplication {
  content: string;
  /** Distinct placeholder names with no matching template (left in place, surfaced by the caller). */
  unresolved: string[];
}

/** Replace every `{{ name }}` placeholder in `content` with the named template's content, escaped
 *  for `contentType`. Single-pass and non-recursive: a template that itself contains `{{…}}` is
 *  not re-expanded. Unknown placeholders are left verbatim (so the miss is visible, not silently
 *  dropped) and reported in `unresolved`. */
export function applyTemplates(
  content: string,
  contentType: string,
  templates: Record<string, string>,
): TemplateApplication {
  const escape = escaperFor(contentType);
  const unresolved: string[] = [];
  const out = content.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (Object.prototype.hasOwnProperty.call(templates, name)) return escape(templates[name]);
    if (!unresolved.includes(name)) unresolved.push(name);
    return whole;
  });
  return { content: out, unresolved };
}
