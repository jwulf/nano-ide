/*
 * Outer KYC service — wires the outer engine's `verify_kyc` job type to the
 * InnerKycService over stock Camunda REST.
 *
 * Bounded context: onboarding owns the outer engine (the deployed
 * onboarding.bpmn; this is the service task that satisfies it). This class
 * knows nothing about how the KYC decision is produced — it just delegates
 * to InnerKycService.verify(customerId) and completes the outer job with the
 * returned decision.
 *
 * The outer engine can be Camunda 8, Camunda Self-Managed, or a Nano
 * gateway — we only speak stock Camunda REST here. If InnerKycService moved
 * out to its own JVM/process, the only thing that changes here is the field
 * type + how it's injected — the verify call site stays intact.
 *
 * Concurrency: maxJobsActive=1 (serial). The InnerKycService's embedded
 * engine is driver-bound; handling multiple concurrent outer verify_kyc
 * activations would let inner activateJobs polls race across KycContexts.
 * Scale horizontally with more microservice instances.
 */
package com.example;

import io.camunda.client.CamundaClient;
import io.camunda.client.api.response.ActivatedJob;
import io.camunda.client.api.worker.JobWorker;
import java.net.URI;
import java.time.Duration;
import java.util.Map;

public final class OuterKycService implements AutoCloseable {

  private static final String OUTER_JOB_TYPE = "verify_kyc";
  private static final String OUTER_WORKER = "kyc-microservice";
  private static final Duration JOB_LEASE = Duration.ofSeconds(30);
  private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

  private final CamundaClient client;
  private final InnerKycService inner;
  private JobWorker worker;

  private OuterKycService(final CamundaClient client, final InnerKycService inner) {
    this.client = client;
    this.inner = inner;
  }

  /**
   * Open a stock Camunda REST connection to the outer engine and subscribe
   * to verify_kyc. Delegates every activation to {@code inner}.
   */
  public static OuterKycService boot(final URI restAddress, final InnerKycService inner) {
    final CamundaClient client = CamundaClient.newClientBuilder()
        .restAddress(restAddress)
        .preferRestOverGrpc(true)
        .defaultRequestTimeout(REQUEST_TIMEOUT)
        .build();
    System.out.println("[outer] connected to onboarding engine at " + restAddress);

    final OuterKycService service = new OuterKycService(client, inner);
    service.worker = client.newWorker()
        .jobType(OUTER_JOB_TYPE)
        .handler((jobClient, job) -> service.handleVerifyKyc(job))
        .name(OUTER_WORKER)
        .maxJobsActive(1)
        .timeout(JOB_LEASE)
        .open();
    System.out.println(
        "[outer] subscribed to " + OUTER_JOB_TYPE
        + " — start an onboarding instance");
    return service;
  }

  private void handleVerifyKyc(final ActivatedJob job) {
    final long outerJobKey = job.getKey();
    final Map<String, Object> vars = job.getVariablesAsMap();
    final String customerId = String.valueOf(vars.getOrDefault("customerId", "cust-unknown"));

    System.out.println();
    System.out.println("═══════════════════════════════════════════════════════════════");
    System.out.println(
        "[outer] " + OUTER_JOB_TYPE + " activated (jobKey=" + outerJobKey
        + ", customer=" + customerId + ")");

    final String decision;
    try {
      decision = inner.verify(customerId);
    } catch (final Exception e) {
      // Do NOT complete the outer job — let the engine's job timeout drive a retry.
      System.err.println("[inner] flow failed for customer=" + customerId + ": " + e);
      e.printStackTrace(System.err);
      System.err.println("[outer] NOT completing " + OUTER_JOB_TYPE
          + " — outer job will time out and retry");
      return;
    }

    System.out.println("[outer] completing " + OUTER_JOB_TYPE + " with decision=" + decision);
    System.out.println("═══════════════════════════════════════════════════════════════");

    try {
      client.newCompleteCommand(job)
          .variables(Map.of("decision", decision, "customerId", customerId))
          .send()
          .join();
    } catch (final Exception e) {
      System.err.println("[outer] complete failed: " + e.getMessage());
    }
  }

  @Override
  public void close() {
    if (worker != null) {
      try { worker.close(); } catch (final Exception ignored) { /* best effort */ }
    }
    try { client.close(); } catch (final Exception ignored) { /* best effort */ }
  }
}
