// Publish each public workspace whose version isn't yet on npm. Idempotent
// (skips already-published versions) and tolerant of transient sigstore/rekor
// hiccups (one retry). Run by the release workflow. Needs NODE_AUTH_TOKEN.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dirs = JSON.parse(execFileSync("npm", ["query", ".workspace"], { encoding: "utf8" }))
  .map((w) => w.path)
  .filter(Boolean);

let published = 0, failed = 0;
for (const dir of dirs) {
  const p = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  if (p.private) continue;
  let live = "";
  try { live = execFileSync("npm", ["view", `${p.name}@${p.version}`, "version"], { encoding: "utf8" }).trim(); }
  catch { /* not published yet */ }
  if (live === p.version) { console.log(`= ${p.name}@${p.version} already on npm`); continue; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync("npm", ["publish", "--access", "public", "--provenance"], { cwd: dir, stdio: "inherit" });
      console.log(`+ ${p.name}@${p.version}`); published++; break;
    } catch {
      if (attempt === 2) { console.error(`✗ ${p.name}@${p.version}`); failed++; }
    }
  }
}
console.log(`\npublished ${published}, failed ${failed}`);
if (failed) process.exit(1);
