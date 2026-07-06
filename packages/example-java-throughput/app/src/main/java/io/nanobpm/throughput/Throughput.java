/*
 * Java throughput demo — one code path, four transports.
 *
 * Deploys throughput.bpmn to whichever gateway CAMUNDA_REST_ADDRESS (or
 * CAMUNDA_GRPC_ADDRESS) points at, then fans out awaitCompletion=false
 * createInstance calls from PROD_CONNS producers while a JobWorker drains
 * them. Same code, four combos:
 *
 *   1. Camunda 8 + REST      -> `mvn -Pstock exec:java` (default transport = REST)
 *   2. Camunda 8 + gRPC      -> `mvn -Pstock exec:java -Dexec.args=grpc`
 *   3. Nano       + REST     -> `mvn -Pfalcon exec:java -Dexec.args=rest`  (or set CAMUNDA_FORCE_REST=true)
 *   4. Nano       + Falcon   -> `mvn -Pfalcon exec:java`
 *
 * Env: CAMUNDA_REST_ADDRESS (default http://localhost:8080),
 *      CAMUNDA_GRPC_ADDRESS (default http://localhost:26500),
 *      PID, JOB_TYPE, PROD_CONNS, PIPELINE_DEPTH, WORKER_CONCURRENCY, DURATION_SECS.
 *
 * PROD_CONNS is the number of producer threads; PIPELINE_DEPTH is how many
 * createInstance requests each thread keeps in flight concurrently. Total
 * ceiling of in-flight creates is PROD_CONNS * PIPELINE_DEPTH — raise the
 * latter (not the former) to push the server harder without paying JVM
 * thread-scheduling overhead on the client. With .send().join() (depth=1)
 * every thread is stalled for a full RTT per create, so the client caps
 * before either Nano or Camunda 8 breaks a sweat and the two look identical.
 */
package io.nanobpm.throughput;

import io.camunda.client.CamundaClient;
import io.camunda.client.api.response.DeploymentEvent;
import io.camunda.client.api.worker.JobWorker;
import java.io.InputStream;
import java.net.URI;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public final class Throughput {

  public static void main(final String[] args) throws Exception {
    final String transport = args.length > 0 ? args[0].toLowerCase() : env("TRANSPORT", "rest");
    final String rest = env("CAMUNDA_REST_ADDRESS", "http://localhost:8080");
    final String grpc = env("CAMUNDA_GRPC_ADDRESS", "http://localhost:26500");
    final String pid = env("PID", "throughput-demo");
    final String jobType = env("JOB_TYPE", "demo-job");
    final int prodConns = envInt("PROD_CONNS", 256);
    final int pipelineDepth = envInt("PIPELINE_DEPTH", 32);
    final int workerConc = envInt("WORKER_CONCURRENCY", 100);
    final int seconds = envInt("DURATION_SECS", 15);

    final String profile = detectProfile();
    System.out.printf(
        "profile=%s transport=%s rest=%s grpc=%s pid=%s jobType=%s prodConns=%d pipelineDepth=%d workerConc=%d dur=%ds%n",
        profile, transport, rest, grpc, pid, jobType, prodConns, pipelineDepth, workerConc, seconds);

    // Prefer REST unless the user explicitly asks for gRPC. Falcon (WebSocket)
    // is a drop-in upgrade of the REST path — it never speaks gRPC — and the
    // camunda-client-java-falcon shim doesn't bundle io.grpc.*, so any code
    // path that touches the gRPC channel throws NoClassDefFoundError under
    // -Pfalcon. Keeping REST preferred by default lets falcon, falcon+rest,
    // and stock+rest all just work.
    final boolean preferRest = !"grpc".equals(transport);
    final boolean separateWorkerClient =
        Boolean.parseBoolean(env("SEPARATE_WORKER_CLIENT", "true"));

    // On C8 (REST or gRPC) the client holds ONE HTTP/2 or gRPC channel per
    // CamundaClient, so a JobWorker sharing the client with the producer flood
    // gets starved: the worker's activate-jobs poll queues behind thousands of
    // create RPCs on the same channel and returns few (REST) or zero (gRPC)
    // jobs. Nano Falcon multiplexes create + activate on independent
    // credit-metered streams over the same WS, so it doesn't have this
    // problem — but building two clients here is a no-op on Falcon and levels
    // the playing field for C8. Toggle off with SEPARATE_WORKER_CLIENT=false
    // to reproduce the shared-channel starvation.
    final CamundaClient producerClient = buildClient(rest, grpc, preferRest);
    final CamundaClient workerClient =
        separateWorkerClient ? buildClient(rest, grpc, preferRest) : producerClient;

    try {
      final String gatewayVersion =
          producerClient.newTopologyRequest().send().join().getGatewayVersion();
      // What's actually in front of us, and what wire are we speaking to it on?
      //   server = Nano vs Camunda 8 — inferred from the Falcon SPI (falcon
      //           only exists in the Nano SDK bundle) with a topology-version
      //           fallback so anyone reading logs can tell at a glance.
      //   wire   = REST vs gRPC vs Falcon — Falcon replaces the gRPC path
      //           only, so falcon+rest still speaks REST over the wire.
      final String serverType = detectServerType(profile, gatewayVersion);
      final String wire = detectWire(profile, transport);
      System.out.printf(
          "=== runtime: server=%s (gatewayVersion=%s)  wire=%s  workerClient=%s ===%n",
          serverType, gatewayVersion, wire,
          separateWorkerClient ? "separate" : "shared");

      try (InputStream bpmn = Throughput.class.getResourceAsStream("/processes/throughput.bpmn")) {
        if (bpmn == null) throw new IllegalStateException("throughput.bpmn missing from classpath");
        final DeploymentEvent dep = producerClient.newDeployResourceCommand()
            .addResourceStream(bpmn, "throughput.bpmn").send().join();
        System.out.printf("deployed key=%s%n", dep.getKey());
      }

      final AtomicLong created = new AtomicLong();
      final AtomicLong failed = new AtomicLong();
      final AtomicLong done = new AtomicLong();
      final long tEnd = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);

      final JobWorker worker = workerClient.newWorker()
          .jobType(jobType)
          .handler((jobClient, job) -> {
            jobClient.newCompleteCommand(job).send();
            done.incrementAndGet();
          })
          .maxJobsActive(workerConc)
          .name("nano-ide-throughput-worker")
          .open();

      final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor();
      final long t0 = System.nanoTime();
      final long[] prev = {0L, 0L};
      ticker.scheduleAtFixedRate(() -> {
        final long c = created.get(), d = done.get(), f = failed.get();
        final long tSec = TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - t0);
        System.out.printf("t=%2ds  created %d (+%d/s)  completed %d (+%d/s)  errors %d%n",
            tSec, c, c - prev[0], d, d - prev[1], f);
        prev[0] = c; prev[1] = d;
      }, 1, 1, TimeUnit.SECONDS);

      // Pipelined producer: each of prodConns threads keeps up to
      // pipelineDepth createInstance requests in flight concurrently, gated by
      // a shared semaphore so the total in-flight count is bounded. Without
      // pipelining, .send().join() would stall each producer thread for a full
      // RTT per create — capping aggregate throughput at ~prodConns/RTT and
      // making Nano and Camunda 8 look identical because the client bottleneck
      // hits first. With PIPELINE_DEPTH=32 the client can push ~8k in-flight
      // creates at 256 conns, which is enough to saturate either server's
      // commit path and let the differences actually show.
      final Semaphore permits = new Semaphore(prodConns * pipelineDepth);
      final ExecutorService producers = Executors.newFixedThreadPool(prodConns);
      for (int i = 0; i < prodConns; i++) {
        producers.submit(() -> {
          while (System.nanoTime() < tEnd) {
            try {
              permits.acquire();
            } catch (final InterruptedException ie) {
              Thread.currentThread().interrupt();
              return;
            }
            try {
              producerClient.newCreateInstanceCommand()
                  .bpmnProcessId(pid).latestVersion()
                  .send()
                  .whenComplete((r, e) -> {
                    if (e != null) failed.incrementAndGet();
                    else created.incrementAndGet();
                    permits.release();
                  });
            } catch (final Exception e) {
              // Synchronous submission failure (e.g. client shutdown) — the
              // future was never created so release the permit ourselves.
              failed.incrementAndGet();
              permits.release();
            }
          }
        });
      }

      producers.shutdown();
      producers.awaitTermination(seconds + 60L, TimeUnit.SECONDS);
      // Drain outstanding in-flight creates so the final count reflects work
      // the server actually acked, not what we merely dispatched.
      permits.acquire(prodConns * pipelineDepth);
      Thread.sleep(500); // let the worker drain the tail
      ticker.shutdownNow();
      worker.close();

      final long c = created.get(), d = done.get(), f = failed.get();
      final long s = Math.max(1, seconds);
      System.out.printf("=== %d created (~%d/s), %d completed (~%d/s), %d errors over %ds ===%n",
          c, c / s, d, d / s, f, seconds);
    } finally {
      producerClient.close();
      if (separateWorkerClient) workerClient.close();
    }
  }

  /**
   * Builds a fresh CamundaClient. On C8 (REST or gRPC) each client owns its
   * own HTTP/2 or gRPC channel, so calling this twice gives producers and the
   * JobWorker independent bandwidth to the same broker. On Nano the Falcon
   * shim intercepts client construction and opens its own WS multiplex — a
   * second client just opens a second WS, still fast.
   */
  private static CamundaClient buildClient(
      final String rest, final String grpc, final boolean preferRest) {
    return CamundaClient.newClientBuilder()
        .restAddress(URI.create(rest))
        .grpcAddress(URI.create(grpc))
        .preferRestOverGrpc(preferRest)
        .defaultRequestTimeout(java.time.Duration.ofSeconds(30))
        .build();
  }

  private static String detectProfile() {
    try {
      Class.forName("com.nanobpm.camunda.falcon.FalconTransport");
      return "falcon";
    } catch (final ClassNotFoundException e) {
      return "stock";
    }
  }

  /**
   * Server identity from the client's perspective. If the Falcon transport SPI
   * is on the classpath the target has to be Nano (Falcon has no reason to
   * exist for Camunda 8), otherwise we fall back to the gateway version
   * string, which for Nano contains "nano".
   */
  private static String detectServerType(final String profile, final String gatewayVersion) {
    if ("falcon".equals(profile)) return "Nano";
    if (gatewayVersion != null && gatewayVersion.toLowerCase().contains("nano")) return "Nano";
    return "Camunda 8";
  }

  /**
   * Effective wire protocol. Falcon only replaces the gRPC path, so a
   * `falcon` build asked for REST still speaks REST over the wire.
   */
  private static String detectWire(final String profile, final String transport) {
    if ("rest".equals(transport)) return "REST";
    return "falcon".equals(profile) ? "Falcon" : "gRPC";
  }

  private static String env(final String k, final String def) {
    final String v = System.getenv(k);
    return v == null || v.isEmpty() ? def : v;
  }

  private static int envInt(final String k, final int def) {
    try { return Integer.parseInt(env(k, String.valueOf(def))); }
    catch (final NumberFormatException e) { return def; }
  }
}
