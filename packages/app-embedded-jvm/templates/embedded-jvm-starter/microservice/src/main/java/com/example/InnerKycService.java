/*
 * Inner KYC service — a self-contained BPMN workflow running on an in-process
 * Bernd embedded engine, packaged inside this microservice.
 *
 * Bounded context: compliance owns the kyc.bpmn model and the four checks
 * (check_id, screen_sanctions, check_pep, risk_score). This class is the only
 * seam the outer service should touch — hand it a customer id, get back a
 * decision. Everything about the embedded engine (deploy on boot, driving
 * jobs, aggregating results) stays behind this facade.
 *
 * If this ever moves out into its own JVM process, the swap is small: keep
 * `verify(customerId)`, replace the in-JVM call site with an HTTP/gRPC/Falcon
 * hop. The signature is deliberately synchronous + string-returning so that
 * remote-swap is mechanical.
 *
 * Concurrency: NOT thread-safe. The embedded engine + per-invocation
 * KycContext + activateJobs polling make each `verify` call driver-bound to
 * one thread. The outer service is configured with maxJobs=1 to match; scale
 * horizontally with more microservice instances rather than in-JVM threads.
 */
package com.example;

import io.github.jwulf.nano.bernd.EmbeddedEngine;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

public final class InnerKycService implements AutoCloseable {

  private static final String KYC_BPMN_RESOURCE = "/kyc/kyc.bpmn";
  private static final String KYC_PROCESS_ID = "kyc";
  private static final String INNER_WORKER = "kyc-inner";
  private static final long JOB_LEASE_MS = 30_000L;
  private static final long STEP_TIMEOUT_MS = 5_000L;

  private final EmbeddedEngine engine;

  private InnerKycService(final EmbeddedEngine engine) {
    this.engine = engine;
  }

  /** Boot the embedded engine and deploy the packaged inner flow. */
  public static InnerKycService boot() throws Exception {
    final EmbeddedEngine engine = EmbeddedEngine.create();
    engine.deploy(loadResource(KYC_BPMN_RESOURCE));
    System.out.println("[inner] Bernd engine up; kyc.bpmn deployed (engine v"
        + engine.manifest().engineVersion() + ", ABI v" + engine.manifest().abiVersion() + ")");
    return new InnerKycService(engine);
  }

  /**
   * Run the inner kyc.bpmn flow to completion for one customer and return
   * the aggregated decision (approved | manual_review | rejected).
   *
   * Throws if the inner instance can't be created or a step doesn't produce
   * a job within STEP_TIMEOUT_MS — the outer service treats a throw as
   * "don't complete the outer job, let it time out and retry".
   */
  public String verify(final String customerId) {
    final KycContext ctx = new KycContext(customerId);
    final String innerInstance = engine.createInstance(KYC_PROCESS_ID);
    System.out.println("[inner] instance " + innerInstance + " running for " + customerId);
    driveInnerFlow(ctx);
    final String decision = ctx.aggregate();
    System.out.println("[inner] kyc.bpmn done — decision: " + decision);
    return decision;
  }

  /**
   * Poll activateJobs on the embedded engine for each step type in order.
   * Each step is a Java lambda that mutates the context and prints a console
   * line — like a Camunda job worker, but in-process. Once the last step's
   * job completes and the inner instance reaches its end event, this
   * method returns.
   */
  void driveInnerFlow(final KycContext ctx) {
    step(ctx, "check_id", (c) -> {
      c.idValid = true;   // real impl would OCR + verify against issuing authority
      System.out.println("  [inner:check_id] ID document verified ✓");
    });
    step(ctx, "screen_sanctions", (c) -> {
      c.sanctionsHit = false;
      System.out.println("  [inner:screen_sanctions] OFAC + UN lists clear ✓");
    });
    step(ctx, "check_pep", (c) -> {
      c.pepMatch = c.customerId.startsWith("vip-");   // demo: 'vip-*' triggers PEP path
      System.out.println("  [inner:check_pep] PEP list " + (c.pepMatch ? "MATCH ⚠" : "clear ✓"));
    });
    step(ctx, "risk_score", (c) -> {
      // Demo heuristic. Real world: a rules engine or ML model.
      c.riskScore = c.pepMatch ? 75 : (c.sanctionsHit ? 100 : 15);
      System.out.println("  [inner:risk_score] score = " + c.riskScore);
    });
  }

  private void step(final KycContext ctx, final String type, final Consumer<KycContext> handler) {
    final long deadline = System.currentTimeMillis() + STEP_TIMEOUT_MS;
    while (System.currentTimeMillis() < deadline) {
      final var jobs = engine.activateJobs(type, INNER_WORKER, 1, JOB_LEASE_MS);
      if (!jobs.isEmpty()) {
        final var job = jobs.get(0);
        handler.accept(ctx);
        engine.completeJob(job.key());
        return;
      }
      try {
        Thread.sleep(10);
      } catch (final InterruptedException ie) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException(
            "inner flow interrupted while waiting for " + type + " job", ie);
      }
    }
    throw new IllegalStateException("inner flow stalled: no " + type + " job appeared within "
        + STEP_TIMEOUT_MS + "ms");
  }

  @Override
  public void close() {
    try {
      engine.close();
    } catch (final Exception ignored) {
      // best effort
    }
  }

  private static String loadResource(final String path) throws Exception {
    try (InputStream in = InnerKycService.class.getResourceAsStream(path)) {
      if (in == null) throw new IllegalStateException("missing resource: " + path);
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }
}
