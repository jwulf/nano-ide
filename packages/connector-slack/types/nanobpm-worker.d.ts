// Ambient declaration of `@nanobpm/worker` — the job-worker SDK the Urban App
// runtime provides to a pack worker at runtime via an import map (it is not a
// published npm package; the App scaffolds `.nanobpm/worker-sdk.ts` and aliases
// `@nanobpm/worker` to it). This file is the pack's *compile-time contract* for
// that host-provided module — the minimal surface `worker.ts` uses — so the
// pack typechecks standalone. Keep it minimal; the authoritative implementation
// lives in the runtime (nanobpmn clients/node-stream .nanobpm/worker-sdk.ts).

declare module "@nanobpm/worker" {
  /** One activated job handed to a worker's `handle`. */
  export interface WorkerJob {
    readonly jobKey: string;
    readonly type: string;
    readonly processInstanceKey: string;
    readonly elementId?: string;
    /** The job's variables (the element template's `zeebe:input` fields). */
    readonly variables: Record<string, unknown>;
    /** Complete the job explicitly (else return output vars from `handle`). */
    complete(variables?: Record<string, unknown>): Promise<void>;
    /** Fail the job (retryable). */
    fail(message: string, retries?: number): Promise<void>;
    /** Raise a BPMN error (caught by an error boundary event). */
    error(code: string, message?: string): Promise<void>;
  }

  export interface WorkerOptions {
    /** BPMN job type this worker serves. */
    type: string;
    /** Max concurrent in-flight jobs. Defaults to 10. */
    maxParallelJobs?: number;
    /** Job activation timeout in ms. */
    timeoutMs?: number;
    /** Gateway base URL. Defaults to env NANOBPMN_BASE_URL. */
    baseUrl?: string;
    /** Worker name recorded on activation. Defaults to env NANOBPMN_WORKER_NAME. */
    worker?: string;
    /** Return output variables (job completed with them), or call a job method,
     * or throw (job fails). */
    handle(job: WorkerJob): Promise<Record<string, unknown> | void>;
  }

  /** Register a long-lived job worker that streams and handles jobs of
   * `opts.type` until the process is stopped. */
  export function defineWorker(opts: WorkerOptions): void;
}
