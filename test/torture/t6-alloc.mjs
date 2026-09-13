/**
 * t6 -- the async zero-alloc gate (the THING UNDER TEST).
 *
 * The frame scheduler is macrotask-driven, so a schedule->flush cycle is async;
 * the alloc lane uses the ASYNC profiler surface, NEVER the sync one. One cycle =
 * schedule a batch of pre-bound task closures, then await the flush (a sentinel
 * task resolves the cycle promise). Task bodies touch only a pre-allocated
 * Int32Array sink.
 *
 * WHY bytesPerOp IS NOT gated at 0 on this lane (measured, not assumed):
 *   An awaited op inherently allocates one Promise + its executor, and the flush
 *   transport allocates one MessageChannel event. Under `measureOpsAsync` +
 *   `checkOpsAsync({maxBytesPerOp:0})` even a bare `() => Promise.resolve()` reads
 *   a non-zero retained FLOOR (measured ~3-9 B/op at 3-5k ops; it amortizes toward
 *   0 only as ops -> 1e5, e.g. 0.22 B/op at 80k). That floor is the FIXTURE's cost,
 *   not the SUBJECT's, so a raw `maxBytesPerOp:0` here would gate the promise
 *   machinery. The differential `compareOpsAsync` that subtracts the floor works
 *   MOST of the time (per-task delta measured <= 0) but its stabilize bracket
 *   inverts ~1/3 of runs on a genuinely zero-alloc subject (either the control or
 *   candidate window reclaims more than it allocates), which the profiler
 *   correctly routes to `inconclusive`. A torture gate must be DETERMINISTIC, so
 *   allocation is gated three deterministic ways instead:
 *     (A) the async lane gates majorsPerKOp:0 + maxPauseMsPerOp<=4 -- steady-state
 *         must produce zero major GCs and no over-budget pause;
 *     (B) a heap-growth bound over SOAK unmeasured cycles: heapUsed grows under a
 *         small FIXED ceiling (clean run measured at ~0 MB over 60k cycles). Any
 *         real per-op retention (e.g. the BREAK control's 512 B/op) blows it;
 *     (C) stats().poolCapacity and stats().immediateCapacity are byte-identical
 *         before and after the churn -- the pool must not have grown.
 *   bytesPerOp is still measured and logged for transparency.
 *
 * HANG MITIGATION (mandatory): the profiler is one-measurement-at-a-time and a
 * non-settling async op would hold its guard for the life of the process. So the
 * cycle is driven UNMEASURED first, asserting isBusy() === false per cycle, before
 * any measured window opens. stats() and yieldTask() are documented allocators and
 * stay OUT of the measured loop.
 *
 * LSCHED_TORTURE_BREAK=1 injects a retained allocation into the hot cycle so the
 * heap-growth bound (B) rejects it; t9 + controls.mjs exercise the same lane.
 */

import { measureOpsAsync, checkOpsAsync } from '@zakkster/lite-gc-profiler';
import { createScheduler, Priority } from '../../Scheduler.js';
import { check, die, BREAK } from './harness.mjs';

const BATCH = 64;         // tasks scheduled per cycle
const OPS = 3000;         // measured schedule->flush cycles (async lane)
const WARMUP = 300;       // unmeasured warmup / hang-mitigation drive cycles
const SOAK = 100000;      // unmeasured cycles for the heap-growth bound
const HEAP_CEILING = 2 * 1024 * 1024; // clean run measured ~-0.004 MB; BREAK ~19.9 MB

/** GC-pressure rules on the async lane (bytesPerOp is the fixture floor, not gated). */
const GC_RULES = { maxMajorsPerKOp: 0, maxPauseMsPerOp: 4 };

/** Retained sink for the BREAK control -- survives GC so heap growth climbs. */
const leak = [];

export async function run() {
    const sched = createScheduler({ maxTasks: BATCH * 2, budgetMs: 50 });
    const sink = new Int32Array(1);
    const tasks = new Array(BATCH);
    for (let i = 0; i < BATCH; i++) tasks[i] = () => { sink[0] = (sink[0] + 1) | 0; };

    let resolveCycle = null;
    const sentinel = () => { const r = resolveCycle; resolveCycle = null; if (r) r(); };

    const cycle = () => {
        for (let k = 0; k < BATCH; k++) sched.schedule(tasks[k], Priority.Normal);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
        return new Promise((res) => { resolveCycle = res; sched.schedule(sentinel, Priority.Normal); });
    };

    // Capture the pool sizes BEFORE any churn (stats() is out of the measured loop).
    const poolBefore = sched.stats().poolCapacity;
    const immBefore = sched.stats().immediateCapacity;

    // Hang mitigation: drive the cycle UNMEASURED and assert it settles each time.
    for (let i = 0; i < WARMUP; i++) {
        await cycle();
        check(sched.isBusy() === false,
            () => 't6: warmup cycle ' + i + ' left the scheduler busy -- a non-settling op would hang the gate');
    }

    // --- Sub-gate A: async GC-pressure lane (pinned measureOpsAsync surface) ---
    const res = await measureOpsAsync(cycle, { ops: OPS, warmup: 0, stabilize: 'deep' });
    const rep = checkOpsAsync(res, GC_RULES);
    if (rep.verdict !== 'pass') {
        die('t6 (A) async GC-pressure gate rejected -- verdict=' + rep.verdict +
            ' source=' + res.source + ' majorsPerKOp=' + res.majorsPerKOp +
            ' maxPauseMsPerOp=' + res.maxPauseMsPerOp.toFixed(3) +
            ' violations=' + JSON.stringify(rep.violations) +
            (BREAK ? ' (LSCHED_TORTURE_BREAK control)' : ''));
    }

    // --- Sub-gate B: deterministic allocation bound over a long soak ----------
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 30));
    globalThis.gc();
    const heap0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < SOAK; i++) await cycle();
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 30));
    globalThis.gc();
    const heap1 = process.memoryUsage().heapUsed;
    const growth = heap1 - heap0;
    check(growth < HEAP_CEILING,
        () => 't6 (B) heap grew ' + (growth / 1048576).toFixed(3) + ' MB over ' + SOAK +
            ' schedule->flush cycles (ceiling ' + (HEAP_CEILING / 1048576).toFixed(1) + ' MB) -- per-op retention' +
            (BREAK ? ' (LSCHED_TORTURE_BREAK control -- expected)' : ''));

    // --- Sub-gate C: the pool must not have grown across the churn ------------
    const poolAfter = sched.stats().poolCapacity;
    const immAfter = sched.stats().immediateCapacity;
    check(poolAfter === poolBefore,
        () => 't6 (C) SLL pool grew ' + poolBefore + ' -> ' + poolAfter + ' across steady churn');
    check(immAfter === immBefore,
        () => 't6 (C) immediate ring grew ' + immBefore + ' -> ' + immAfter + ' across steady churn');

    if (BREAK) die('t6: LSCHED_TORTURE_BREAK injected allocations but every sub-gate passed');

    sched.destroy();

    const bpo = res.bytesPerOp === null ? 'null(inverted)' : res.bytesPerOp.toFixed(3);
    process.stderr.write('t6: majorsPerKOp=' + res.majorsPerKOp + ' maxPauseMsPerOp=' +
        res.maxPauseMsPerOp.toFixed(3) + ' over ' + OPS + ' cycles; heap growth ' +
        (growth / 1048576).toFixed(3) + ' MB over ' + SOAK + ' cycles; async bytesPerOp floor=' +
        bpo + ' B/op (fixture, not gated)\n');
}
