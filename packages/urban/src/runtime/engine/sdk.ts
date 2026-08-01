// The full nano-sdk engine client, surfaced to code-first Urban authors.
//
// `AppApi.engine` is the transport-agnostic seam (deploy, create, message, user
// tasks, workers). When the app runs on the nano-sdk transport, `AppApi.sdk` also
// carries the underlying `@nanobpm/nano-sdk` client, giving handlers the whole
// Camunda orchestration-cluster surface — decisions, cluster variables, incidents,
// agents, batch operations, and more — over the same connection, without a separate
// `@nanobpm/nano-sdk` dependency.
//
// This module is type-only: the `import(...)` type query resolves nano-sdk's types at
// typecheck and is fully erased at runtime, so re-exporting it from the runtime barrel
// adds no load-time dependency on nano-sdk.

/** The full nano-sdk (Camunda orchestration-cluster) engine client type — the value
 *  returned by `createCamundaClient`. */
export type EngineSdkClient = ReturnType<
  typeof import("@nanobpm/nano-sdk").createCamundaClient
>;
