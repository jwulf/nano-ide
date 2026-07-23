// Starter (TypeScript on Node) — a complete, runnable Camunda 8 app.
//
// A minimal end-to-end loop on the official @camunda8/orchestration-cluster-api
// SDK, run on the local Node runtime (no Deno required — so this works on
// Deno-less hosts such as a Raspberry Pi 2B / 32-bit ARM):
//
//   1. connect + print the gateway topology,
//   2. deploy resources/processes/starter.bpmn,
//   3. register a job worker for the `hello` service task,
//   4. create one process instance,
//   5. the worker completes the job by echoing its variables.
//
// The worker stays open after the demo instance completes, so you can create
// more instances from the console (or re-run) and watch them flow. Ctrl-C stops.
//
// Run:  npm start          (node --experimental-strip-types main.ts; needs Node >= 22.6)
// Type: npm run typecheck  (tsc --noEmit)
// Env:  CAMUNDA_REST_ADDRESS   (default http://localhost:8080; the Nano console
//                               also exports NANOBPMN_BASE_URL, honoured below)
//       CAMUNDA_AUTH_STRATEGY  (default NONE — a local Nano / C8 dev gateway runs
//                               without auth; set OAUTH or BASIC for a secured
//                               cluster and provide the matching CAMUNDA_* vars)
//
// Zero-code path to Falcon: the official SDK auto-detects a Nano gateway
// (GET /v2/topology) and transparently upgrades create + job push to the
// command-stream / Falcon transport. The same code runs on plain REST against
// stock Camunda 8.

import { fileURLToPath } from "node:url";
import {
  createCamundaClient,
  type ProcessDefinitionId,
} from "@camunda8/orchestration-cluster-api";

const REST =
  process.env.CAMUNDA_REST_ADDRESS ??
  process.env.NANOBPMN_BASE_URL ??
  "http://localhost:8080";
const PID = "starter-process" as ProcessDefinitionId;
const JOB_TYPE = "hello";
const BPMN = fileURLToPath(
  new URL("./resources/processes/starter.bpmn", import.meta.url),
);

async function main(): Promise<void> {
  const camunda = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: REST,
      CAMUNDA_AUTH_STRATEGY: (process.env.CAMUNDA_AUTH_STRATEGY ??
        "NONE") as "NONE" | "OAUTH" | "BASIC",
    },
  });

  const topology = await camunda.getTopology();
  console.log(
    `connected to ${REST}: gatewayVersion=${topology.gatewayVersion}, ` +
      `clusterSize=${topology.clusterSize}`,
  );

  console.log(`deploying ${BPMN.split("/").pop()}`);
  const deployment = await camunda.deployResourcesFromFiles([BPMN]);
  console.log(
    `deployed (key ${deployment.deploymentKey}) process '${PID}'`,
  );

  // Worker for the `hello` service task: echo the instance variables and
  // complete the job (returning outputs completes it with those variables).
  const worker = camunda.createJobWorker({
    jobType: JOB_TYPE,
    jobTimeoutMs: 60_000,
    maxParallelJobs: 5,
    workerName: "node-starter",
    jobHandler: async (job) => {
      const variables = job.variables ?? {};
      console.log(
        `worker handled job ${job.jobKey} (${job.type}) ` +
          `variables=${JSON.stringify(variables)}`,
      );
      return job.complete({ handledBy: "node-starter", ...variables });
    },
  });

  // Create one instance to exercise the full loop end to end.
  const instance = await camunda.createProcessInstance({
    processDefinitionId: PID,
    variables: { greeting: "hello from node-starter" },
  });
  console.log(`created process instance ${instance.processInstanceKey}`);

  console.log("worker `hello` open. Ctrl-C to stop.");

  // Keep the process alive until interrupted, then close the worker cleanly.
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await worker.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
