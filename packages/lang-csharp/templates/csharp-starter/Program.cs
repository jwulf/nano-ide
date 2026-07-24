// Starter (C#) — a complete, runnable Camunda 8 app.
//
// A minimal end-to-end loop on the official Camunda.Orchestration.Sdk:
//
//   1. connect + print the gateway topology,
//   2. deploy resources/processes/starter.bpmn,
//   3. register a job worker for the `hello` service task,
//   4. create one process instance,
//   5. the worker completes the job by echoing its variables.
//
// The worker stays open after the demo instance completes, so you can create
// more instances from the console (or re-run) and watch them flow. Ctrl-C stops.
//
// Run in the Nano IDE:  press ▶ Run in the project toolbar.
// Run from a terminal:  dotnet run -c Release
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

const string pid = "starter-process";
const string jobType = "hello";

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

// Resolve the BPMN from the project dir (dotnet run) or the output dir.
var bpmn = new[]
{
    Path.Combine(Directory.GetCurrentDirectory(), "resources", "processes", "starter.bpmn"),
    Path.Combine(AppContext.BaseDirectory, "resources", "processes", "starter.bpmn"),
}.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("starter.bpmn not found (expected resources/processes/starter.bpmn).");

Console.WriteLine($"deploying {Path.GetFileName(bpmn)}");
var deployment = await client.DeployResourcesFromFilesAsync(new[] { bpmn });
Console.WriteLine($"deployed (key {deployment.DeploymentKey}) process '{pid}'");

// Worker for the `hello` service task: echo the instance variables and complete
// the job (returning the variables auto-completes it with them as output).
client.CreateJobWorker(
    new JobWorkerConfig
    {
        JobType = jobType,
        JobTimeoutMs = 60_000,
        WorkerName = "csharp-starter",
    },
    (job, ct) =>
    {
        var variables = job.GetVariables<Dictionary<string, object>>() ?? new();
        Console.WriteLine(
            $"worker handled job {job.JobKey} ({job.Type}) variables={JsonSerializer.Serialize(variables)}");
        variables["handledBy"] = "csharp-starter";
        return Task.FromResult<object?>(variables);
    });

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

var workers = client.RunWorkersAsync(ct: cts.Token);

try
{
    // Create one instance to exercise the full loop end to end.
    var instance = await client.CreateProcessInstanceAsync(
        new ProcessInstanceCreationInstructionById
        {
            ProcessDefinitionId = ProcessDefinitionId.AssumeExists(pid),
            Variables = new Dictionary<string, object> { ["greeting"] = "hello from csharp-starter" },
            AwaitCompletion = false,
        },
        cts.Token);
    Console.WriteLine($"created process instance {instance.ProcessInstanceKey}");

    Console.WriteLine("worker `hello` open. Ctrl-C to stop.");
    await workers;
}
catch (OperationCanceledException)
{
}
finally
{
    // Don't leave the worker task unobserved if instance creation raised —
    // cancel and await it so the app shuts down cleanly.
    cts.Cancel();
    try { await workers; } catch (OperationCanceledException) { }
}
