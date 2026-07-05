/*
 * Smoke test for InnerKycService — exercises the inner flow without a live
 * outer gateway. Verifies that (a) InnerKycService.boot() packages and
 * deploys kyc.bpmn, (b) verify() drives the inner flow to completion, and
 * (c) the aggregated decision matches the expected value for representative
 * customer IDs.
 *
 * With the split into OuterKycService / InnerKycService there's no more
 * reflection into a private helper — the service exposes verify() as its
 * public seam and this test consumes it exactly like OuterKycService does.
 */
package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class KycInnerFlowTest {

  @Test
  void inner_flow_approves_a_low_risk_customer() throws Exception {
    try (InnerKycService inner = InnerKycService.boot()) {
      assertEquals("approved", inner.verify("customer-42"));
    }
  }

  @Test
  void inner_flow_flags_vip_for_manual_review() throws Exception {
    try (InnerKycService inner = InnerKycService.boot()) {
      assertEquals("manual_review", inner.verify("vip-alice"));
    }
  }
}

