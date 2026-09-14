/**
 * @zakkster/lite-scheduler -- Zero-GC Frame Budget Manager
 *
 * Architecture: Monomorphic Task Pool + Priority SLLs + Immediate Ring Buffer
 *
 *   - Clock Batching: `performance.now()` is polled every 16 tasks to bypass
 *     OS timer stalls on the hot path.
 *   - Ring Buffer: Immediate tasks bypass the SLL pool for pure O(1) execution.
 *   - SMI Coercion: All internal counters use 32-bit integer arithmetic.
 *   - Cancellation: Omitted by design to maintain strict zero-allocation
 *     (returning tokens allocates closures).
 *
 * @module @zakkster/lite-scheduler
 * @author Zahary Shinikchiev
 * @license MIT
 */

export const Priority = {
    /** Bypasses the SLL queues and frame deadline. Drained first, in FIFO. */
    Immediate: 0,
    /** Highest SLL lane. For input handlers, gesture recognition. */
    UserInput: 1,
    /** Default SLL lane. */
    Normal: 2,
    /** Below normal; background loaders, prefetching. */
    Background: 3,
    /** Idle. Runs only when no higher lane has work for the frame. */
    Idle: 4,
};

const NUM_SLL_PRIORITIES = 4;
const DEFAULT_BUDGET_MS = 10;

/** The complete set of accepted `createScheduler` config keys. */
const KNOWN_CONFIG_KEYS = ["maxTasks", "onCapacityExceeded", "budgetMs", "onError"];

/**
 * Levenshtein edit distance between two short strings. Cold path only (called
 * once per unknown config key, at construction), so allocation is irrelevant.
 */
function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = row[j];
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
            prev = tmp;
        }
    }
    return row[n];
}

/** Nearest known config key to `key`, or null when nothing is close. Cold path. */
function nearestConfigKey(key) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < KNOWN_CONFIG_KEYS.length; i++) {
        const d = editDistance(key, KNOWN_CONFIG_KEYS[i]);
        if (d < bestScore) { bestScore = d; best = KNOWN_CONFIG_KEYS[i]; }
    }
    return bestScore <= Math.max(2, (key.length / 2) | 0) ? best : null;
}

class TaskNode {
    constructor() {
        this.fn = null;
        this.next = null;
        this.nextFree = null;
    }
}

/**
 * Thrown when a `throw` capacity policy is configured and the relevant
 * pool (SLL or immediate ring buffer) overflows.
 */
export class CapacityError extends Error {
    constructor(kind, capacity) {
        super(`CapacityError: ${kind} capacity (${capacity}) exceeded.`);
        this.name = "CapacityError";
        this.kind = kind;
        this.capacity = capacity;
    }
}

/**
 * Create a scheduler instance with its own task pool and message channel.
 *
 * @param {Object}   [config]
 * @param {number}   [config.maxTasks=2048]            Initial SLL pool capacity.
 *                                                     The immediate ring buffer
 *                                                     starts at 1024 entries.
 *                                                     Both are bounded above
 *                                                     by `maxTasks * 16`.
 * @param {"throw"|"grow"|"drop"} [config.onCapacityExceeded="throw"]
 *                                                     How to react when a pool
 *                                                     is at capacity:
 *                                                       - "throw": throw a CapacityError
 *                                                       - "grow": double the pool, up to maxTasks*16
 *                                                       - "drop": silently discard the task
 * @param {number}   [config.budgetMs=10]              Per-flush frame budget in ms. Must be > 0.
 * @param {Function} [config.onError=console.error]    Error sink for tasks that throw.
 *                                                     Receives `(message: string, error: Error)`.
 * @returns {{
 *   schedule:    (fn: () => void, priority?: number) => void,
 *   shouldYield: () => boolean,
 *   isBusy:      () => boolean,
 *   yieldTask:   (priority?: number) => Promise<void>,
 *   stats:       () => SchedulerStats,
 *   destroy:     () => void,
 * }}
 */
export function createScheduler(config = {}) {
    // Reject unknown config keys with a nearest-key hint (fail closed, cold path).
    if (config !== null && typeof config === "object") {
        const keys = Object.keys(config);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (KNOWN_CONFIG_KEYS.indexOf(k) === -1) {
                const hint = nearestConfigKey(k);
                throw new Error('lite-scheduler: unknown config key "' + k + '"' +
                    (hint ? ' -- did you mean "' + hint + '"?' : ''));
            }
        }
    }

    let currentCapacity = config.maxTasks ?? 2048;
    const initialCapacity = currentCapacity;
    const policy = config.onCapacityExceeded ?? "throw"; // "throw", "grow", "drop"
    const budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS;
    const maxTaskLimit = initialCapacity * 16;
    const onError = config.onError || console.error;

    // Validate config to prevent silent foot-guns.
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
        throw new Error(`lite-scheduler: budgetMs must be a positive number, got ${config.budgetMs}`);
    }
    if (!Number.isInteger(currentCapacity) || currentCapacity < 1) {
        throw new Error(`lite-scheduler: maxTasks must be a positive integer, got ${config.maxTasks}`);
    }
    if (policy !== "throw" && policy !== "grow" && policy !== "drop") {
        throw new Error(`lite-scheduler: onCapacityExceeded must be one of "throw", "grow", "drop"; got ${policy}`);
    }
    // onError, when provided, must be callable. undefined means absent (the
    // default above stands); an explicit null throws -- null is not zero.
    if (config.onError !== undefined && typeof config.onError !== "function") {
        throw new Error("lite-scheduler: onError must be a function, got " + typeof config.onError);
    }

    // --- ZERO-GC SLL TASK POOL ---
    const taskPool = [];
    for (let i = 0; i < currentCapacity; i++) taskPool[i] = new TaskNode();
    let freeTaskHead = taskPool[0];
    for (let i = 0; i < currentCapacity - 1; i++) taskPool[i].nextFree = taskPool[i + 1];

    let activeTasks = 0 | 0;
    let statExecuted = 0 | 0;

    // --- SLL PRIORITY QUEUES ---
    const heads = [];
    const tails = [];
    for (let i = 0; i < NUM_SLL_PRIORITIES; i++) {
        heads[i] = null;
        tails[i] = null;
    }

    // --- IMMEDIATE RING BUFFER ---
    let immCapacity = 1024;
    let immMask = immCapacity - 1;
    let immediateRing = new Array(immCapacity).fill(null);
    let immHead = 0 | 0;
    let immTail = 0 | 0;

    // --- MACRO-TASK ENGINE ---
    let isFlushing = false;
    let currentDeadline = 0;
    let destroyed = false;

    const channel = new MessageChannel();
    const port = channel.port2;
    channel.port1.onmessage = performWork;

    function performWork() {
        if (destroyed) return;

        // 1. Drain Immediate Ring Buffer (Bypasses deadlines).
        while (((immTail - immHead) | 0) > 0) {
            const idx = immHead & immMask;
            const fn = immediateRing[idx];
            immediateRing[idx] = null; // Clear ref so the closure can be GC'd.
            immHead = (immHead + 1) | 0;

            try {
                fn();
                statExecuted = (statExecuted + 1) | 0;
            } catch (err) {
                onError("Scheduler Immediate Error:", err);
            }
        }

        // 2. Process SLL Queues with Clock Batching.
        currentDeadline = performance.now() + budgetMs;
        let hasMoreWork = false;
        let taskCount = 0 | 0;

        for (let p = 0; p < NUM_SLL_PRIORITIES; p++) {
            while (heads[p] !== null) {
                // Clock Batching: Check deadline every 16 tasks. We skip the
                // very first check (taskCount > 0) to guarantee progress even
                // when the deadline has somehow already passed at entry.
                if (taskCount > 0 && (taskCount & 15) === 0) {
                    if (performance.now() >= currentDeadline) {
                        hasMoreWork = true;
                        break;
                    }
                }
                taskCount = (taskCount + 1) | 0;

                const task = heads[p];
                heads[p] = task.next;
                if (heads[p] === null) tails[p] = null;

                const fn = task.fn;

                // Inlined free-list return for IC stability.
                task.nextFree = freeTaskHead;
                freeTaskHead = task;
                task.next = null;
                task.fn = null;
                activeTasks = (activeTasks - 1) | 0;

                try {
                    fn();
                    statExecuted = (statExecuted + 1) | 0;
                } catch (err) {
                    onError("Scheduler Task Error:", err);
                }
            }
            if (hasMoreWork) break;
        }

        // Explicitly check if new tasks were queued mid-flush, including
        // immediate-ring entries scheduled by an SLL task.
        if (hasMoreWork || activeTasks > 0 || ((immTail - immHead) | 0) > 0) {
            port.postMessage(null);
        } else {
            isFlushing = false;
        }
    }

    // --- PUBLIC API ---

    /**
     * Enqueue a function for execution on a future macrotask.
     *
     * @param {() => void} fn  Task body. Synchronous exceptions are caught
     *                         and routed to `onError`. Async errors (rejected
     *                         promises returned from `fn`) are NOT observed.
     *                         Throws a `TypeError` at the call site when `fn`
     *                         is not a function (before any pool touch).
     * @param {number} [priority=Priority.Normal]
     *                         One of the `Priority` constants. Any value that is
     *                         not an integer in [UserInput..Idle] is coerced to
     *                         `Normal`. Immediate (0) is matched exactly, before
     *                         coercion.
     */
    function schedule(fn, priority = Priority.Normal) {
        if (destroyed) return;

        if (typeof fn !== "function") {
            throw new TypeError("lite-scheduler: schedule(fn) requires a function, got " + typeof fn);
        }

        if (priority === Priority.Immediate) {
            if (((immTail - immHead) | 0) >= immCapacity) {
                if (policy === "throw") throw new CapacityError("immediate tasks", immCapacity);
                if (policy === "drop") return;

                // Grow Immediate Ring Buffer.
                const newCap = immCapacity * 2;
                if (newCap > maxTaskLimit) throw new CapacityError("immediate tasks", maxTaskLimit);

                const newRing = new Array(newCap).fill(null);
                for (let i = 0; i < immCapacity; i++) {
                    newRing[i] = immediateRing[(immHead + i) & immMask];
                }

                immediateRing = newRing;
                immHead = 0 | 0;
                immTail = immCapacity | 0;
                immCapacity = newCap;
                immMask = newCap - 1;
            }

            immediateRing[immTail & immMask] = fn;
            immTail = (immTail + 1) | 0;

            if (!isFlushing) {
                isFlushing = true;
                port.postMessage(null);
            }
            return;
        }

        // Sanitize priority bounds.
        if ((priority | 0) !== priority || priority < Priority.UserInput || priority > Priority.Idle) {
            priority = Priority.Normal;
        }

        if (freeTaskHead === null) {
            if (policy === "throw") throw new CapacityError("tasks", currentCapacity);
            if (policy === "drop") return;

            // Grow SLL Pool.
            const newCap = currentCapacity * 2;
            if (newCap > maxTaskLimit) throw new CapacityError("tasks", maxTaskLimit);

            const newTasks = new Array(newCap - currentCapacity);
            for (let i = 0; i < newTasks.length; i++) newTasks[i] = new TaskNode();
            for (let i = 0; i < newTasks.length - 1; i++) newTasks[i].nextFree = newTasks[i + 1];

            // Append the new pool slice without using the spread operator (which
            // would synchronously construct an arguments array of size O(newCap)).
            const oldCap = currentCapacity;
            taskPool.length = newCap;

            for (let i = 0; i < newTasks.length; i++) {
                taskPool[oldCap + i] = newTasks[i];
            }

            freeTaskHead = newTasks[0];
            currentCapacity = newCap;
        }

        const task = freeTaskHead;
        freeTaskHead = task.nextFree;
        task.nextFree = null;
        activeTasks = (activeTasks + 1) | 0;

        task.fn = fn;
        task.next = null;

        const sllIdx = (priority - 1) | 0;
        const currentTail = tails[sllIdx];

        if (currentTail !== null) {
            currentTail.next = task;
        } else {
            heads[sllIdx] = task;
        }
        tails[sllIdx] = task;

        if (!isFlushing) {
            isFlushing = true;
            port.postMessage(null);
        }
    }

    /**
     * Returns true when the current flush has exceeded its `budgetMs`. Call
     * this inside long-running tasks to cooperate with the scheduler.
     *
     * Note: outside of an active flush, this always returns true because the
     * stored deadline is from a previous (already-completed) flush.
     */
    function shouldYield() {
        return performance.now() >= currentDeadline;
    }

    /**
     * True if the scheduler has any pending work -- either a flush in
     * progress, queued SLL tasks, or pending immediate tasks.
     */
    function isBusy() {
        return isFlushing || activeTasks > 0 || ((immTail - immHead) | 0) > 0;
    }

    /**
     * Returns a Promise that resolves on the next scheduled tick at the given
     * priority. Useful for `await yieldTask()` patterns in long sync code.
     */
    function yieldTask(priority = Priority.Normal) {
        if (destroyed) return Promise.reject(new Error("Scheduler destroyed"));
        return new Promise(resolve => schedule(resolve, priority));
    }

    /**
     * Snapshot of scheduler internals. Useful for debugging or instrumenting
     * a frame profiler.
     */
    function stats() {
        return {
            activeSllTasks: activeTasks,
            activeImmediateTasks: (immTail - immHead) | 0,
            poolCapacity: currentCapacity,
            immediateCapacity: immCapacity,
            totalExecuted: statExecuted,
        };
    }

    /**
     * Releases the MessageChannel and clears all pools.
     * Idempotent. After destroy, schedule() is a no-op and yieldTask() rejects.
     */
    function destroy() {
        if (destroyed) return;
        destroyed = true;

        // Plug the MessageChannel memory leak.
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();

        for (let i = 0; i < currentCapacity; i++) {
            const t = taskPool[i];
            t.fn = null;
            t.next = null;
            if (i < currentCapacity - 1) t.nextFree = taskPool[i + 1];
        }
        taskPool[currentCapacity - 1].nextFree = null;
        freeTaskHead = taskPool[0];

        for (let i = 0; i < NUM_SLL_PRIORITIES; i++) {
            heads[i] = null;
            tails[i] = null;
        }

        for (let i = 0; i < immCapacity; i++) {
            immediateRing[i] = null;
        }

        immHead = 0 | 0;
        immTail = 0 | 0;
        activeTasks = 0 | 0;
        statExecuted = 0 | 0;
        isFlushing = false;
        currentDeadline = 0;
    }

    return { schedule, shouldYield, isBusy, yieldTask, stats, destroy };
}

// -------------------------------------------------------------------
// GLOBAL BINDINGS (Lazy Initialized)
// -------------------------------------------------------------------

/** Package version. Kept in sync with package.json and llms.txt. */
export const VERSION = "1.1.0";

let _defaultScheduler = null;

function getDefault() {
    return _defaultScheduler ?? (_defaultScheduler = createScheduler());
}

/**
 * Replace the module-default scheduler. Pass `null` to reset to lazy init.
 * Useful for testing or for installing a pre-configured app-wide scheduler.
 */
export function setDefaultScheduler(s) {
    _defaultScheduler = s;
}

/** Convenience: schedule a task on the default scheduler. */
export function schedule(fn, priority) {
    return getDefault().schedule(fn, priority);
}

/** Convenience: shouldYield against the default scheduler. */
export function shouldYield() {
    return getDefault().shouldYield();
}

/** Convenience: isBusy against the default scheduler. */
export function isBusy() {
    return getDefault().isBusy();
}

/** Convenience: yieldTask against the default scheduler. */
export function yieldTask(priority) {
    return getDefault().yieldTask(priority);
}

/** Convenience: stats from the default scheduler. */
export function stats() {
    return getDefault().stats();
}

// ===================================================================
// SECOND MEMBER: FastBitScheduler (v1.1.0)
//
// A 32-tier bucket priority queue with an O(1) bitmask routing table and one
// TRUE ring buffer per tier. Independent of the frame scheduler above: it never
// imports, references, or shares state with createScheduler, and the frame
// scheduler never learns the mask exists (decisions/0002).
//
// The design rests on one trick: instead of SCANNING numTiers to find the
// highest-priority non-empty one, keep a single 32-bit int `activeMask` whose
// bit p is 1 exactly when tier p holds >= 1 item. "Highest priority" is then
// "lowest set bit" -- two instructions (`x & -x`, then `Math.clz32`), no loop,
// however many tiers are populated. Bit 0 = P0 = highest priority.
//
// Layout (Structure-of-Arrays; zero allocation after construction):
//   activeMask : Int32       -- routing table; bit p set <=> tier p non-empty
//   buckets[p] : Int32Array  -- ring storage for tier p (HANDLES, not objects)
//   heads[p]   : Uint32      -- read cursor  (next slot to pop)
//   tails[p]   : Uint32      -- write cursor (next slot to push)
//   counts[p]  : Uint32      -- live items in tier p (the ring's fill level)
//
// Storage is Int32Array, never Float32Array: a 32-bit float cannot represent
// integers above 2^24 exactly, so a Float32 store would silently corrupt any
// handle above 2^24 (it would round to a neighbor and alias a different SoA
// row). Int32Array round-trips every non-negative Int32 handle bit-exact.
//
// Contract (fail closed -- every caller bug throws at the door):
//   - priority MUST be an integer 0..numTiers-1 (0 = highest). JS shift is mod
//     32, so an unchecked priority 32 would silently alias tier 0 -- refused.
//   - items MUST be non-negative Int32 HANDLES (indices into some external SoA),
//     because Int32Array stores 32-bit ints and popMin() reserves EMPTY (-1) for
//     "empty": an object would coerce to 0, and a stored -1 would collide with
//     EMPTY and strand the canonical drain loop. The item door refuses both.
//   - a tier at capacity throws rather than silently dropping the write.
//   - capacity rounds up to a power of two and the round-up is OBSERVABLE via
//     `capacity` (allocated) vs `requestedCapacity` (asked for).
//
// Why counts[] exists: in a real ring `head` can pass `tail` around the circle,
// so `head === tail` is ambiguous -- it means BOTH full and empty. The count
// column disambiguates, doubles as the full-check, and triggers the routing-bit
// clear. It is the one field that turns a linear-arena-with-reset into a ring.
//
// Review note: the `31 - Math.clz32(x & -x)` line in popMin/peekMin/peekPriority
// is sign-agnostic (it operates on the isolated lowest bit) and stays
// BYTE-IDENTICAL to the fuzz-proven draft -- do not "fix" it for the tier-31
// sign bit.
// ===================================================================

/** Out-of-band return from popMin/peekMin (stored handles are always >= 0). */
export const EMPTY = -1;

/** Round n up to the next power of two, so ring indices wrap with `& (cap-1)`
 *  instead of the slower `% cap`. The constructor's capacity door guarantees an
 *  integer >= 1 before this is called, so no `n | 0` truncation is needed. */
function ceilPow2(n) {
    if (n < 2) return 2;
    n--; n |= n >> 1; n |= n >> 2; n |= n >> 4; n |= n >> 8; n |= n >> 16;
    return (n + 1) >>> 0;
}

const FASTBIT_MAX_CAP = 16777216; // 2**24 -- the documented capacity ceiling

export class FastBitScheduler {
    /**
     * @param {number} [capacityPerTier=1024] ring slots per tier; rounded up to a
     *   power of two. Must be an integer 1..16777216 (2**24). Nothing clamps.
     * @param {number} [numTiers=32] number of priority tiers; integer 2..32.
     */
    constructor(capacityPerTier = 1024, numTiers = 32) {
        // --- cold doors: fail closed, nothing silently clamps ----------------
        if ((numTiers | 0) !== numTiers || numTiers < 2 || numTiers > 32) {
            throw new RangeError(
                "lite-scheduler: numTiers must be an integer 2..32, got " + numTiers
            );
        }
        if ((capacityPerTier | 0) !== capacityPerTier ||
            capacityPerTier < 1 || capacityPerTier > FASTBIT_MAX_CAP) {
            throw new RangeError(
                "lite-scheduler: capacityPerTier must be an integer 1..16777216 (2**24), got " +
                capacityPerTier
            );
        }

        const cap = ceilPow2(capacityPerTier);
        this._requestedCapacity = capacityPerTier; // what the caller asked for
        this._cap  = cap;          // ring capacity per tier (power of two)
        this._mask = cap - 1;      // wrap mask: (i + 1) & _mask -- no branch, no %
        this._numTiers = numTiers;
        this._maxPrio  = numTiers - 1; // hoisted priority-door bound (was literal 31)
        this._size = 0;            // O(1) maintained item count

        // A single 32-bit int is the O(1) routing table. Bit p set == tier p live.
        this.activeMask = 0;

        // numTiers parallel rings (SoA). No Map, no resize, no per-op allocation.
        this.buckets = Array.from({ length: numTiers }, () => new Int32Array(cap));

        // Per-tier ring cursors + fill level.
        this.heads  = new Uint32Array(numTiers);
        this.tails  = new Uint32Array(numTiers);
        this.counts = new Uint32Array(numTiers);
    }

    /** O(1) push. Throws on a bad priority, a bad item, or a full tier (fail closed). */
    push(item, priority) {
        if ((priority | 0) !== priority || priority < 0 || priority > this._maxPrio) {
            throw new RangeError(
                "lite-scheduler: priority must be an integer 0.." + this._maxPrio + ", got " + priority
            );
        }
        // Item door: two integer compares. A non-integer or negative handle would
        // coerce into the Int32Array (an object -> 0, NaN -> 0, 1.5 -> 1, 2**31 ->
        // negative, '7' -> 7) or collide with EMPTY (-1). Refuse it here.
        if ((item | 0) !== item || item < 0) {
            throw new RangeError(
                "lite-scheduler: item must be a non-negative Int32 handle (0..2147483647), got " + item
            );
        }
        if (this.counts[priority] === this._cap) {
            throw new RangeError(
                "lite-scheduler: tier " + priority + " is full (" + this._cap + ")"
            );
        }

        const t = this.tails[priority];
        this.buckets[priority][t] = item;            // write at the tail cursor
        this.tails[priority] = (t + 1) & this._mask; // TRUE ring wrap
        this.counts[priority]++;
        this._size++;

        this.activeMask |= (1 << priority);          // this tier now has data
    }

    /** O(1) true pop-min: the item from the highest-priority non-empty tier.
     *  Returns EMPTY (-1) when every tier is empty. */
    popMin() {
        if (this.activeMask === 0) return EMPTY;

        // Isolate the lowest set bit (two's complement), then turn it into its
        // index -- the highest priority present -- with no scan.
        const lowestBit = this.activeMask & -this.activeMask;
        const p = 31 - Math.clz32(lowestBit);

        const h = this.heads[p];
        const item = this.buckets[p][h];             // read at the head cursor
        this._size--;                                // O(1) size counter (decision 0003)
        this.heads[p] = (h + 1) & this._mask;        // ring wrap -- no reset needed

        // Last item in this tier? Clear its routing bit so popMin skips it. The
        // cursors are left where they are; count keeps them honest, so slots are
        // reused in place with zero GC.
        if (--this.counts[p] === 0) {
            this.activeMask &= ~lowestBit;
        }

        return item;
    }

    /** Read the next item without removing it. EMPTY if the scheduler is empty. */
    peekMin() {
        if (this.activeMask === 0) return EMPTY;
        const p = 31 - Math.clz32(this.activeMask & -this.activeMask);
        return this.buckets[p][this.heads[p]];
    }

    /** Tier the next popMin() would drain from, or -1 when empty. O(1), cold-ish. */
    peekPriority() {
        if (this.activeMask === 0) return -1;
        return 31 - Math.clz32(this.activeMask & -this.activeMask);
    }

    isEmpty() { return this.activeMask === 0; }

    /** Live item count in one tier. Throws on a bad priority (never undefined). */
    sizeOf(priority) {
        if ((priority | 0) !== priority || priority < 0 || priority > this._maxPrio) {
            throw new RangeError(
                "lite-scheduler: priority must be an integer 0.." + this._maxPrio + ", got " + priority
            );
        }
        return this.counts[priority];
    }

    /** Empty every tier without reallocating. O(numTiers); documented cold. */
    clear() {
        for (let p = 0; p < this._numTiers; p++) {
            this.heads[p] = 0;
            this.tails[p] = 0;
            this.counts[p] = 0;
        }
        this.activeMask = 0;
        this._size = 0;
    }

    /** O(1) maintained total item count across all tiers. */
    get size() { return this._size; }
    /** Allocated ring capacity per tier (power of two; the round-up result). */
    get capacity() { return this._cap; }
    /** Capacity the caller requested (pre round-up), so the round-up is observable. */
    get requestedCapacity() { return this._requestedCapacity; }
    /** Number of priority tiers this instance was built with. */
    get numTiers() { return this._numTiers; }
}
