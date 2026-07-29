// nanobpmn Node loader bootstrap (ADR 0036).
//
// Runs on the main thread via `--import ./nano-generated/node-register.mjs` when
// a project runs under the Node fallback runtime (no Deno build available). Two
// jobs: (1) install the `Deno` global shim so Deno-authored app/template code
// runs unchanged (node-deno-shim.mjs); (2) register the import-map loader
// (node-loader.mjs) on the module resolution thread.
import "./node-deno-shim.mjs";
import { register } from "node:module";

register("./node-loader.mjs", import.meta.url);
