// Embedded μ-nano starter (ADR 0005). The Nano engine runs IN this process via
// wasm — no gateway, no sockets. The nano-sdk-js "embedded" transport binds to the
// host directly, so the same SDK code that talks to a real cluster also drives the
// in-process engine. `deno compile` embeds the engine wasm + app as one binary.
import { createCamundaClient, ProcessDefinitionId } from "@nanobpm/nano-sdk";
import { EmbeddedHost } from "./engine/host.ts";

const BPMN = await Deno.readTextFile(new URL("./resources/processes/throughput.bpmn", import.meta.url));
const PID = ProcessDefinitionId.assumeExists("throughput");

const host = await EmbeddedHost.create();
await host.deploy(BPMN);

const camunda = createCamundaClient({ config: { CAMUNDA_TRANSPORT: "embedded" }, embeddedHost: host });

camunda.createJobWorker({
  jobType: "work",
  workerName: "embedded-worker",
  maxParallelJobs: 16,
  jobHandler: async (job) => job.complete({ done: true }),
});

const N = Number(Deno.env.get("N") ?? 1000);
const t0 = performance.now();
await Promise.all(
  Array.from({ length: N }, () =>
    camunda.createProcessInstance({ processDefinitionId: PID, variables: {}, awaitCompletion: true })),
);
const dt = (performance.now() - t0) / 1000;
console.log(`embedded: ${N} instances in ${dt.toFixed(2)}s — ${(N / dt).toFixed(0)}/s`);
camunda.stopAllWorkers?.();
