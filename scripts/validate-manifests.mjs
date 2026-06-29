// Validate every published pack's nano-ide.ext.json against the manifest contract
// (ADR 0007), keeping packs in sync with the host parser in nanobpmn
// server/src/console/extensions.rs. Run: node scripts/validate-manifests.mjs
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KINDS = new Set(["lang", "app", "example"]);
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
}
if (errors) { console.error(`\n${errors} error(s)`); process.exit(1); }
console.log("\nall manifests valid");
