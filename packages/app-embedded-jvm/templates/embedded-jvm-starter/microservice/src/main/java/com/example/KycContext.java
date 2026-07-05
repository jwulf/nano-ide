/*
 * Per-customer aggregation of the inner KYC check results.
 *
 * Populated step-by-step by InnerKycService as it drives the inner kyc.bpmn
 * flow, then folded into a single decision string that the outer service
 * hands back to the onboarding gateway.
 *
 * Deliberately mutable + package-private field access — an in-process value
 * type shared by tightly-coupled classes in one bounded context (this
 * microservice). If the two services were ever pulled apart into separate
 * deployables, the wire boundary would replace this with a JSON DTO.
 */
package com.example;

public final class KycContext {
  final String customerId;
  boolean idValid;
  boolean sanctionsHit;
  boolean pepMatch;
  int riskScore;

  public KycContext(final String customerId) {
    this.customerId = customerId;
  }

  /** Fold the collected checks into an onboarding-facing decision. */
  public String aggregate() {
    if (!idValid || sanctionsHit) return "rejected";
    if (pepMatch || riskScore >= 70) return "manual_review";
    return "approved";
  }
}
