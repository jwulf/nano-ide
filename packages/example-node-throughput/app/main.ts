// Node throughput demo (TypeScript on Node) — SDK-driven producer + JobWorker.
//
// Uses @nanobpm/nano-sdk, a drop-in for the official
// @camunda8/orchestration-cluster-api that auto-detects a Nano gateway (via
// GET /v2/topology) and transparently upgrades:
//   * createProcessInstance -> credit-metered command-stream / Falcon producer,
//   * createJobWorker        -> streaming push (subscribe) subscription.
// Against stock Camunda 8 the same code runs on plain REST.
//
// Deploys resources/processes/throughput.bpmn, then floods non-awaited creates
// from PROD_CONNS concurrent producers while a JobWorker drains them. A live
// per-second line streams creates/s and completes/s, then a summary prints after
// DURATION_SECS.
//
// Run in the Nano IDE:  press ▶ Run in the project toolbar.
// Run from a terminal:  npm start   (node --experimental-strip-types main.ts; needs Node >= 22.6)
// Type: npm run typecheck  (tsc --noEmit)
// Env:  CAMUNDA_REST_ADDRESS   (default http://localhost:8080; the Nano console
//                               also exports NANOBPMN_BASE_URL, honoured below)
//       CAMUNDA_AUTH_STRATEGY  (default NONE)
//       PID (default throughput-demo), JOB_TYPE (default demo-job),
//       PROD_CONNS (default 64), WORKER_CONCURRENCY (default 100),
//       DURATION_SECS (default 15).

import { fileURLToPath } from "node:url";
import {
  createCamundaClient,
  type ProcessDefinitionId,
} from "@nanobpm/nano-sdk";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

const REST =
  process.env.CAMUNDA_REST_ADDRESS ??
  process.env.NANOBPMN_BASE_URL ??
  "http://localhost:8080";
const PID = (process.env.PID ?? "throughput-demo") as ProcessDefinitionId;
const JOB_TYPE = process.env.JOB_TYPE ?? "demo-job";
const PROD_CONNS = envInt("PROD_CONNS", 64);
const WORKER_CONCURRENCY = envInt("WORKER_CONCURRENCY", 100);
const DURATION_SECS = envInt("DURATION_SECS", 15);

const BPMN = fileURLToPath(
  new URL("./resources/processes/throughput.bpmn", import.meta.url),
);

const counters = { created: 0, failed: 0, done: 0 };

async function main(): Promise<void> {
  const camunda = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: REST,
      CAMUNDA_AUTH_STRATEGY: (process.env.CAMUNDA_AUTH_STRATEGY ??
        "NONE") as "NONE" | "OAUTH" | "BASIC",
    },
  });

  console.log(`deploying ${BPMN.split("/").pop()} -> ${REST}`);
  const deployment = await camunda.deployResourcesFromFiles([BPMN]);
  console.log(
    `deployed (key ${deployment.deploymentKey}) process '${PID}' ` +
      `(job type '${JOB_TYPE}')`,
  );
  console.log(
    `running ${DURATION_SECS}s with ${PROD_CONNS} producer tasks + JobWorker ` +
      `(max ${WORKER_CONCURRENCY} concurrent)...`,
  );

  // Job worker: SDK auto-uses command-stream / Falcon push against Nano gateways.
  const worker = camunda.createJobWorker({
    jobType: JOB_TYPE,
    jobTimeoutMs: 60_000,
    maxParallelJobs: WORKER_CONCURRENCY,
    workerName: "node-throughput-worker",
    jobHandler: async (job) => {
      counters.done += 1;
      return job.complete({});
    },
  });

  let stopped = false;

  async function producer(): Promise<void> {
    while (!stopped) {
      try {
        await camunda.createProcessInstance({ processDefinitionId: PID });
        counters.created += 1;
      } catch {
        counters.failed += 1;
      }
    }
  }

  const t0 = Date.now();
  let prevC = 0;
  let prevD = 0;
  const reporter = setInterval(() => {
    const { created: c, done: d, failed: f } = counters;
    console.log(
      `[${Math.round((Date.now() - t0) / 1000)}s] ` +
        `created=${c} (+${c - prevC}/s) done=${d} (+${d - prevD}/s) failed=${f}`,
    );
    prevC = c;
    prevD = d;
  }, 1000);

  const producers = Array.from({ length: PROD_CONNS }, () => producer());

  await new Promise((resolve) => setTimeout(resolve, DURATION_SECS * 1000));

  stopped = true;
  clearInterval(reporter);
  await Promise.allSettled(producers);
  await worker.stop();

  console.log(
    `done: created=${counters.created} completed=${counters.done} ` +
      `failed=${counters.failed}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
