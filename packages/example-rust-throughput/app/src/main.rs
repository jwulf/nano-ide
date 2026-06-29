// Rust throughput demo — pipelined producer + concurrent drainer.
//
// Deploys resources/processes/throughput.bpmn, floods awaitCompletion:false
// creates across pooled connections, and concurrently activates + completes jobs
// so the process runs end to end. A live per-second line streams creates/s and
// completes/s so you can watch it work. cargo run --release.
// Tunables (env): PROD_CONNS, WORKER_CONNS, DURATION_SECS.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let base = std::env::var("NANOBPMN_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".into());
    let base = base.trim_end_matches('/').to_string();
    let pid = std::env::var("PID").unwrap_or_else(|_| "throughput-demo".into());
    let job_type = std::env::var("JOB_TYPE").unwrap_or_else(|_| "demo-job".into());
    let conns: usize = env("PROD_CONNS", 256);
    let workers: usize = env("WORKER_CONNS", 64);
    let secs: u64 = env("DURATION_SECS", 15) as u64;
    let client = reqwest::Client::builder().pool_max_idle_per_host(usize::MAX).build().unwrap();

    println!("deploying throughput.bpmn -> {base}");
    match deploy(&client, &base).await {
        Ok(true) => println!("deployed process '{pid}' (job type '{job_type}')"),
        Ok(false) => eprintln!("warning: deploy returned non-success — is the gateway at {base}?"),
        Err(e) => { eprintln!("deploy failed: {e}"); return; }
    }
    println!("running {secs}s with {conns} producer + {workers} drainer connections...");

    let created = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicU64::new(0));
    let create_url = format!("{base}/v2/process-instances");
    let activate_url = format!("{base}/v2/jobs/activation");
    let body = serde_json::json!({ "processDefinitionId": pid, "awaitCompletion": false }).to_string();
    let activate = serde_json::json!({ "type": job_type, "maxJobsToActivate": 100, "timeout": 30000 }).to_string();
    let t0 = Instant::now();
    let dur = Duration::from_secs(secs);
    let mut tasks = Vec::new();

    // Live progress: one line per second with per-second deltas.
    {
        let (created, done, failed) = (created.clone(), done.clone(), failed.clone());
        tasks.push(tokio::spawn(async move {
            let (mut pc, mut pd) = (0u64, 0u64);
            while t0.elapsed() < dur {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let (c, d, f) = (created.load(Ordering::Relaxed), done.load(Ordering::Relaxed), failed.load(Ordering::Relaxed));
                println!("t={:>2}s  created {c} (+{}/s)  completed {d} (+{}/s)  errors {f}", t0.elapsed().as_secs(), c - pc, d - pd);
                pc = c; pd = d;
            }
        }));
    }

    // Producers: pipeline awaitCompletion:false creates across pooled connections.
    for _ in 0..conns {
        let (c, u, b, n, fe) = (client.clone(), create_url.clone(), body.clone(), created.clone(), failed.clone());
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                match c.post(&u).header("content-type", "application/json").body(b.clone()).send().await {
                    Ok(r) if r.status().is_success() => { n.fetch_add(1, Ordering::Relaxed); }
                    _ => { fe.fetch_add(1, Ordering::Relaxed); }
                }
            }
        }));
    }

    // Drainers: activate up to 100 jobs, then complete the batch concurrently —
    // sequential completion would bottleneck the drain far below the create rate.
    for _ in 0..workers {
        let (c, base, n, au, req) = (client.clone(), base.clone(), done.clone(), activate_url.clone(), activate.clone());
        tasks.push(tokio::spawn(async move {
            while t0.elapsed() < dur {
                let Ok(r) = c.post(&au).header("content-type", "application/json").body(req.clone()).send().await else { continue };
                let j: serde_json::Value = r.json().await.unwrap_or_default();
                let Some(jobs) = j.get("jobs").and_then(|v| v.as_array()) else { continue };
                let mut batch = Vec::new();
                for job in jobs {
                    if let Some(k) = job.get("jobKey").and_then(|v| v.as_str()) {
                        let (c, base, k) = (c.clone(), base.clone(), k.to_string());
                        batch.push(tokio::spawn(async move {
                            c.post(format!("{base}/v2/jobs/{k}/completion"))
                                .header("content-type", "application/json").body("{}").send().await
                                .map(|r| r.status().is_success()).unwrap_or(false)
                        }));
                    }
                }
                for b in batch { if let Ok(true) = b.await { n.fetch_add(1, Ordering::Relaxed); } }
            }
        }));
    }

    for t in tasks { let _ = t.await; }
    let (c, d, f) = (created.load(Ordering::Relaxed), done.load(Ordering::Relaxed), failed.load(Ordering::Relaxed));
    let s = secs.max(1);
    println!("=== {c} created (~{}/s), {d} completed (~{}/s), {f} errors over {secs}s ===", c / s, d / s);
}

fn env(k: &str, def: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(def)
}

async fn deploy(client: &reqwest::Client, base: &str) -> Result<bool, String> {
    let xml = include_str!("../resources/processes/throughput.bpmn");
    let form = reqwest::multipart::Form::new().part(
        "resources",
        reqwest::multipart::Part::text(xml).file_name("throughput.bpmn").mime_str("text/xml").map_err(|e| e.to_string())?,
    );
    let r = client.post(format!("{base}/v2/deployments")).multipart(form).send().await.map_err(|e| e.to_string())?;
    Ok(r.status().is_success())
}
