/**
 * @zakkster/lite-scheduler
 * Zero-GC Frame Budget Manager with strict priority lanes.
 */

/**
 * Priority lane constants. Lower numerical values run first.
 *
 * - `Immediate` (0): Bypasses both the SLL lanes and the frame deadline.
 *   Drained in FIFO before any SLL work, even when the budget is exhausted.
 *   Use sparingly — there is no fairness guarantee with respect to the page.
 * - `UserInput` (1): Highest SLL lane. For tap/gesture handlers, focus events.
 * - `Normal` (2): Default lane.
 * - `Background` (3): Below normal. For prefetch, lazy hydration.
 * - `Idle` (4): Runs only after all higher lanes are drained for the frame.
 */
export const Priority: {
    readonly Immediate: 0;
    readonly UserInput: 1;
    readonly Normal: 2;
    readonly Background: 3;
    readonly Idle: 4;
};

export type PriorityValue =
    | typeof Priority.Immediate
    | typeof Priority.UserInput
    | typeof Priority.Normal
    | typeof Priority.Background
    | typeof Priority.Idle;

/**
 * Thrown when a `"throw"` capacity policy is configured and the relevant
 * pool (SLL or immediate ring buffer) overflows.
 */
export class CapacityError extends Error {
    readonly name: "CapacityError";
    /** "tasks" for SLL overflow, "immediate tasks" for the ring buffer. */
    readonly kind: string;
    /** The pool capacity that was exceeded. */
    readonly capacity: number;
    constructor(kind: string, capacity: number);
}

/**
 * Behaviour when a pool reaches its limit.
 * - `"throw"` (default): throw a `CapacityError`.
 * - `"grow"`: double the pool, capped at `maxTasks * 16`.
 * - `"drop"`: silently discard the task.
 */
export type CapacityPolicy = "throw" | "grow" | "drop";

export interface SchedulerConfig {
    /** Initial SLL task pool capacity. Default 2048. Must be a positive integer. */
    maxTasks?: number;
    /** How to react when a pool overflows. Default `"throw"`. */
    onCapacityExceeded?: CapacityPolicy;
    /** Per-flush frame budget in milliseconds. Default 10. Must be > 0. */
    budgetMs?: number;
    /**
     * Error sink for tasks that throw synchronously. Receives
     * `(message: string, error: Error)`. Defaults to `console.error`.
     * Async errors (rejected promises returned from a task) are not observed.
     */
    onError?: (message: string, error: unknown) => void;
}

export interface SchedulerStats {
    /** Tasks queued across all SLL lanes. */
    readonly activeSllTasks: number;
    /** Tasks queued in the immediate ring buffer. */
    readonly activeImmediateTasks: number;
    /** Current SLL pool capacity (may have grown beyond `maxTasks`). */
    readonly poolCapacity: number;
    /** Current ring-buffer capacity. */
    readonly immediateCapacity: number;
    /** Total tasks executed since this scheduler was created. */
    readonly totalExecuted: number;
}

export interface Scheduler {
    /**
     * Enqueue a function for execution on a future macrotask.
     *
     * @param fn        Task body. Synchronous exceptions are caught and routed
     *                  to `onError`. Async errors (rejected promises returned
     *                  from `fn`) are NOT observed.
     * @param priority  One of the `Priority` constants. Out-of-range values
     *                  are coerced to `Normal`. Defaults to `Priority.Normal`.
     */
    schedule(fn: () => void, priority?: number): void;

    /**
     * True when the current flush has exceeded its `budgetMs`. Call this
     * inside long-running tasks to cooperate with the scheduler.
     *
     * Note: outside an active flush, this always returns true because the
     * stored deadline is from a previous (already-completed) flush.
     */
    shouldYield(): boolean;

    /**
     * True if the scheduler has any pending work — a flush in progress,
     * queued SLL tasks, or pending immediate tasks.
     */
    isBusy(): boolean;

    /**
     * Resolves on the next scheduled tick at the given priority. Useful for
     * `await sched.yieldTask()` between segments of a long synchronous job.
     *
     * Rejects with an Error after `destroy()` has been called.
     */
    yieldTask(priority?: number): Promise<void>;

    /** Snapshot of scheduler internals. Allocates a fresh object on each call. */
    stats(): SchedulerStats;

    /**
     * Closes the MessageChannel and clears all pools. Idempotent.
     * After destroy:
     *  - `schedule()` is a no-op
     *  - `yieldTask()` rejects
     *  - `isBusy()` returns false
     */
    destroy(): void;
}

/**
 * Create an isolated scheduler instance with its own task pool and
 * MessageChannel. Always prefer creating an instance for libraries and
 * sandboxed components; only use the module-default convenience functions
 * for top-level application glue.
 *
 * @throws Error when `budgetMs <= 0`, `maxTasks < 1`, or `onCapacityExceeded`
 *               is not one of `"throw" | "grow" | "drop"`.
 */
export function createScheduler(config?: SchedulerConfig): Scheduler;

/**
 * Replace the module-default scheduler. Pass `null` to reset to lazy init.
 * Useful for testing or for installing a pre-configured app-wide scheduler.
 */
export function setDefaultScheduler(s: Scheduler | null): void;

/** Convenience: schedule a task on the default (lazily-created) scheduler. */
export function schedule(fn: () => void, priority?: number): void;

/** Convenience: shouldYield against the default scheduler. */
export function shouldYield(): boolean;

/** Convenience: isBusy against the default scheduler. */
export function isBusy(): boolean;

/** Convenience: yieldTask against the default scheduler. */
export function yieldTask(priority?: number): Promise<void>;

/** Convenience: stats from the default scheduler. */
export function stats(): SchedulerStats;
