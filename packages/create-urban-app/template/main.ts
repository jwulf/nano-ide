// Entrypoint for __APP_NAME__. Runs the Urban runtime against a Nano engine.
//
// Configure the engine address with CAMUNDA_REST_ADDRESS (default http://localhost:8080/v2).
// Run with:
//   Node:  npm start          (or: npx urban run)
//   Deno:  deno task start     (or: deno run -A npm:@nanobpm/urban run)

import { runFromEnv } from "@nanobpm/urban-runtime";

const app = await runFromEnv({ root: import.meta.dirname ?? "." });
const info = app.inspect();
console.log(`▲ ${info.name} running — surfaces on :${info.httpPort ?? "n/a"}`);
