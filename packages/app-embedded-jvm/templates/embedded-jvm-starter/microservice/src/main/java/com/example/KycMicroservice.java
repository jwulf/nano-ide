/*
 * KYC Microservice — embedded-Nano demo (ADR 0005).
 *
 *   [ Nano IDE gateway ]                         [ This JVM process ]
 *          │                                             │
 *   models/onboarding.bpmn                        microservice/
 *   (auto-deployed by IDE)                        └─ src/main/resources/kyc/kyc.bpmn
 *          │                                             │
 *          │  Falcon WebSocket (NanoTransport.falcon)    │
 *          │◄──────────────── verify_kyc ────────────────┤
 *          │                                             │
 *          │                                     ┌───────┴───────┐
 *          │                            starts inner instance
 *          │                            on in-process Bernd engine
 *          │                            (NanoTransport.embedded)
 *          │                            │
 *          │              check_id → screen_sanctions → check_pep → risk_score
 *          │                            │
 *          │              aggregates result to a KYC decision
 *          │                                     │
 *          │◄──── completeJob(decision) ────────┘
 *
 * Both engines are BPMN. Both are auditable. Onboarding team owns the
 * outer file; compliance owns kyc.bpmn.
 */
package com.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.nanobpm.camunda.falcon.FalconTransport;
import com.nanobpm.camunda.transport.NanoTransport;
import io.github.jwulf.nano.bernd.EmbeddedEngine;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class KycMicroservice {

  private static final String KYC_BPMN_RESOURCE = "/kyc/kyc.bpmn";

  // Set FALCON_URL to override; defaults to the Nano IDE gateway's Falcon endpoint.
  private static final String DEFAULT_FALCON_URL = "ws://localhost:8080/falcon";

  public static void main(final String[] args) throws Exception {
    final URI falconUrl = URI.create(
        System.getenv().getOrDefault("FALCON_URL", DEFAULT_FALCON_URL));

    // 1. Boot the in-process Bernd engine and deploy the inner KYC flow.
    final EmbeddedEngine kycEngine = EmbeddedEngine.create();
    final String kycBpmn = loadResource(KYC_BPMN_RESOURCE);
    kycEngine.deploy(kycBpmn);
    System.out.println("[boot] Bernd engine up; kyc.bpmn deployed (engine v"
        + kycEngine.manifest().engineVersion() + ", ABI v" + kycEngine.manifest().abiVersion() + ")");

    // 2. Open the Falcon transport to the outer gateway.
    final NanoTransport outer = NanoTransport.falcon(falconUrl);
    outer.connect().get(5, TimeUnit.SECONDS);
    System.out.println("[boot] connected to outer gateway at " + falconUrl);

    // 3. Subscribe to the outer 'verify_kyc' job. Each activation runs the
    //    inner kyc.bpmn to completion on the embedded engine, then acks the
    //    outer job with a { decision: approved|manual_review|rejected }
    //    variable so the outer gateway routes correctly.
    outer.subscribe(new FalconTransport.Subscription(
        "verify_kyc", "kyc-microservice", 8, 30_000L, null,
        (JsonNode job) -> handleVerifyKyc(job, kycEngine, outer))
    ).get(5, TimeUnit.SECONDS);
    System.out.println("[ready] subscribed to verify_kyc — start an onboarding instance in the IDE");

    // Keep alive.
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      try { outer.close(); } catch (final Exception ignored) { /* best effort */ }
      try { kycEngine.close(); } catch (final Exception ignored) { /* best effort */ }
    }));
    new CountDownLatch(1).await();
  }

  private static void handleVerifyKyc(
      final JsonNode job, final EmbeddedEngine kycEngine, final NanoTransport outer) {
    final String outerJobKey = job.get("jobKey").asText();
    final JsonNode vars = job.path("variables");
    final String customerId = vars.path("customerId").asText("cust-unknown");

    System.out.println();
    System.out.println("═══════════════════════════════════════════════════════════════");
    System.out.println("[outer] verify_kyc activated (jobKey=" + outerJobKey + ", customer=" + customerId + ")");
    System.out.println("[inner] starting kyc.bpmn instance for " + customerId);

    // Run the inner flow on Bernd. Aggregate check results in the context.
    final KycContext ctx = new KycContext(customerId);
    final String innerInstance = kycEngine.createInstance("kyc");
    System.out.println("[inner] instance " + innerInstance + " running");

    driveInnerFlow(kycEngine, ctx);

    // Aggregate into a decision the outer flow can branch on.
    final String decision = ctx.aggregate();
    System.out.println("[inner] kyc.bpmn done — decision: " + decision);
    System.out.println("[outer] completing verify_kyc with decision=" + decision);
    System.out.println("═══════════════════════════════════════════════════════════════");

    try {
      // ABI v2 embedded engine ignores completeJob variables; but the OUTER
      // gateway is the full Nano engine and does accept them, so the
      // exclusive gateway in onboarding.bpmn can branch on `decision`.
      outer.completeJob(outerJobKey, Map.of("decision", decision, "customerId", customerId))
          .get(5, TimeUnit.SECONDS);
    } catch (final Exception e) {
      System.err.println("[outer] complete failed: " + e.getMessage());
    }
  }

  /**
   * Drive the inner flow by polling activateJobs on the embedded engine for
   * each step type in order. Each step is a Java lambda that mutates the
   * context and prints a console line — like a Camunda job worker, but
   * in-process. Once the last step's job completes and the inner instance
   * reaches its end event, this method returns.
   */
  private static void driveInnerFlow(final EmbeddedEngine engine, final KycContext ctx) {
    step(engine, ctx, "check_id", (c) -> {
      c.idValid = true;   // real impl would OCR + verify against issuing authority
      System.out.println("  [inner:check_id] ID document verified ✓");
    });
    step(engine, ctx, "screen_sanctions", (c) -> {
      c.sanctionsHit = false;
      System.out.println("  [inner:screen_sanctions] OFAC + UN lists clear ✓");
    });
    step(engine, ctx, "check_pep", (c) -> {
      c.pepMatch = c.customerId.startsWith("vip-");   // demo: 'vip-*' triggers PEP path
      System.out.println("  [inner:check_pep] PEP list " + (c.pepMatch ? "MATCH ⚠" : "clear ✓"));
    });
    step(engine, ctx, "risk_score", (c) -> {
      // Demo heuristic. Real world: a rules engine or ML model.
      c.riskScore = c.pepMatch ? 75 : (c.sanctionsHit ? 100 : 15);
      System.out.println("  [inner:risk_score] score = " + c.riskScore);
    });
  }

  /** Poll activateJobs for one job of the given type, run the lambda, complete. */
  private static void step(
      final EmbeddedEngine engine, final KycContext ctx, final String type,
      final java.util.function.Consumer<KycContext> handler) {
    final long deadline = System.currentTimeMillis() + 5_000L;
    while (System.currentTimeMillis() < deadline) {
      final var jobs = engine.activateJobs(type, "kyc-inner", 1, 30_000L);
      if (!jobs.isEmpty()) {
        final var job = jobs.get(0);
        handler.accept(ctx);
        engine.completeJob(job.key());
        return;
      }
      try { Thread.sleep(10); } catch (final InterruptedException ie) { Thread.currentThread().interrupt(); return; }
    }
    throw new IllegalStateException("inner flow stalled: no " + type + " job appeared within 5s");
  }

  private static String loadResource(final String path) throws Exception {
    try (InputStream in = KycMicroservice.class.getResourceAsStream(path)) {
      if (in == null) throw new IllegalStateException("missing resource: " + path);
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  /** Per-customer aggregation of the inner check results. */
  static final class KycContext {
    final String customerId;
    boolean idValid;
    boolean sanctionsHit;
    boolean pepMatch;
    int riskScore;

    KycContext(final String customerId) { this.customerId = customerId; }

    String aggregate() {
      if (!idValid || sanctionsHit) return "rejected";
      if (pepMatch || riskScore >= 70) return "manual_review";
      return "approved";
    }
  }

  private KycMicroservice() {}
}
