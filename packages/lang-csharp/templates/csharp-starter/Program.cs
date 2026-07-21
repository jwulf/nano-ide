// Starter (C#) — the "hello, Camunda" the official SDK can run today.
//
// Reads CAMUNDA_REST_ADDRESS from the environment (falls back to
// http://localhost:8080), fetches the gateway topology, then registers a job
// worker for the `hello` job type that completes each job by echoing its
// variables.
//
// Run:  dotnet run -c Release
// Env:  CAMUNDA_REST_ADDRESS   (default http://localhost:8080)
//       CAMUNDA_AUTH_STRATEGY  (default NONE — a local Nano / C8 dev gateway
//                               runs without auth; set OAUTH or BASIC for a
//                               secured cluster and provide the CAMUNDA_* vars)
//
// Zero-code path to Falcon: the official Camunda.Orchestration.Sdk auto-detects
// a Nano gateway (GET /v2/topology) and transparently upgrades create + job push
// to the command-stream / Falcon transport. The same code runs on plain REST
// against stock Camunda 8.

using System.Text.Json;
using Camunda.Orchestration.Sdk;

var rest = Environment.GetEnvironmentVariable("CAMUNDA_REST_ADDRESS") ?? "http://localhost:8080";

using var client = CamundaClient.Create(new CamundaOptions
{
    Env = new Dictionary<string, string?>
    {
        ["CAMUNDA_REST_ADDRESS"] = rest,
        ["CAMUNDA_AUTH_STRATEGY"] = Environment.GetEnvironmentVariable("CAMUNDA_AUTH_STRATEGY") ?? "NONE",
    },
});

var topology = await client.GetTopologyAsync();
Console.WriteLine(
    $"connected to {rest}: gatewayVersion={topology.GatewayVersion}, clusterSize={topology.ClusterSize}");

// Register a worker for job type `hello`. Deploy a BPMN with a service task
// using this job type from the console, then create an instance — this worker
// completes each job by echoing its input variables.
client.CreateJobWorker(
    new JobWorkerConfig
    {
        JobType = "hello",
        JobTimeoutMs = 60_000,
        WorkerName = "csharp-starter",
    },
    async (job, ct) =>
    {
        var variables = job.GetVariables<Dictionary<string, object>>() ?? new();
        Console.WriteLine($"job {job.JobKey} ({job.Type}) variables={JsonSerializer.Serialize(variables)}");
        await Task.CompletedTask;
        // Returning the variables auto-completes the job with them as output.
        return variables;
    });

Console.WriteLine("worker `hello` open. Ctrl-C to stop.");
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};
await client.RunWorkersAsync(ct: cts.Token);
