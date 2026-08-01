#!/usr/bin/env node
// Bootstrap for the `urban` CLI. Runs the compiled CLI (dist/cli.js). The package is
// published as compiled JS + .d.ts because Node cannot strip types for files under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so no type-stripping flag
// is needed here.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) {
  console.error(String(r.error.message ?? r.error));
  process.exit(1);
}
process.exit(r.status ?? 1);
