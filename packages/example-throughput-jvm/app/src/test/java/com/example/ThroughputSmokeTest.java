package com.example;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import org.junit.jupiter.api.Test;

/**
 * Smoke tests that don't need a live gateway — verify the resource is
 * packaged and the main class loads. Real throughput measurement needs
 * a running C8 or Nano cluster; see README.
 */
class ThroughputSmokeTest {

  @Test
  void bpmn_resource_is_packaged() throws Exception {
    try (InputStream in = ThroughputDemo.class.getResourceAsStream("/throughput.bpmn")) {
      assertNotNull(in, "classpath resource /throughput.bpmn should be packaged into the jar");
      final byte[] bytes = in.readAllBytes();
      assertTrue(bytes.length > 0, "resource should be non-empty");
      final String xml = new String(bytes);
      assertTrue(xml.contains("id=\"throughput\""), "process id should be 'throughput'");
      assertTrue(xml.contains("throughput-work"),   "task type should be 'throughput-work'");
    }
  }

  @Test
  void main_class_loads() {
    // A no-op — Class.forName will succeed if imports resolve against the
    // active SDK profile. This is the check that catches an SDK API
    // mismatch (e.g. a breaking upstream change) before you paste an
    // address.
    assertNotNull(ThroughputDemo.class);
  }
}
