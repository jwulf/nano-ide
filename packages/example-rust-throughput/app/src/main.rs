// Rust throughput demo — SDK-driven producer + JobWorker.
//
// Uses the official camunda-orchestration-sdk, which auto-detects nanobpmn
// gateways (via GET /v2/topology) and transparently upgrades:
//   * create_process_instance -> credit-metered command-stream producer,
//   * JobWorker                -> streaming push subscription.
// Against stock Camunda the same code runs on plain REST.
//
// Deploys resources/processes/throughput.bpmn, then floods awaitCompletion:false
// creates from PROD_CONNS concurrent tasks while a JobWorker drains them.
// A live per-second line streams creates/s and completes/s.
//
// Env: CAMUNDA_REST_ADDRESS (default http://localhost:8080), PID, JOB_TYPE,
//      PROD_CONNS, WORKER_CONCURRENCY, DURATION_SECS.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use camunda_orchestration_sdk::models::{
    ProcessDefinitionId, ProcessInstanceCreationInstruction,
    ProcessInstanceCreationInstructionById,
};
use camunda_orchestration_sdk::{CamundaClient, JobAction, JobWorkerConfig};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pid = std::env::var("PID").unwrap_or_else(|_| "throughput-demo".into());
    let job_type = std::env::var("JOB_TYPE").unwrap_or_else(|_| "demo-job".into());
    let conns: usize = env_usize("PROD_CONNS", 256);
    let worker_concurrency: i32 = env_usize("WORKER_CONCURRENCY", 100) as i32;
    let secs: u64 = env_usize("DURATION_SECS", 15) as u64;

    let client = CamundaClient::from_env()?;
    let base = client.config().rest_address.clone();

    // Deploy throughput.bpmn to a temp file so we can hand a path to the SDK.
    let bpmn_path = std::env::temp_dir().join("nano-ide-throughput.bpmn");
    std::fs::write(&bpmn_path, include_str!("../resources/processes/throughput.bpmn"))?;
    println!("deploying throughput.bpmn -> {base}");
    let deployment = client.deploy_resources(vec![PathBuf::from(&bpmn_path)], None).await?;
    println!("deployed (key {}) process '{pid}' (job type '{job_type}')", deployment.deployment_key);
    println!("running {secs}s with {conns} producer tasks + JobWorker (max {worker_concurrency}/activation)...");

    let created = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    let dur = Duration::from_secs(secs);

    // Job worker: SDK auto-uses command-stream push against nano gateways.
    let done_w = done.clone();
    let worker = client.create_job_worker(
        JobWorkerConfig::new(&job_type)
            .worker_name("nano-ide-throughput-worker")
            .max_jobs_to_activate(worker_concurrency),
    );
    let worker_handle = worker.spawn(move |_job| {
        let done_w = done_w.clone();
        async move {
            done_w.fetch_add(1, Ordering::Relaxed);
            JobAction::complete()
        }
    });

    let mut tasks = Vec::new();

    // Live progress: one line per second with per-second deltas.
    {
        let (created, done, failed) = (created.clone(), done.clone(), failed.clone());
        tasks.push(tokio::spawn(async move {
            let (mut pc, mut pd) = (0u64, 0u64);
            while t0.elapsed() < dur {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let (c, d, f) = (
                    created.load(Ordering::Relaxed),
                    done.load(Ordering::Relaxed),
                    failed.load(Ordering::Relaxed),
                );
                println!(
                    "t={:>2}s  created {c} (+{}/s)  completed {d} (+{}/s)  errors {f}",
                    t0.elapsed().as_secs(),
                    c - pc,
                    d - pd
                );
                pc = c;
                pd = d;
            }
        }));
    }

    // Producers: fan out create_process_instance calls. On nano they all funnel
    // through the SDK's shared, credit-metered command-stream producer.
    for _ in 0..conns {
        let client = client.clone();
        let pid = pid.clone();
        let (n, fe) = (created.clone(), failed.clone());
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                let instruction = ProcessInstanceCreationInstruction::ProcessInstanceCreationInstructionById(
                    Box::new(ProcessInstanceCreationInstructionById {
                        process_definition_id: ProcessDefinitionId::assume_exists(&pid),
                        await_completion: Some(false),
                        ..Default::default()
                    }),
                );
                match client.create_process_instance(instruction).await {
                    Ok(_) => { n.fetch_add(1, Ordering::Relaxed); }
                    Err(_) => { fe.fetch_add(1, Ordering::Relaxed); }
                }
            }
        }));
    }

    for t in tasks {
        let _ = t.await;
    }

    // Give the worker a moment to drain the tail, then stop.
    tokio::time::sleep(Duration::from_millis(500)).await;
    worker_handle.stop();

    let (c, d, f) = (
        created.load(Ordering::Relaxed),
        done.load(Ordering::Relaxed),
        failed.load(Ordering::Relaxed),
    );
    let s = secs.max(1);
    println!("=== {c} created (~{}/s), {d} completed (~{}/s), {f} errors over {secs}s ===", c / s, d / s);
    let _ = std::fs::remove_file(&bpmn_path);
    Ok(())
}

fn env_usize(k: &str, def: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(def)
}
