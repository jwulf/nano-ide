// Starter (Rust) — a complete, runnable Camunda 8 app.
//
// A minimal end-to-end loop on the official camunda-orchestration-sdk:
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
// Run in the Nano IDE:  press ▶ Run in the project toolbar.
// Run from a terminal:  cargo run --release
// Env:  CAMUNDA_REST_ADDRESS   (default http://localhost:8080)
//       CAMUNDA_AUTH_STRATEGY  (default NONE — a local Nano / C8 dev gateway
//                               runs without auth; set OAUTH or BASIC for a
//                               secured cluster and provide the CAMUNDA_* vars)
//
// Zero-code path to Falcon: the official camunda-orchestration-sdk auto-detects
// a Nano gateway (GET /v2/topology) and transparently upgrades create + job push
// to the command-stream / Falcon transport. The same code runs on plain REST
// against stock Camunda 8.
use std::path::PathBuf;

use camunda_orchestration_sdk::models::{
    ProcessDefinitionId, ProcessInstanceCreationInstruction,
    ProcessInstanceCreationInstructionById,
};
use camunda_orchestration_sdk::{CamundaClient, JobAction, JobWorkerConfig};

/// The BPMN process id and the service-task job type wired together below.
const PROCESS_ID: &str = "starter-process";
const JOB_TYPE: &str = "hello";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = CamundaClient::from_env()?;
    let rest = client.config().rest_address.clone();

    let topology = client.topology().await?;
    println!(
        "connected to {rest}: gatewayVersion={}, clusterSize={}",
        topology.gateway_version, topology.cluster_size
    );

    // Deploy the model. `cargo run` sets the cwd to the project dir; the built
    // binary may run from elsewhere, so fall back to the compile-time crate dir.
    let bpmn = resolve_bpmn().ok_or(
        "starter.bpmn not found (expected resources/processes/starter.bpmn)",
    )?;
    println!("deploying {}", bpmn.display());
    let deployment = client.deploy_resources(vec![bpmn], None).await?;
    println!(
        "deployed (key {}) process '{PROCESS_ID}'",
        deployment.deployment_key
    );

    // Worker for the `hello` service task: echo the instance variables and
    // complete the job (returning them as output). `spawn` runs the poll loop on
    // the Tokio runtime and returns a handle, so it drains jobs concurrently with
    // the instance we create below.
    let worker = client.create_job_worker(
        JobWorkerConfig::new(JOB_TYPE)
            .worker_name("rust-starter")
            .max_jobs_to_activate(10),
    );
    let worker_handle = worker.spawn(|job| async move {
        let mut variables = job.variables().clone();
        println!(
            "worker handled job {} ({}) variables={}",
            job.key(),
            job.job_type(),
            serde_json::to_string(&variables).unwrap_or_default()
        );
        variables.insert("handledBy".into(), serde_json::json!("rust-starter"));
        JobAction::complete_with(variables)
    });
    println!("worker `{JOB_TYPE}` open. Ctrl-C to stop.");

    // Create one instance to exercise the full loop end to end.
    let instruction = ProcessInstanceCreationInstruction::ProcessInstanceCreationInstructionById(
        Box::new(ProcessInstanceCreationInstructionById {
            process_definition_id: ProcessDefinitionId::assume_exists(PROCESS_ID),
            variables: Some(
                [("greeting".to_string(), serde_json::json!("hello from rust-starter"))]
                    .into_iter()
                    .collect(),
            ),
            await_completion: Some(false),
            ..Default::default()
        }),
    );
    let instance = client.create_process_instance(instruction).await?;
    println!("created process instance {}", instance.process_instance_key);

    // Keep the worker running so you can create more instances from the console.
    tokio::signal::ctrl_c().await?;
    worker_handle.stop();
    Ok(())
}

/// Locate `resources/processes/starter.bpmn` under the current working dir
/// (`cargo run`) or the crate dir (a relocated release binary).
fn resolve_bpmn() -> Option<PathBuf> {
    const REL: &str = "resources/processes/starter.bpmn";
    let cwd = PathBuf::from(REL);
    if cwd.is_file() {
        return Some(cwd);
    }
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(REL);
    crate_dir.is_file().then_some(crate_dir)
}
