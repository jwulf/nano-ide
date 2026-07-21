"""Starter (Python) — the "hello, Camunda" the official SDK can run today.

Reads CAMUNDA_REST_ADDRESS from the environment (falls back to
http://localhost:8080), fetches the gateway topology, then registers a job
worker for the `hello` job type that completes each job by echoing its
variables.

Run:  uv run main.py
Env:  CAMUNDA_REST_ADDRESS   (default http://localhost:8080)
      CAMUNDA_AUTH_STRATEGY  (default NONE — a local Nano / C8 dev gateway runs
                              without auth; set OAUTH or BASIC for a secured
                              cluster and provide the matching CAMUNDA_* vars)

Zero-code path to Falcon: the official camunda-orchestration-sdk auto-detects a
Nano gateway (GET /v2/topology) and transparently upgrades create + job push to
the command-stream / Falcon transport. The same code runs on plain REST against
stock Camunda 8.
"""

from __future__ import annotations

import asyncio
import json
import os

from camunda_orchestration_sdk import (
    CamundaAsyncClient,
    ConnectedJobContext,
    WorkerConfig,
)


async def main() -> None:
    rest = os.environ.get("CAMUNDA_REST_ADDRESS", "http://localhost:8080")

    async with CamundaAsyncClient(
        configuration={
            "CAMUNDA_REST_ADDRESS": rest,
            "CAMUNDA_AUTH_STRATEGY": os.environ.get("CAMUNDA_AUTH_STRATEGY", "NONE"),
        }
    ) as client:
        topology = await client.get_topology()
        print(
            f"connected to {rest}: gatewayVersion={topology.gateway_version}, "
            f"clusterSize={topology.cluster_size}"
        )

        # Register a worker for job type `hello`. Deploy a BPMN with a service
        # task using this job type from the console, then create an instance —
        # this worker completes each job by echoing its input variables.
        async def handle_hello(job: ConnectedJobContext) -> dict[str, object]:
            variables = job.variables.to_dict()
            print(f"job {job.job_key} ({job.type_}) variables={json.dumps(variables)}")
            return variables

        client.create_job_worker(
            config=WorkerConfig(
                job_type="hello",
                job_timeout_milliseconds=60_000,
                worker_name="python-starter",
            ),
            callback=handle_hello,
        )

        print("worker `hello` open. Ctrl-C to stop.")
        await client.run_workers()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
