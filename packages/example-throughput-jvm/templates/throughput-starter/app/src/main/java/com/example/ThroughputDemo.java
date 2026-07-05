package com.example;

import io.camunda.client.CamundaClient;
import io.camunda.client.api.worker.JobWorker;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.HdrHistogram.ConcurrentHistogram;
import org.HdrHistogram.Histogram;

/**
 * Throughput demo — same source, four permutations. Nothing about the
 * server or the transport is baked into this file.
 *
 * <h2>Axis 1: change server, no code change</h2>
 *
 * Both SDKs honour standard env vars. Point at Camunda 8 or Nano by
 * setting {@code CAMUNDA_REST_ADDRESS} / {@code CAMUNDA_GRPC_ADDRESS};
 * flip REST↔gRPC with {@code CAMUNDA_PREFER_REST_OVER_GRPC}.
 *
 * <h2>Axis 2: change transport, dependency change only</h2>
 *
 * The default pom depends on {@code io.camunda:camunda-client-java} —
 * REST and gRPC. Activate the {@code -Pfalcon} Maven profile to swap the
 * coordinate for {@code io.github.jwulf:camunda-client-java-falcon}, a
 * drop-in fork that additionally auto-detects Nano's Falcon protocol via
 * {@code GET /v2/topology}. No source changes. The Falcon fork also
 * responds to {@code CAMUNDA_FORCE_REST=1} if you want to opt out at
 * runtime.
 */
public final class ThroughputDemo {

  public static void main(final String[] args) throws Exception {

    // Demo-only knobs (not transport-related).
    final int durationS = Integer.parseInt(env("WORKLOAD_DURATION_S", "30"));
    final int warmupS   = Integer.parseInt(env("WARMUP_S", "5"));
    final int producers = Integer.parseInt(env("WORKLOAD_CONCURRENCY", "32"));
    final int workers   = Integer.parseInt(env("WORKER_CONCURRENCY", "8"));

    // The entire client is configured from env vars — CAMUNDA_REST_ADDRESS,
    // CAMUNDA_GRPC_ADDRESS, CAMUNDA_PREFER_REST_OVER_GRPC, CAMUNDA_FORCE_REST,
    // CAMUNDA_FALCON, plus any C8 SDK var you need for auth. Nothing here
    // is transport-aware.
    final CamundaClient client = CamundaClient.newClientBuilder()
        .applyEnvironmentVariableOverrides(true)
        .numJobWorkerExecutionThreads(workers)
        .defaultJobWorkerMaxJobsActive(workers * 4)
        .defaultRequestTimeout(Duration.ofSeconds(30))
        .build();

    banner(producers, workers, warmupS, durationS);

    // Deploy throughput.bpmn.
    final String xml;
    try (InputStream in = ThroughputDemo.class.getResourceAsStream("/throughput.bpmn")) {
      if (in == null) throw new IllegalStateException("classpath resource /throughput.bpmn missing");
      xml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
    client.newDeployResourceCommand()
        .addResourceStringUtf8(xml, "throughput.bpmn")
        .send().join();

    // Worker: complete every job immediately.
    final JobWorker worker = client.newWorker()
        .jobType("throughput-work")
        .handler((jobClient, job) ->
            jobClient.newCompleteCommand(job.getKey()).send().join())
        .name("throughput-worker")
        .timeout(Duration.ofSeconds(30))
        .maxJobsActive(workers * 4)
        .pollInterval(Duration.ofMillis(20))
        .open();

    if (warmupS > 0) {
      System.out.println("[warmup] " + warmupS + "s at " + producers + " producers…");
      driveLoad(client, producers, Duration.ofSeconds(warmupS), null);
    }

    final Histogram latencies = new ConcurrentHistogram(TimeUnit.MINUTES.toNanos(5), 3);
    final long startNanos = System.nanoTime();
    final long completed = driveLoad(client, producers, Duration.ofSeconds(durationS), latencies);
    final double elapsedS = (System.nanoTime() - startNanos) / 1e9;

    report(completed, elapsedS, latencies);

    worker.close();
    client.close();
  }

  /**
   * Fires createInstance(withResult) continuously from `producers` threads
   * for `duration`, recording round-trip latency in `hist` (may be null in
   * warmup). Returns the number of successful completions.
   */
  private static long driveLoad(
      final CamundaClient client,
      final int producers,
      final Duration duration,
      final Histogram hist)
      throws InterruptedException {

    final AtomicBoolean running = new AtomicBoolean(true);
    final AtomicLong ok = new AtomicLong();
    final AtomicLong err = new AtomicLong();
    final ExecutorService pool = Executors.newFixedThreadPool(producers, r -> {
      final var t = new Thread(r, "producer"); t.setDaemon(true); return t;
    });
    for (int i = 0; i < producers; i++) {
      pool.submit(() -> {
        while (running.get()) {
          final long t0 = System.nanoTime();
          try {
            client.newCreateInstanceCommand()
                .bpmnProcessId("throughput").latestVersion()
                .withResult()
                .requestTimeout(Duration.ofSeconds(30))
                .send().join();
            final long ns = System.nanoTime() - t0;
            if (hist != null) hist.recordValue(Math.min(ns, hist.getHighestTrackableValue()));
            ok.incrementAndGet();
          } catch (final Exception e) {
            if (err.incrementAndGet() < 5) {
              System.err.println("[producer] " + e.getMessage());
            }
          }
        }
      });
    }
    Thread.sleep(duration.toMillis());
    running.set(false);
    pool.shutdown();
    if (!pool.awaitTermination(30, TimeUnit.SECONDS)) pool.shutdownNow();
    if (err.get() > 0) System.err.println("[warn] " + err.get() + " producer errors during window");
    return ok.get();
  }

  private static void banner(
      final int producers, final int workers, final int warmupS, final int durationS) {
    System.out.println("═══════════════════════════════════════════════════════════════");
    System.out.println(" Nano IDE throughput demo — same code, any Camunda-compatible cluster");
    System.out.println("───────────────────────────────────────────────────────────────");
    System.out.println(" producer threads   = " + producers);
    System.out.println(" worker concurrency = " + workers);
    System.out.println(" warmup / duration  = " + warmupS + "s / " + durationS + "s");
    System.out.println(" address (REST)     = " + orDash(env("CAMUNDA_REST_ADDRESS", null)));
    System.out.println(" address (gRPC)     = " + orDash(env("CAMUNDA_GRPC_ADDRESS", null)));
    System.out.println(" prefer REST        = " + orDash(env("CAMUNDA_PREFER_REST_OVER_GRPC", null)));
    System.out.println(" CAMUNDA_FORCE_REST = " + orDash(env("CAMUNDA_FORCE_REST", null)));
    System.out.println(" CAMUNDA_FALCON     = " + orDash(env("CAMUNDA_FALCON", null)));
    System.out.println(" client artifact    = " + clientCoordinate());
    System.out.println("═══════════════════════════════════════════════════════════════");
  }

  private static void report(final long completed, final double elapsedS, final Histogram latencies) {
    System.out.println();
    System.out.println("═══════════════════════════════════════════════════════════════");
    System.out.println(" RESULTS");
    System.out.println("───────────────────────────────────────────────────────────────");
    System.out.printf(Locale.ROOT, " client artifact             %s%n", clientCoordinate());
    System.out.printf(Locale.ROOT, " total instances completed   %,d in %.2fs%n", completed, elapsedS);
    System.out.printf(Locale.ROOT, " throughput                  %.1f PIs/s%n", completed / elapsedS);
    System.out.println(" latency (start-to-completion, ms):");
    System.out.printf(Locale.ROOT, "   p50   %8.2f%n", latencies.getValueAtPercentile(50)  / 1e6);
    System.out.printf(Locale.ROOT, "   p95   %8.2f%n", latencies.getValueAtPercentile(95)  / 1e6);
    System.out.printf(Locale.ROOT, "   p99   %8.2f%n", latencies.getValueAtPercentile(99)  / 1e6);
    System.out.printf(Locale.ROOT, "   p99.9 %8.2f%n", latencies.getValueAtPercentile(99.9)/ 1e6);
    System.out.printf(Locale.ROOT, "   max   %8.2f%n", latencies.getMaxValue()             / 1e6);
    System.out.println("═══════════════════════════════════════════════════════════════");
  }

  /**
   * Which SDK artifact this JAR was compiled against — inferred from the
   * CamundaClient jar's filename. Included in the report so the "transport
   * = dependency change only" story is verifiable at runtime.
   */
  private static String clientCoordinate() {
    final var loc = CamundaClient.class.getProtectionDomain().getCodeSource().getLocation().toString();
    final int slash = loc.lastIndexOf('/');
    final String jar = slash >= 0 ? loc.substring(slash + 1) : loc;
    return jar.contains("falcon")
        ? "io.github.jwulf:camunda-client-java-falcon (" + jar + ") — Falcon auto-detected"
        : "io.camunda:camunda-client-java (" + jar + ") — REST/gRPC only";
  }

  private static String env(final String name, final String defaultValue) {
    final String v = System.getenv(name);
    return (v == null || v.isBlank()) ? defaultValue : v;
  }

  private static String orDash(final String s) { return s == null ? "(unset)" : s; }
}
