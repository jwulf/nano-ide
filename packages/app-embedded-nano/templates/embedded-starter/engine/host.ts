// EmbeddedHost (ADR 0005, realization (a) "in-process direct"). Wraps μ-nano.wasm
// (engine-core compiled to wasm) and implements the EmbeddedHost contract the
// nano-sdk-js embedded transport binds to. engine-core stays clock-free; this host
// injects Date.now() via tickNow so the engine runs as a real, wall-clock runtime.
import { TestEngine } from "./unano.js";

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

  /** Boot the wasm engine. The deno-target unano.js instantiates μ-nano.wasm at
   *  import time (top-level await), so there is nothing else to load. */
  static async create(): Promise<EmbeddedHost> {
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
