"""Python throughput demo — SDK-driven producer + JobWorker.

Uses the official camunda-orchestration-sdk, which auto-detects nanobpmn
gateways (via GET /v2/topology) and transparently upgrades:
  * create_process_instance -> credit-metered command-stream producer,
  * JobWorker                -> streaming push subscription.
Against stock Camunda the same code runs on plain REST.

Deploys resources/processes/throughput.bpmn, then floods await_completion=False
creates from PROD_CONNS concurrent tasks while a JobWorker drains them. A live
per-second line streams creates/s and completes/s.

Run in the Nano IDE:  press ▶ Run in the project toolbar.
Run from a terminal:  uv run main.py
Env:  CAMUNDA_REST_ADDRESS (default http://localhost:8080),
      CAMUNDA_AUTH_STRATEGY (default NONE),
      PID (default throughput-demo), JOB_TYPE (default demo-job),
      PROD_CONNS (default 64), WORKER_CONCURRENCY (default 100),
      DURATION_SECS (default 15).
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from camunda_orchestration_sdk import (
    CamundaAsyncClient,
    ConnectedJobContext,
    ProcessCreationById,
    ProcessDefinitionId,
    WorkerConfig,
)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


REST = os.environ.get("CAMUNDA_REST_ADDRESS", "http://localhost:8080")
PID = os.environ.get("PID", "throughput-demo")
JOB_TYPE = os.environ.get("JOB_TYPE", "demo-job")
PROD_CONNS = _env_int("PROD_CONNS", 64)
WORKER_CONCURRENCY = _env_int("WORKER_CONCURRENCY", 100)
DURATION_SECS = _env_int("DURATION_SECS", 15)

BPMN = Path(__file__).parent / "resources" / "processes" / "throughput.bpmn"


class Counters:
    __slots__ = ("created", "failed", "done")

    def __init__(self) -> None:
        self.created = 0
        self.failed = 0
        self.done = 0


async def main() -> None:
    counters = Counters()

    async with CamundaAsyncClient(
        configuration={
            "CAMUNDA_REST_ADDRESS": REST,
            "CAMUNDA_AUTH_STRATEGY": os.environ.get("CAMUNDA_AUTH_STRATEGY", "NONE"),
        }
    ) as client:
        print(f"deploying {BPMN.name} -> {REST}")
        deployment = await client.deploy_resources_from_files([str(BPMN)])
        print(
            f"deployed (key {deployment.deployment_key}) process '{PID}' "
            f"(job type '{JOB_TYPE}')"
        )
        print(
            f"running {DURATION_SECS}s with {PROD_CONNS} producer tasks + JobWorker "
            f"(max {WORKER_CONCURRENCY} concurrent)..."
        )

        # Job worker: SDK auto-uses command-stream push against nano gateways.
        async def handle(job: ConnectedJobContext) -> dict[str, object]:
            counters.done += 1
            return {}

        client.create_job_worker(
            config=WorkerConfig(
                job_type=JOB_TYPE,
                job_timeout_milliseconds=60_000,
                max_concurrent_jobs=WORKER_CONCURRENCY,
                worker_name="python-throughput-worker",
            ),
            callback=handle,
        )

        stop = asyncio.Event()
        instruction = ProcessCreationById(
            process_definition_id=ProcessDefinitionId(PID),
            await_completion=False,
        )

        async def producer() -> None:
            while not stop.is_set():
                try:
                    await client.create_process_instance(data=instruction)
                    counters.created += 1
                except asyncio.CancelledError:
                    raise
                except Exception:
                    counters.failed += 1

        async def reporter() -> None:
            prev_c = prev_d = 0
            t0 = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(1)
                c, d, f = counters.created, counters.done, counters.failed
                print(
                    f"[{int(time.monotonic() - t0)}s] "
                    f"created={c} (+{c - prev_c}/s) "
                    f"done={d} (+{d - prev_d}/s) failed={f}"
                )
                prev_c, prev_d = c, d

        workers_task = asyncio.create_task(client.run_workers())
        producers = [asyncio.create_task(producer()) for _ in range(PROD_CONNS)]
        reporter_task = asyncio.create_task(reporter())

        await asyncio.sleep(DURATION_SECS)
        stop.set()

        for task in (*producers, reporter_task, workers_task):
            task.cancel()
        await asyncio.gather(*producers, reporter_task, workers_task, return_exceptions=True)

        print(
            f"done: created={counters.created} completed={counters.done} "
            f"failed={counters.failed}"
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
