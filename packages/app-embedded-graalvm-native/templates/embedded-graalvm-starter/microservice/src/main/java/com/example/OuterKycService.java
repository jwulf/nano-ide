/*
 * Outer KYC service — wires the onboarding gateway's `verify_kyc` job type to
 * the InnerKycService over Falcon.
 *
 * Bounded context: onboarding owns the outer gateway (the deployed
 * onboarding.bpmn, this is the service task that satisfies it). This class
 * knows nothing about how the KYC decision is produced — it just delegates
 * to InnerKycService.verify(customerId) and completes the outer job with the
 * returned decision.
 *
 * If InnerKycService moved out to its own JVM/process, the only thing that
 * changes here is the field type + how it's injected — the verify call site
 * stays intact.
 *
 * Concurrency: maxJobs=1 (serial). The InnerKycService's embedded engine is
 * driver-bound; handling multiple concurrent outer verify_kyc activations
 * would let inner activateJobs polls race across KycContexts. Scale
 * horizontally with more microservice instances.
 */
package com.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.nanobpm.camunda.falcon.FalconTransport;
import com.nanobpm.camunda.transport.NanoTransport;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public final class OuterKycService implements AutoCloseable {

  private static final String OUTER_JOB_TYPE = "verify_kyc";
  private static final String OUTER_WORKER = "kyc-microservice";
  private static final long JOB_LEASE_MS = 30_000L;
  private static final long CALL_TIMEOUT_SECONDS = 5L;

  private final NanoTransport transport;
  private final InnerKycService inner;

  private OuterKycService(final NanoTransport transport, final InnerKycService inner) {
    this.transport = transport;
    this.inner = inner;
  }

  /**
   * Open a Falcon connection to the onboarding gateway and subscribe to
   * verify_kyc. Delegates every activation to {@code inner}.
   */
  public static OuterKycService boot(final URI falconUrl, final InnerKycService inner)
      throws Exception {
    final NanoTransport transport = NanoTransport.falcon(falconUrl);
    transport.connect().get(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    System.out.println("[outer] connected to onboarding gateway at " + falconUrl);

    final OuterKycService service = new OuterKycService(transport, inner);
    transport.subscribe(new FalconTransport.Subscription(
        OUTER_JOB_TYPE, OUTER_WORKER, 1, JOB_LEASE_MS, null, service::handleVerifyKyc))
      .get(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    System.out.println(
        "[outer] subscribed to " + OUTER_JOB_TYPE
        + " — start an onboarding instance in the IDE");
    return service;
  }

  private void handleVerifyKyc(final JsonNode job) {
    final String outerJobKey = job.get("jobKey").asText();
    final JsonNode vars = job.path("variables");
    final String customerId = vars.path("customerId").asText("cust-unknown");

    System.out.println();
    System.out.println("═══════════════════════════════════════════════════════════════");
    System.out.println(
        "[outer] " + OUTER_JOB_TYPE + " activated (jobKey=" + outerJobKey
        + ", customer=" + customerId + ")");

    final String decision;
    try {
      decision = inner.verify(customerId);
    } catch (final Exception e) {
      // Do NOT complete the outer job — let Nano's job timeout drive a retry.
      System.err.println("[inner] flow failed for customer=" + customerId + ": " + e);
      e.printStackTrace(System.err);
      System.err.println("[outer] NOT completing " + OUTER_JOB_TYPE
          + " — outer job will time out and retry");
      return;
    }

    System.out.println("[outer] completing " + OUTER_JOB_TYPE + " with decision=" + decision);
    System.out.println("═══════════════════════════════════════════════════════════════");

    try {
      // ABI v2 embedded engine ignores completeJob variables; but the OUTER
      // gateway is the full Nano engine and does accept them, so the
      // exclusive gateway in onboarding.bpmn can branch on `decision`.
      transport
          .completeJob(outerJobKey, Map.of("decision", decision, "customerId", customerId))
          .get(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    } catch (final Exception e) {
      System.err.println("[outer] complete failed: " + e.getMessage());
    }
  }

  @Override
  public void close() {
    try {
      transport.close();
    } catch (final Exception ignored) {
      // best effort
    }
  }
}
