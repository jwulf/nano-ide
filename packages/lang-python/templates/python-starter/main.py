"""Starter (Python) — a complete, runnable Camunda 8 app.

A minimal end-to-end loop on the official camunda-orchestration-sdk:

  1. connect + print the gateway topology,
  2. deploy resources/processes/starter.bpmn,
  3. register a job worker for the `hello` service task,
  4. create one process instance,
  5. the worker completes the job by echoing its variables.

The worker stays open after the demo instance completes, so you can create
more instances from the console (or re-run) and watch them flow. Ctrl-C to stop.

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
import contextlib
import json
import os
from pathlib import Path

from camunda_orchestration_sdk import (
    CamundaAsyncClient,
    ConnectedJobContext,
    ProcessCreationById,
    ProcessDefinitionId,
    ProcessInstanceCreationInstructionByIdVariables,
    WorkerConfig,
)

REST = os.environ.get("CAMUNDA_REST_ADDRESS", "http://localhost:8080")
PID = "starter-process"
JOB_TYPE = "hello"
BPMN = Path(__file__).parent / "resources" / "processes" / "starter.bpmn"


async def main() -> None:
    async with CamundaAsyncClient(
        configuration={
            "CAMUNDA_REST_ADDRESS": REST,
            "CAMUNDA_AUTH_STRATEGY": os.environ.get("CAMUNDA_AUTH_STRATEGY", "NONE"),
        }
    ) as client:
        topology = await client.get_topology()
        print(
            f"connected to {REST}: gatewayVersion={topology.gateway_version}, "
            f"clusterSize={topology.cluster_size}"
        )

        print(f"deploying {BPMN.name}")
        deployment = await client.deploy_resources_from_files([str(BPMN)])
        print(f"deployed (key {deployment.deployment_key}) process '{PID}'")

        # Worker for the `hello` service task: echo the instance variables and
        # complete the job (returning a dict completes it with those outputs).
        async def handle_hello(job: ConnectedJobContext) -> dict[str, object]:
            variables = job.variables.to_dict()
            print(
                f"worker handled job {job.job_key} ({job.type_}) "
                f"variables={json.dumps(variables)}"
            )
            return {"handledBy": "python-starter", **variables}

        client.create_job_worker(
            config=WorkerConfig(
                job_type=JOB_TYPE,
                job_timeout_milliseconds=60_000,
                worker_name="python-starter",
            ),
            callback=handle_hello,
        )
        workers_task = asyncio.create_task(client.run_workers())
        try:
            # Create one instance to exercise the full loop end to end.
            instance = await client.create_process_instance(
                data=ProcessCreationById(
                    process_definition_id=ProcessDefinitionId(PID),
                    variables=ProcessInstanceCreationInstructionByIdVariables.from_dict(
                        {"greeting": "hello from python-starter"}
                    ),
                    await_completion=False,
                )
            )
            print(f"created process instance {instance.process_instance_key}")

            print("worker `hello` open. Ctrl-C to stop.")
            await workers_task
        finally:
            # Don't leak the worker task if instance creation (or the await
            # above) raised — cancel and await it so the loop shuts down clean
            # rather than emitting "Task was destroyed but it is pending".
            workers_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await workers_task


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
