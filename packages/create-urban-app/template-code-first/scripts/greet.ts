// Start one `greet` instance against the running engine.
//
//   npm start                  # the worker-host service (deploys + hosts greet)
//   npm run greet -- Adam      # create an instance for "Adam"
//
// The instance runs the in-process `greet` handler, which writes a greetings row
// and completes with `{ message }`.
import { WorkflowClient } from "@nanobpm/urban";
import { greet } from "../workflows/greet.ts";

const REST = process.env.CAMUNDA_REST_ADDRESS ?? "http://localhost:8080/v2";
const baseUrl = REST.replace(/\/v2\/?$/, "");

const who = process.argv[2] ?? "world";

const client = new WorkflowClient({ baseUrl });
const { processInstanceKey } = await client.start(greet, { who });
console.log(`started ${greet.id} instance ${processInstanceKey} (who=${who})`);
