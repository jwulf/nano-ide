// Throughput (Rust) — the mode where the command stream actually wins.
//
// This template uses the official camunda-orchestration-sdk. Against a
// nanobpmn gateway it auto-detects the command stream and routes every
// create_process_instance call through a shared, credit-metered producer —
// so the fan-out below pipelines over a single WebSocket instead of
// hammering REST. Against stock Camunda the same code runs on plain REST.
//
// cargo run --release. Env: CAMUNDA_REST_ADDRESS, PID, PROD_CONNS.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use camunda_orchestration_sdk::models::{
    ProcessDefinitionId, ProcessInstanceCreationInstruction,
    ProcessInstanceCreationInstructionById,
};
use camunda_orchestration_sdk::CamundaClient;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pid = std::env::var("PID").unwrap_or_else(|_| "throughput-demo".into());
    let conns: usize = std::env::var("PROD_CONNS").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
    let dur = Duration::from_secs(15);

    let client = CamundaClient::from_env()?;
    let created = Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..conns {
        let client = client.clone();
        let pid = pid.clone();
        let n = created.clone();
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                let instruction = ProcessInstanceCreationInstruction::ProcessInstanceCreationInstructionById(
                    Box::new(ProcessInstanceCreationInstructionById {
                        process_definition_id: ProcessDefinitionId::assume_exists(&pid),
                        await_completion: Some(false),
                        ..Default::default()
                    }),
                );
                if client.create_process_instance(instruction).await.is_ok() {
                    n.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
    let total = created.load(Ordering::Relaxed);
    println!("=== {total} created in 15s, ~{}/s ===", total / 15);
    Ok(())
}
