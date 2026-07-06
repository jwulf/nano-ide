/*
 * KYC Microservice — embedded-Nano demo (ADR 0005).
 *
 *   [ Outer BPMN engine ]                          [ This JVM process ]
 *          │                                              │
 *   models/onboarding.bpmn                        ┌─ OuterKycService ─┐
 *   (deployed to the engine)                      │ Camunda REST      │
 *          │                                      │ verify_kyc worker │
 *          │  stock Camunda REST (activateJobs)   │                   │
 *          │◄──────────────── verify_kyc ─────────┤                   │
 *          │                                      │        │          │
 *          │                                      │        ▼          │
 *          │                                      │ ┌─ InnerKycService ─┐
 *          │                                      │ │ Bernd embedded    │
 *          │                                      │ │ engine + kyc.bpmn │
 *          │                                      │ │  ↓                │
 *          │                                      │ │  check_id →       │
 *          │                                      │ │  screen_sanctions │
 *          │                                      │ │  → check_pep →    │
 *          │                                      │ │  risk_score       │
 *          │                                      │ │  ↓                │
 *          │                                      │ │ aggregate → decision
 *          │                                      │ └───────────────────┘
 *          │◄──── completeJob(decision) ──────────┤
 *
 * The outer engine can be Camunda 8, Camunda Self-Managed, or a Nano
 * gateway — we only speak stock Camunda REST on the outer path.
 *
 * Two bounded contexts, two files:
 *   - OuterKycService owns the REST job worker wire-up. Onboarding team's
 *     boundary.
 *   - InnerKycService owns the embedded engine + inner flow. Compliance
 *     team's boundary. Trivially extractable into its own process.
 *
 * This class only wires them together and keeps the JVM alive.
 */
package com.example;

import java.net.URI;
import java.util.concurrent.CountDownLatch;

public final class KycMicroservice {

  // Set CAMUNDA_REST_ADDRESS to override; defaults to the Nano IDE gateway's
  // REST endpoint. A stock Camunda 8 gateway on :8080 also works (same REST
  // API).
  private static final String DEFAULT_REST_ADDRESS = "http://localhost:8080";

  public static void main(final String[] args) throws Exception {
    final URI restAddress = URI.create(
        System.getenv().getOrDefault("CAMUNDA_REST_ADDRESS", DEFAULT_REST_ADDRESS));

    final InnerKycService inner = InnerKycService.boot();
    final OuterKycService outer = OuterKycService.boot(restAddress, inner);

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      outer.close();
      inner.close();
    }));

    new CountDownLatch(1).await();
  }

  private KycMicroservice() {}
}

