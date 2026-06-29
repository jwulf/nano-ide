// Rust throughput demo — pipelined producer + drainer against a clean engine.
//
// Deploys resources/processes/throughput.bpmn, floods creates across a pooled
// connection set, and concurrently activates+completes jobs. A native producer
// pipelines creates rather than awaiting per-instance, which is the mode where
// the command stream out-throughputs REST. Run with: cargo run --release.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let base = std::env::var("NANOBPMN_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".into());
    let base = base.trim_end_matches('/').to_string();
    let pid = "throughput-demo";
    let conns: usize = env("PROD_CONNS", 256);
    let workers: usize = env("WORKER_CONNS", 64);
    let secs: u64 = env("DURATION_SECS", 15) as u64;
    let client = reqwest::Client::builder().pool_max_idle_per_host(usize::MAX).build().unwrap();

    deploy(&client, &base).await;

    let created = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicU64::new(0));
    let body = serde_json::json!({ "processDefinitionId": pid, "awaitCompletion": false }).to_string();
    let create_url = format!("{base}/v2/process-instances");
    let activate_url = format!("{base}/v2/jobs/activation");
    let t0 = Instant::now();
    let dur = Duration::from_secs(secs);
    let mut tasks = Vec::new();
    for _ in 0..conns {
        let (c, u, b, n) = (client.clone(), create_url.clone(), body.clone(), created.clone());
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                if c.post(&u).header("content-type", "application/json").body(b.clone()).send().await.is_ok() {
                    n.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for _ in 0..workers {
        let (c, base, n) = (client.clone(), base.clone(), done.clone());
        let au = activate_url.clone();
        tasks.push(tokio::spawn(async move {
            let req = serde_json::json!({ "type": "demo-job", "maxJobsToActivate": 100, "timeout": 30000 }).to_string();
            while t0.elapsed() < dur {
                if let Ok(r) = c.post(&au).header("content-type", "application/json").body(req.clone()).send().await {
                    let j: serde_json::Value = r.json().await.unwrap_or_default();
                    if let Some(jobs) = j.get("jobs").and_then(|v| v.as_array()) {
                        for job in jobs {
                            if let Some(k) = job.get("jobKey").and_then(|v| v.as_str()) {
                                let _ = c.post(format!("{base}/v2/jobs/{k}/completion")).body("{}").send().await;
                                n.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        }));
    }
    for t in tasks { let _ = t.await; }
    let c = created.load(Ordering::Relaxed);
    let d = done.load(Ordering::Relaxed);
    println!("=== {c} created (~{}/s), {d} completed (~{}/s) over {secs}s ===", c / secs, d / secs);
}

fn env(k: &str, def: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(def)
}

async fn deploy(client: &reqwest::Client, base: &str) {
    let xml = include_str!("../resources/processes/throughput.bpmn");
    let form = reqwest::multipart::Form::new().part(
        "resources",
        reqwest::multipart::Part::text(xml).file_name("throughput.bpmn").mime_str("text/xml").unwrap(),
    );
    let _ = client.post(format!("{base}/v2/deployments")).multipart(form).send().await;
}
