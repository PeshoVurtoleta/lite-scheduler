/**
 * @zakkster/lite-scheduler
 * Zero-GC Frame Budget Manager with strict priority lanes.
 */

/**
 * Priority lane constants. Lower numerical values run first.
 *
 * - `Immediate` (0): Bypasses both the SLL lanes and the frame deadline.
 *   Drained in FIFO before any SLL work, even when the budget is exhausted.
 *   Use sparingly -- there is no fairness guarantee with respect to the page.
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
     *                  from `fn`) are NOT observed. Throws a `TypeError` at the
     *                  call site when `fn` is not a function (not at flush time).
     * @param priority  One of the `Priority` constants. Any value that is not an
     *                  integer in `[UserInput..Idle]` -- NaN, a fraction,
     *                  Infinity, a string, out of range -- is coerced to
     *                  `Normal`; `Immediate` (0) is matched exactly, before
     *                  coercion. Defaults to `Priority.Normal`.
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
     * True if the scheduler has any pending work -- a flush in progress,
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
 * @throws Error when `budgetMs <= 0`, `maxTasks < 1`, `onCapacityExceeded` is
 *               not one of `"throw" | "grow" | "drop"`, `onError` is provided
 *               but not callable, or the config carries an unknown key (the
 *               nearest known key is named in the message).
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

/** Package version. In sync with package.json and llms.txt. */
export const VERSION: string;

// ============================================================
// Second member: FastBitScheduler (v1.1.0). Independent of the frame scheduler
// above; neither references the other (decisions/0002).
// ============================================================

/** Out-of-band return from popMin/peekMin. Stored handles are always >= 0. */
export const EMPTY: -1;

/**
 * A 32-tier bucket priority queue over non-negative Int32 HANDLES, with an O(1)
 * bitmask routing table and one true ring buffer per tier. "Pop the highest
 * priority" is a lowest-set-bit on a single 32-bit int -- two instructions, no
 * scan, however many tiers are live. Bit 0 = priority 0 = highest.
 *
 * Contract: handles are non-negative Int32 (0..2147483647); EMPTY (-1) is the
 * one out-of-band value and it is exported; a full tier throws; capacity rounds
 * up to a power of two and the round-up is observable (capacity vs
 * requestedCapacity); no callbacks -- the drain loop is the API (decisions/0005).
 *
 * The internal fields (activeMask, buckets, heads, tails, counts, _cap, _mask,
 * _size, _maxPrio, _numTiers, _requestedCapacity) are intentionally NOT declared:
 * the torture lanes reach them, the type surface does not. The drift test carries
 * an explicit internal-field allowlist so adding a field silently is still caught.
 */
export class FastBitScheduler {
    /**
     * @param capacityPerTier ring slots per tier; rounded up to a power of two.
     *   Integer 1..16777216 (2**24). Throws (naming the ceiling) otherwise;
     *   nothing clamps. Default 1024.
     * @param numTiers number of priority tiers; integer 2..32. Throws otherwise.
     *   Default 32.
     */
    constructor(capacityPerTier?: number, numTiers?: number);
    /** O(1). Enqueue a handle at a priority. Throws (RangeError, `lite-scheduler:`)
     *  on a non-integer/negative handle, a priority outside 0..numTiers-1, or a
     *  full tier. */
    push(item: number, priority: number): void;
    /** O(1). Remove and return the handle from the highest-priority non-empty
     *  tier, or EMPTY (-1) when empty. */
    popMin(): number;
    /** O(1). The handle popMin would return, without removing it; EMPTY when empty. */
    peekMin(): number;
    /** O(1). The tier popMin would drain from, or -1 when empty. */
    peekPriority(): number;
    /** O(1). True exactly when no tier holds an item. */
    isEmpty(): boolean;
    /** O(1). Live item count in one tier. Throws on a bad priority; never returns
     *  undefined. */
    sizeOf(priority: number): number;
    /** O(numTiers), cold. Empty every tier without reallocating any ring. */
    clear(): void;
    /** O(1) maintained total item count across all tiers. */
    readonly size: number;
    /** Allocated ring capacity per tier (the power-of-two round-up result). */
    readonly capacity: number;
    /** Capacity the caller requested, pre round-up (so the round-up is observable). */
    readonly requestedCapacity: number;
    /** Number of priority tiers this instance was built with. */
    readonly numTiers: number;
}
