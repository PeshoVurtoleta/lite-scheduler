/**
 * t9 -- controls. Every gate must be provably able to fail (a gate that cannot
 * fail is decorative). Each control runs a deliberately-broken variant IN PROCESS
 * and asserts the corresponding gate flags it; where it matters it also proves
 * non-vacuity (the checker passes a genuinely correct input).
 *
 * The whole-suite alloc control lives out-of-process: LSCHED_TORTURE_BREAK=1
 * injects a retained allocation into the t6 hot loop; controls.mjs drives it.
 * The controls below prove each in-process gate bites on a plain `npm run torture`.
 *
 *   C1 an allocating async hot body        -> the async alloc gate rejects it
 *   C2 a corrupted recorded-order oracle   -> the t5 comparison diverges
 *   C3 a soak that SKIPS destroy()         -> the t7 tracker never clears
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { createScheduler, Priority } from '../../Scheduler.js';
import { check, die, drain, settleGc } from './harness.mjs';
import { runRound, firstMismatch } from './t5-fuzz.mjs';
import { soak } from './t7-soak.mjs';

const leak = [];

/** Run N schedule->flush cycles, optionally retaining an allocation each cycle,
 *  and return the gc-settled heapUsed growth in bytes. Mirrors t6 sub-gate B. */
async function heapGrowthOverCycles(retain, cycles) {
    const BATCH = 64;
    const sched = createScheduler({ maxTasks: BATCH * 2, budgetMs: 50 });
    const sink = new Int32Array(1);
    const tasks = new Array(BATCH);
    for (let i = 0; i < BATCH; i++) tasks[i] = () => { sink[0] = (sink[0] + 1) | 0; };
    let resolveCycle = null;
    const sentinel = () => { const r = resolveCycle; resolveCycle = null; if (r) r(); };
    const cycle = () => {
        for (let k = 0; k < BATCH; k++) sched.schedule(tasks[k], Priority.Normal);
        if (retain) leak.push(new Float64Array(64));
        return new Promise((res) => { resolveCycle = res; sched.schedule(sentinel, Priority.Normal); });
    };
    for (let i = 0; i < 300; i++) { await cycle(); check(!sched.isBusy(), () => 't9 C1: warmup left scheduler busy'); }
    globalThis.gc(); await new Promise((r) => setTimeout(r, 30)); globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < cycles; i++) await cycle();
    globalThis.gc(); await new Promise((r) => setTimeout(r, 30)); globalThis.gc();
    const h1 = process.memoryUsage().heapUsed;
    await drain(sched);
    sched.destroy();
    return h1 - h0;
}

export async function run() {
    // --- C1: an allocating hot cycle -> the t6 heap-growth bound rejects it ----
    // t6 gates allocation deterministically via a heap-growth bound over a long
    // schedule->flush soak (the async bytesPerOp is a promise-machinery fixture
    // floor, not the subject; see t6). Prove that bound has teeth.
    {
        const CYCLES = 60000;
        const CEILING = 4 * 1024 * 1024;
        // Non-vacuity: a zero-alloc soak grows the heap under the ceiling.
        const cleanGrowth = await heapGrowthOverCycles(false, CYCLES);
        if (cleanGrowth >= CEILING) {
            die('t9 C1: a clean schedule->flush soak blew the heap ceiling (vacuous) -- grew ' +
                (cleanGrowth / 1048576).toFixed(3) + ' MB');
        }
        // Teeth: a soak that retains an allocation per cycle blows the ceiling.
        const badGrowth = await heapGrowthOverCycles(true, CYCLES);
        if (badGrowth < CEILING) {
            die('t9 C1: a retaining schedule->flush soak did NOT blow the heap ceiling (no teeth) -- grew ' +
                (badGrowth / 1048576).toFixed(3) + ' MB');
        }
        leak.length = 0;
    }

    // --- C2: a corrupted recorded-order oracle -> the t5 comparison diverges --
    {
        const { executed, predicted } = await runRound(0xC2C2C2, { count: 400, budgetMs: 10, burn: false });
        // Non-vacuity: the CORRECT oracle agrees with the executed order.
        if (firstMismatch(executed, predicted) !== -1) {
            die('t9 C2: the CORRECT lane-then-FIFO oracle diverged from executed order (t5 is vacuous)');
        }
        // Teeth: a reversed oracle must diverge from the real executed order.
        const corrupt = predicted.slice().reverse();
        if (firstMismatch(executed, corrupt) === -1) {
            die('t9 C2: a reversed oracle did NOT diverge from executed order (the t5 comparison is toothless)');
        }
    }

    // --- C3: a soak that SKIPS destroy() -> the t7 tracker never clears --------
    // A scheduler that is never destroy()ed keeps its MessageChannel open and is
    // retained, so its lite-leak registration cannot clear. Strong refs (kept)
    // make non-collection deterministic AND give us the handles to clean up so
    // the open channels do not hang the process at exit.
    {
        const kept = [];
        const tracker = createLeakTracker({ name: 'sched-nodestroy-control' });
        await soak(tracker, 64, { destroy: false, keep: kept });
        await settleGc(6);
        check(tracker.size() > 0,
            () => 't9 C3: a soak that skips destroy() still cleared the tracker (t7 is toothless)');
        for (let i = 0; i < kept.length; i++) kept[i].destroy(); // cleanup: plug the channels
    }
}
