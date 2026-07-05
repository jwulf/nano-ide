/*
 * KYC Microservice — embedded-Nano demo (ADR 0005).
 *
 *   [ Nano IDE gateway ]                         [ This JVM process ]
 *          │                                             │
 *   models/onboarding.bpmn                        ┌─ OuterKycService ─┐
 *   (deployed by IDE)                             │ Falcon WebSocket  │
 *          │                                      │ verify_kyc worker │
 *          │  Falcon WebSocket (NanoTransport.falcon)│                │
 *          │◄──────────────── verify_kyc ───────────┤                │
 *          │                                      │        │         │
 *          │                                      │        ▼         │
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
 * Two bounded contexts, two files:
 *   - OuterKycService owns the Falcon wire-up. Onboarding team's boundary.
 *   - InnerKycService owns the embedded engine + inner flow. Compliance team's
 *     boundary. Trivially extractable into its own process.
 *
 * This class only wires them together and keeps the JVM alive.
 */
package com.example;

import java.net.URI;
import java.util.concurrent.CountDownLatch;

public final class KycMicroservice {

  // Set FALCON_URL to override; defaults to the Nano IDE gateway's Falcon endpoint.
  private static final String DEFAULT_FALCON_URL = "ws://localhost:8080/falcon";

  public static void main(final String[] args) throws Exception {
    final URI falconUrl = URI.create(
        System.getenv().getOrDefault("FALCON_URL", DEFAULT_FALCON_URL));

    final InnerKycService inner = InnerKycService.boot();
    final OuterKycService outer = OuterKycService.boot(falconUrl, inner);

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      outer.close();
      inner.close();
    }));

    new CountDownLatch(1).await();
  }

  private KycMicroservice() {}
}

