/*
 * Smoke test: exercise the KycMicroservice inner-flow logic without a live
 * gateway. Verifies that (a) the packaged kyc.bpmn deploys, (b) the inner
 * flow drives to completion, (c) the aggregation produces the expected
 * decision for representative customer IDs.
 */
package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.jwulf.nano.bernd.EmbeddedEngine;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class KycInnerFlowTest {

  @Test
  void inner_flow_approves_a_low_risk_customer() throws Exception {
    try (EmbeddedEngine engine = EmbeddedEngine.create()) {
      engine.deploy(loadBpmn());
      final String instanceKey = engine.createInstance("kyc");
      assertTrue(!"0".equals(instanceKey), "engine rejected inner instance");

      final KycMicroservice.KycContext ctx = new KycMicroservice.KycContext("customer-42");
      invokeDriveInnerFlow(engine, ctx);
      assertEquals("approved", ctx.aggregate());
      assertTrue(engine.isCompleted(instanceKey), "inner instance should complete");
    }
  }

  @Test
  void inner_flow_flags_vip_for_manual_review() throws Exception {
    try (EmbeddedEngine engine = EmbeddedEngine.create()) {
      engine.deploy(loadBpmn());
      engine.createInstance("kyc");
      final KycMicroservice.KycContext ctx = new KycMicroservice.KycContext("vip-alice");
      invokeDriveInnerFlow(engine, ctx);
      assertEquals("manual_review", ctx.aggregate());
    }
  }

  private static String loadBpmn() throws Exception {
    try (InputStream in = KycInnerFlowTest.class.getResourceAsStream("/kyc/kyc.bpmn")) {
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  private static void invokeDriveInnerFlow(
      final EmbeddedEngine engine, final KycMicroservice.KycContext ctx) throws Exception {
    final Method m =
        KycMicroservice.class.getDeclaredMethod(
            "driveInnerFlow", EmbeddedEngine.class, KycMicroservice.KycContext.class);
    m.setAccessible(true);
    m.invoke(null, engine, ctx);
  }
}
