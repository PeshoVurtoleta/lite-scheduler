/**
 * @zakkster/lite-scheduler -- torture harness (the shared spine).
 *
 * Modeled on ../LiteLru/test/torture/harness.mjs, restructured for the frame
 * scheduler. Four disciplines, non-negotiable:
 *
 *   1. SCRATCH ONCE. Measured hot loops are driven by a pre-built scheduler and
 *      pre-bound closures; the harness never allocates on a measured path beyond
 *      the promise an async schedule->flush cycle inherently needs.
 *   2. FAILURE-ONLY MESSAGES. check(cond, msgThunk) builds its string ONLY on
 *      failure. Pass a thunk, never a pre-built string, inside a hot loop.
 *   3. SEEDED REPLAY. The PRNG is a seeded xorshift32 (TORTURE_SEED env, 0-guarded
 *      to 1). Every failing message can carry the seed for one-env-var replay.
 *   4. ONE MEASUREMENT WINDOW AT A TIME. lite-gc-profiler shares one heap across
 *      lanes; tiers run strictly sequentially -- never nested, never concurrent.
 *      The frame scheduler is macrotask-driven, so its alloc lane uses the ASYNC
 *      profiler surface (measureOpsAsync/checkOpsAsync).
 *
 * @license MIT
 */

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into the t6 hot loop. */
export const BREAK = process.env.LSCHED_TORTURE_BREAK === '1';

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.stderr.write('  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Await macrotasks until the scheduler reports no pending work. A non-settling
 * cycle would hang the profiler's one-measurement guard for the life of the
 * process, so callers drive UNMEASURED cycles through here first (asserting
 * isBusy() === false) before entering any measured window.
 */
export function drain(sched, timeoutMs) {
    const limit = timeoutMs === undefined ? 5000 : timeoutMs;
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (!sched.isBusy()) return resolve();
            if (Date.now() - start > limit) return reject(new Error('drain timed out'));
            setTimeout(tick, 0);
        };
        tick();
    });
}

/** One-sided reachability census: false only when EVERY sampled ref is still live. */
export function censusOk(refs) {
    if (refs.length === 0) return true;
    let live = 0;
    for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) live++;
    return live !== refs.length;
}

/** Force several GC settle cycles so transient refs clear before a census read. */
export async function settleGc(cycles) {
    const n = cycles === undefined ? 4 : cycles;
    for (let i = 0; i < n; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 20));
    }
}

/**
 * The recorded-order oracle for the frame scheduler (t5/t9).
 *
 * Every task scheduled before a flush executes in a single stable order:
 * ascending priority value (Immediate=0 first, Idle=4 last), FIFO within a
 * lane. Priority values ARE the execution rank, so the oracle is a stable sort
 * of the scheduled items by priority. Budget interruptions never reorder work
 * (lane pointers persist across macrotask yields), so the same oracle holds
 * under a tight budget.
 *
 * @param {Array<{prio:number,id:number}>} items in schedule order (valid priorities 0..4)
 * @returns {number[]} predicted execution order of ids
 */
export function predictOrder(items) {
    const out = new Array(items.length);
    for (let i = 0; i < items.length; i++) out[i] = items[i];
    // Stable sort by priority ascending (Array.prototype.sort is stable in V8).
    out.sort((a, b) => a.prio - b.prio);
    const ids = new Array(out.length);
    for (let i = 0; i < out.length; i++) ids[i] = out[i].id;
    return ids;
}
