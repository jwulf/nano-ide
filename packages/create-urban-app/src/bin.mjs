#!/usr/bin/env node
// Bootstrap for `create-urban-app`. The scaffolder ships as TypeScript source (one
// source of truth, no build step). Node strips types natively, but versions < 23.6 need
// the `--experimental-strip-types` flag, so we re-exec node with it when required. This
// lets `npm create urban-app@latest ...` work on the advertised Node >= 22.6.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const [maj, min] = process.versions.node.split(".").map(Number);
const needsFlag = maj < 23 || (maj === 23 && min < 6);

const args = needsFlag
  ? ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, ...process.argv.slice(2)]
  : [cli, ...process.argv.slice(2)];

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
if (r.error) {
  console.error(String(r.error.message ?? r.error));
  process.exit(1);
}
process.exit(r.status ?? 1);
