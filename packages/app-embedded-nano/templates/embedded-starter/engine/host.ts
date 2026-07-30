// EmbeddedHost (ADR 0005, realization (a) "in-process direct"). Wraps the
// engine-core WebAssembly build published as @nanobpm/engine-wasm and implements
// the EmbeddedHost contract the nano-sdk-js embedded transport binds to.
// engine-core stays clock-free; this host injects Date.now() via tickNow so the
// engine runs as a real, wall-clock runtime.
//
// The wasm bytes are imported (type: "bytes") rather than fetched so that
// `deno compile` embeds the engine into the self-contained binary, and initSync
// boots it with no network/file access at runtime.
import { initSync, TestEngine } from "@nanobpm/engine-wasm";
import wasmBytes from "@nanobpm/engine-wasm/nanobpmn_engine_bg.wasm" with { type: "bytes" };

let booted = false;

export interface EmbeddedJob {
  jobKey: string;
  type: string;
  processInstanceKey: string;
  elementId: string;
  retries: number;
  variables: Record<string, unknown>;
}

export class EmbeddedHost {
  private engine: TestEngine;
  private constructor(engine: TestEngine) {
    this.engine = engine;
  }

  /** Boot the wasm engine from the embedded bytes (idempotent). */
  static async create(): Promise<EmbeddedHost> {
    if (!booted) {
      initSync({ module: wasmBytes });
      booted = true;
    }
    return new EmbeddedHost(new TestEngine());
  }

  async deploy(xml: string): Promise<{ processIds: string[] }> {
    const r = JSON.parse(this.engine.deploy(xml));
    return { processIds: r.processIds ?? [] };
  }

  async createInstance(input: { processDefinitionId?: string; variables?: Record<string, unknown> }): Promise<{ processInstanceKey: string }> {
    const snap = JSON.parse(this.engine.createInstance(input.processDefinitionId ?? "", JSON.stringify(input.variables ?? {})));
    return { processInstanceKey: String(snap.created) };
  }

  async activateJobs(type: string, max: number, timeoutMs: number, worker: string): Promise<EmbeddedJob[]> {
    const jobs = JSON.parse(this.engine.activateJobs(type, max, timeoutMs, worker)) as any[];
    return jobs.map((j) => ({
      jobKey: String(j.key),
      type: j.type,
      processInstanceKey: String(j.instanceKey ?? ""),
      elementId: j.elementId ?? "",
      retries: j.retries ?? 3,
      variables: j.variables ?? {},
    }));
  }

  async completeJob(jobKey: string, variables?: Record<string, unknown>): Promise<void> {
    this.engine.completeJob(jobKey, JSON.stringify(variables ?? {}));
  }

  async failJob(jobKey: string, retries: number, errorMessage?: string): Promise<void> {
    this.engine.failJob(jobKey, retries, errorMessage ?? "");
  }

  instanceCompleted(key: string): boolean {
    const snap = JSON.parse(this.engine.snapshot());
    const inst = (snap.instances ?? []).find((i: any) => String(i.key) === key);
    return !inst || inst.completed === true;
  }

  instanceVariables(key: string): Record<string, unknown> {
    const snap = JSON.parse(this.engine.snapshot());
    const inst = (snap.instances ?? []).find((i: any) => String(i.key) === key);
    return inst?.variables ?? {};
  }

  tick(): void {
    this.engine.tickNow(Date.now());
  }
}
