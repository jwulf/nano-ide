// Starter (Java) — the "hello, Camunda" the stock Java client can run today.
//
// Reads CAMUNDA_REST_ADDRESS from the environment (falls back to
// http://localhost:8080), fetches the gateway topology, then registers a job
// worker for the `hello` job type that completes each job by echoing its
// variables.
//
// Run: mvn -q -DskipTests compile exec:java
// Env: CAMUNDA_REST_ADDRESS (default http://localhost:8080).
//
// Zero-code path to Falcon: this file does not change when the Falcon-aware
// Camunda Java client is swapped in via pom.xml — job push + createInstance
// upgrade transparently against a Nano server, and stay on REST against
// stock Camunda 8.
package com.example;

import io.camunda.client.CamundaClient;
import io.camunda.client.api.response.Topology;

import java.net.URI;
import java.util.concurrent.CountDownLatch;

public final class Main {
  public static void main(String[] args) throws Exception {
    String rest = System.getenv().getOrDefault("CAMUNDA_REST_ADDRESS", "http://localhost:8080");

    // Prefer REST over gRPC so the same code path works against a Nano
    // gateway (no gRPC) and a local C8 dev server (REST on 8080). Plaintext
    // is inferred from the http:// URI scheme.
    try (CamundaClient client = CamundaClient.newClientBuilder()
        .restAddress(URI.create(rest))
        .preferRestOverGrpc(true)
        .build()) {

      Topology topology = client.newTopologyRequest().send().join();
      System.out.printf("connected to %s: gatewayVersion=%s, clusterSize=%d%n",
          rest, topology.getGatewayVersion(), topology.getClusterSize());

      // Register a worker for job type `hello`. Deploy a BPMN with a service
      // task using this job type from the console, then create an instance —
      // this worker completes each job by echoing its input variables.
      CountDownLatch shutdown = new CountDownLatch(1);
      Runtime.getRuntime().addShutdownHook(new Thread(shutdown::countDown));

      client.newWorker()
          .jobType("hello")
          .handler((ctx, job) -> {
            System.out.printf("job %d (%s) variables=%s%n",
                job.getKey(), job.getType(), job.getVariables());
            ctx.newCompleteCommand(job.getKey())
                .variables(job.getVariables())
                .send()
                .join();
          })
          .name("java-starter")
          .open();

      System.out.println("worker `hello` open. Ctrl-C to stop.");
      shutdown.await();
    }
  }
}
