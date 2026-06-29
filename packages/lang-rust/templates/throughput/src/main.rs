// Throughput (Rust) — the mode where the command stream actually wins.
//
// Unlike the JS demos (single-socket, await-per-create), a native producer
// pipelines creates concurrently across pooled connections. The README A/B
// shows ~32k/s here vs ~20k REST. This starter drives REST creates via reqwest;
// swap to the command stream for the headline number. cargo run --release.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let base = std::env::var("NANOBPMN_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".into());
    let pid = std::env::var("PID").unwrap_or_else(|_| "throughput-demo".into());
    let conns: usize = std::env::var("PROD_CONNS").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
    let dur = Duration::from_secs(15);
    let created = Arc::new(AtomicU64::new(0));
    let body = serde_json::json!({ "processDefinitionId": pid, "awaitCompletion": false }).to_string();
    let client = reqwest::Client::builder().pool_max_idle_per_host(usize::MAX).build().unwrap();
    let url = format!("{}/v2/process-instances", base.trim_end_matches('/'));
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..conns {
        let c = client.clone(); let u = url.clone(); let b = body.clone(); let n = created.clone();
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                if c.post(&u).header("content-type", "application/json").body(b.clone()).send().await.is_ok() {
                    n.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for t in tasks { let _ = t.await; }
    let total = created.load(Ordering::Relaxed);
    println!("=== {total} created in 15s, ~{}/s ===", total / 15);
}
