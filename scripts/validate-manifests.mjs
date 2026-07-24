// Validate every published pack's nano-ide.ext.json against the manifest contract
// (ADR 0007), keeping packs in sync with the host parser in nanobpmn
// server/src/console/extensions.rs. Run: node scripts/validate-manifests.mjs
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KINDS = new Set(["lang", "app", "example", "theme", "trigger"]);
// Console design-token vocabulary (nanobpmn console/src/theme/tokens.css);
// mirror of THEME_TOKEN_KEYS in packages/ext-types.
const THEME_TOKEN_KEYS = new Set([
  "app", "panel", "raised", "inset", "hover", "edge", "edgeStrong",
  "text", "textMuted", "textFaint", "accent", "accentStrong", "accent2",
  "onAccent", "ok", "warn", "danger", "info",
]);
const pkgRoot = new URL("../packages/", import.meta.url).pathname;
let errors = 0;
const fail = (m) => { console.error("  ✗ " + m); errors++; };

for (const dir of readdirSync(pkgRoot)) {
  const base = join(pkgRoot, dir);
  if (!statSync(base).isDirectory()) continue;
  const mPath = join(base, "nano-ide.ext.json");
  if (!existsSync(mPath)) continue; // ext-types has no manifest
  console.log(dir);
  let m;
  try { m = JSON.parse(readFileSync(mPath, "utf8")); }
  catch (e) { fail(`invalid JSON: ${e.message}`); continue; }
  if (!m.id) fail("missing id");
  if (!KINDS.has(m.kind)) fail(`bad kind: ${m.kind}`);
  if (!m.displayName) fail("missing displayName");
  for (const t of m.templates ?? []) if (!t.id || !t.label) fail(`template needs id+label: ${JSON.stringify(t)}`);
  for (const f of m.fileTypes ?? []) if (!f.ext?.startsWith(".") || !f.monacoLang) fail(`bad fileType: ${JSON.stringify(f)}`);
  if (m.kind === "example") {
    if (!m.appDir || !existsSync(join(base, m.appDir))) fail(`example appDir missing: ${m.appDir}`);
    if (!Array.isArray(m.requires)) fail("example requires[] missing");
  }
  // An app pack with a real toolchain (a detect probe) scaffolds non-Deno
  // projects, so it must name its language via requires[] — the host sets the
  // new project's lang from requires[0]; without it the project silently runs
  // on the Deno runtime (the "Java template creates a Deno app" bug).
  if (m.kind === "app" && (m.toolchain?.detect?.length ?? 0) > 0
      && !(Array.isArray(m.requires) && m.requires.length > 0)) {
    fail("app pack has a toolchain but no requires[] — new projects would default to the Deno runtime");
  }
  if (m.requires !== undefined
      && !(Array.isArray(m.requires) && m.requires.every((r) => typeof r === "string" && r.trim()))) {
    fail("requires[] must be an array of non-empty lang pack ids");
  }
  if (m.kind === "theme") {
    if (!Array.isArray(m.themes) || m.themes.length === 0) fail("theme pack needs themes[]");
    for (const t of m.themes ?? []) {
      if (!t.id || !t.label) fail(`theme needs id+label: ${JSON.stringify(t)}`);
      if (t.appearance !== "light" && t.appearance !== "dark") fail(`theme ${t.id}: appearance must be light|dark`);
      if (typeof t.tokens !== "object" || t.tokens === null) { fail(`theme ${t.id}: tokens{} missing`); continue; }
      for (const [k, v] of Object.entries(t.tokens)) {
        if (!THEME_TOKEN_KEYS.has(k)) fail(`theme ${t.id}: unknown token "${k}"`);
        if (typeof v !== "string" || !v.trim()) fail(`theme ${t.id}: token ${k} needs a CSS colour string`);
      }
    }
  }
  if (m.kind === "trigger") {
    if (!Array.isArray(m.triggerSources) || m.triggerSources.length === 0) {
      fail("trigger pack needs triggerSources[]");
    }
    for (const s of Array.isArray(m.triggerSources) ? m.triggerSources : []) {
      if (!s.kind || typeof s.kind !== "string") fail(`trigger source needs a kind: ${JSON.stringify(s)}`);
      if (s.transport !== undefined && s.transport !== "webhook") {
        fail(`trigger source ${s.kind}: transport must be "webhook" (only v1 transport)`);
      }
      // A driver, when set, must be a pack-relative file that exists on disk.
      if (s.driver !== undefined) {
        if (typeof s.driver !== "string" || !s.driver.trim() || s.driver.startsWith("/") || s.driver.includes("..")) {
          fail(`trigger source ${s.kind}: driver must be a pack-relative path`);
        } else if (!existsSync(join(base, s.driver))) {
          fail(`trigger source ${s.kind}: driver file missing: ${s.driver}`);
        }
      }
      if (s.configFields !== undefined && !Array.isArray(s.configFields)) {
        fail(`trigger source ${s.kind}: configFields must be an array`);
      }
      for (const f of Array.isArray(s.configFields) ? s.configFields : []) {
        if (typeof f?.key !== "string" || !f.key.trim() || typeof f?.label !== "string" || !f.label.trim()) {
          fail(`trigger source ${s.kind}: configField needs non-empty key+label: ${JSON.stringify(f)}`);
        }
      }
    }
  }
}
if (errors > 0) {
  console.error(`\n${errors} manifest validation error${errors === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\nall manifests valid");
