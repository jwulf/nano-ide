# @nanobpm/nano-ide-lang-csharp

C# / .NET language pack for the [Nano RAD IDE](https://github.com/jwulf/nano-ide).

- **Grammar**: `.cs` → Monaco `csharp`, `.csproj` → `xml`.
- **Toolchain**: `dotnet` — `dotnet run -c Release` restores NuGet dependencies and
  runs in one step; `dotnet build -c Release` is the compile step.
- **Template** `csharp-starter`: a complete, runnable Camunda 8 app — connects,
  prints the gateway topology, deploys `resources/processes/starter.bpmn`, creates
  one process instance, and runs a job worker for the `hello` service task using the
  official [`Camunda.Orchestration.Sdk`](https://www.nuget.org/packages/Camunda.Orchestration.Sdk).

## Zero-code path to Falcon

The SDK auto-detects a Nano gateway (`GET /v2/topology`) and transparently upgrades
process-instance creation and job push to the command-stream / Falcon transport.
The same `Program.cs` runs on plain REST against stock Camunda 8 — no code change.

## Install

Installed into the Nano IDE's extension directory (see the console's Extensions
view). Requires the .NET SDK 8.0+ on `PATH`; the pack surfaces install guidance
when `dotnet` is missing.
