// C# throughput demo — SDK-driven producer + JobWorker.
//
// Uses the official Camunda.Orchestration.Sdk, which auto-detects nanobpmn
// gateways (via GET /v2/topology) and transparently upgrades:
//   * CreateProcessInstanceAsync -> credit-metered command-stream producer,
//   * JobWorker                  -> streaming push subscription.
// Against stock Camunda the same code runs on plain REST.
//
// Deploys resources/processes/throughput.bpmn, then floods AwaitCompletion=false
// creates from PROD_CONNS concurrent tasks while a JobWorker drains them. A live
// per-second line streams creates/s and completes/s.
//
// Run:  dotnet run -c Release
// Env:  CAMUNDA_REST_ADDRESS (default http://localhost:8080),
//       CAMUNDA_AUTH_STRATEGY (default NONE),
//       PID (default throughput-demo), JOB_TYPE (default demo-job),
//       PROD_CONNS (default 64), WORKER_CONCURRENCY (default 100),
//       DURATION_SECS (default 15).

using System.Diagnostics;
using Camunda.Orchestration.Sdk;

static int EnvInt(string name, int fallback) =>
    int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

var rest = Environment.GetEnvironmentVariable("CAMUNDA_REST_ADDRESS") ?? "http://localhost:8080";
var pid = Environment.GetEnvironmentVariable("PID") ?? "throughput-demo";
var jobType = Environment.GetEnvironmentVariable("JOB_TYPE") ?? "demo-job";
var prodConns = EnvInt("PROD_CONNS", 64);
var workerConcurrency = EnvInt("WORKER_CONCURRENCY", 100);
var durationSecs = EnvInt("DURATION_SECS", 15);

using var client = CamundaClient.Create(new CamundaOptions
{
    Env = new Dictionary<string, string?>
    {
        ["CAMUNDA_REST_ADDRESS"] = rest,
        ["CAMUNDA_AUTH_STRATEGY"] = Environment.GetEnvironmentVariable("CAMUNDA_AUTH_STRATEGY") ?? "NONE",
    },
});

// Resolve the BPMN from the project dir (dotnet run) or the output dir.
var bpmn = new[]
{
    Path.Combine(Directory.GetCurrentDirectory(), "resources", "processes", "throughput.bpmn"),
    Path.Combine(AppContext.BaseDirectory, "resources", "processes", "throughput.bpmn"),
}.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("throughput.bpmn not found (expected resources/processes/throughput.bpmn).");

Console.WriteLine($"deploying {Path.GetFileName(bpmn)} -> {rest}");
var deployment = await client.DeployResourcesFromFilesAsync(new[] { bpmn });
Console.WriteLine(
    $"deployed (key {deployment.DeploymentKey}) process '{pid}' (job type '{jobType}')");
Console.WriteLine(
    $"running {durationSecs}s with {prodConns} producer tasks + JobWorker " +
    $"(max {workerConcurrency} concurrent)...");

long created = 0, failed = 0, done = 0;

// Job worker: SDK auto-uses command-stream push against nano gateways.
client.CreateJobWorker(
    new JobWorkerConfig
    {
        JobType = jobType,
        JobTimeoutMs = 60_000,
        MaxConcurrentJobs = workerConcurrency,
        WorkerName = "csharp-throughput-worker",
    },
    (job, ct) =>
    {
        Interlocked.Increment(ref done);
        return Task.CompletedTask;
    });

using var cts = new CancellationTokenSource();
var workers = client.RunWorkersAsync(ct: cts.Token);

var instruction = new ProcessInstanceCreationInstructionById
{
    ProcessDefinitionId = ProcessDefinitionId.AssumeExists(pid),
    AwaitCompletion = false,
};

var producers = Enumerable.Range(0, prodConns).Select(_ => Task.Run(async () =>
{
    while (!cts.IsCancellationRequested)
    {
        try
        {
            await client.CreateProcessInstanceAsync(instruction, cts.Token);
            Interlocked.Increment(ref created);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch
        {
            Interlocked.Increment(ref failed);
        }
    }
})).ToArray();

var reporter = Task.Run(async () =>
{
    long prevC = 0, prevD = 0;
    var sw = Stopwatch.StartNew();
    while (!cts.IsCancellationRequested)
    {
        try
        {
            await Task.Delay(1000, cts.Token);
        }
        catch (OperationCanceledException)
        {
            break;
        }

        var c = Interlocked.Read(ref created);
        var d = Interlocked.Read(ref done);
        var f = Interlocked.Read(ref failed);
        Console.WriteLine(
            $"[{sw.Elapsed.TotalSeconds:F0}s] created={c} (+{c - prevC}/s) " +
            $"done={d} (+{d - prevD}/s) failed={f}");
        prevC = c;
        prevD = d;
    }
});

await Task.Delay(TimeSpan.FromSeconds(durationSecs));
cts.Cancel();
await Task.WhenAll(producers);
try
{
    await workers;
}
catch (OperationCanceledException)
{
}

Console.WriteLine($"done: created={created} completed={done} failed={failed}");
