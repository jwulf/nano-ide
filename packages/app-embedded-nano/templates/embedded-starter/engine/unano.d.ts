/* tslint:disable */
/* eslint-disable */

/**
 * A simulated engine instance bound to one modeler session.
 */
export class TestEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Activate up to `max_jobs` `Created` jobs of `job_type`, locking them to
     * `worker` until `now + timeout_ms`. Returns a JSON array of activated jobs
     * (key, type, instance/element, retries, variables) for the dispatch loop to
     * hand to worker handlers. The host owns the wall clock via `tickNow`.
     */
    activateJobs(job_type: string, max_jobs: number, timeout_ms: number, worker: string): string;
    /**
     * Advance the virtual clock by `by_ms` milliseconds, firing any timers that
     * become due and expiring any lapsed job locks.
     */
    advanceTime(by_ms: number): string;
    /**
     * Complete a waiting job by key, merging `variables_json` (a JSON object
     * string) into the instance. The job is activated first if it has not been
     * already, so the UI can complete a freshly-created job directly.
     */
    completeJob(job_key: string, variables_json: string): string;
    /**
     * Start a new instance of `process_id`, seeding it with the given variables
     * (a JSON object string; pass `"{}"` or `""` for none). Returns the
     * post-run [`Snapshot`] with a top-level `created` field holding the new
     * instance key.
     */
    createInstance(process_id: string, variables_json: string): string;
    /**
     * Parse and deploy a BPMN resource. Returns a JSON object
     * `{ "processIds": [...], "snapshot": {...} }` on success, or throws a
     * JS error carrying the parse/deploy failure message.
     */
    deploy(xml: string): string;
    /**
     * The full ordered event log emitted so far, as a JSON array of
     * `{ seq, now, type, ...payload }`. Useful for a step-through / trace view.
     */
    events(): string;
    /**
     * Fail a waiting job by key with the given remaining `retries` and message.
     * With no retries left this raises an incident (visible in the snapshot).
     */
    failJob(job_key: string, retries: number, message: string): string;
    /**
     * Create a fresh, empty simulated engine. The virtual clock starts at 0.
     */
    constructor();
    /**
     * The current simulation state as a JSON [`Snapshot`].
     */
    snapshot(): string;
    /**
     * Set the engine clock to a wall-clock instant (ms), then trigger due timers
     * and expire lapsed job locks. The embedded host calls this with `Date.now()`
     * so `engine-core` stays clock-free while running as a real runtime. The
     * clock never moves backwards. Returns the snapshot.
     */
    tickNow(now_ms: number): string;
    /**
     * The current virtual clock (milliseconds).
     */
    readonly now: number;
}
