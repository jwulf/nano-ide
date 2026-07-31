// Validate every published pack's nano-ide.ext.json against the manifest contract
// (ADR 0007), keeping packs in sync with the host parser in nanobpmn
// server/src/console/extensions.rs. Run: node scripts/validate-manifests.mjs
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkTours } from "./lib/tour-validation.mjs";

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

  // Guided journeys (ADR 0049 §7) — a deliberate mirror of the rules the console
  // adapter applies at runtime, in the same spirit as THEME_TOKEN_KEYS above. The
  // console must stay defensive because packs are third-party, but a pack author
  // should learn about a malformed tour at publish time, not from a step silently
  // vanishing in someone else's browser. Rules live in ./lib/tour-validation.mjs
  // so this script and its unit tests share one source of truth.
  checkTours(m.tours, fail);

  // Component element-templates (ADR 0033 §4) — mirror the host's
  // `ExtManifest.components: Vec<String>` in extensions.rs. Each is a
  // pack-relative element-template JSON file that must exist and parse.
  const componentTypes = new Set();
  if (m.components !== undefined) {
    if (!Array.isArray(m.components)) fail("components must be an array of pack-relative paths");
    for (const rel of Array.isArray(m.components) ? m.components : []) {
      if (typeof rel !== "string" || !rel.trim() || rel.startsWith("/") || rel.includes("..")) {
        fail(`component must be a pack-relative path: ${JSON.stringify(rel)}`);
        continue;
      }
      const cp = join(base, rel);
      if (!existsSync(cp)) { fail(`component template missing: ${rel}`); continue; }
      let tmpls;
      try { tmpls = JSON.parse(readFileSync(cp, "utf8")); }
      catch (e) { fail(`component ${rel}: invalid JSON: ${e.message}`); continue; }
      for (const t of Array.isArray(tmpls) ? tmpls : [tmpls]) {
        if (!t?.id || !t?.name) fail(`component ${rel}: element template needs id+name`);
        const td = (t?.properties ?? []).find((p) => p?.binding?.type === "zeebe:taskDefinition:type");
        if (td?.value) componentTypes.add(td.value);
      }
    }
  }

  // Workers (ADR 0050, amending ADR 0033 §4) — the outbound edge. Each declares
  // a job `type` and a pack-relative `entry`; the `type` must back a component
  // template's `zeebe:taskDefinition:type` (the design→runtime seam), so a
  // dragged task always resolves to a running worker (no drift surface).
  if (m.workers !== undefined) {
    if (!Array.isArray(m.workers)) fail("workers must be an array");
    for (const w of Array.isArray(m.workers) ? m.workers : []) {
      if (typeof w?.type !== "string" || !w.type.trim()) fail(`worker needs a type: ${JSON.stringify(w)}`);
      if (typeof w?.entry !== "string" || !w.entry.trim() || w.entry.startsWith("/") || w.entry.includes("..")) {
        fail(`worker ${w?.type}: entry must be a pack-relative path`);
      } else if (!existsSync(join(base, w.entry))) {
        fail(`worker ${w.type}: entry file missing: ${w.entry}`);
      }
      if (typeof w?.type === "string" && w.type.trim() && !componentTypes.has(w.type)) {
        fail(`worker "${w.type}" has no component template with a matching zeebe:taskDefinition:type`);
      }
      if (w?.configFields !== undefined && !Array.isArray(w.configFields)) {
        fail(`worker ${w?.type}: configFields must be an array`);
      }
      for (const f of Array.isArray(w?.configFields) ? w.configFields : []) {
        if (typeof f?.key !== "string" || !f.key.trim() || typeof f?.label !== "string" || !f.label.trim()) {
          fail(`worker ${w.type}: configField needs non-empty key+label: ${JSON.stringify(f)}`);
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
