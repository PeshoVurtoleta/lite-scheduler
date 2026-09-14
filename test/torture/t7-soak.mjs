/**
 * t7 -- soak. 4096 create -> schedule -> drain -> destroy cycles, each scheduler
 * tracked with lite-leak. This is the gate for the shipped, previously-ungated
 * claim that destroy() plugs the MessageChannel leak.
 *
 * The teeth: the cleanup closure and tag close over NOTHING they track (capturing
 * the target defeats finalization and the harness silently reports clean). No
 * untrack() is called -- the registration must clear on its OWN, via the
 * FinalizationRegistry firing after the scheduler is collected. A scheduler whose
 * MessageChannel destroy() plugged becomes collectible once its reference drops;
 * one that leaked its channel stays alive and its registration never clears. So
 * after gc + settle, tracker.size() === 0 proves every scheduler was collected.
 * A WeakRef census witnesses actual collection (size() is not a reachability
 * census). The t9 no-destroy control proves this gate can fail.
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { createScheduler, FastBitScheduler } from '../../Scheduler.js';
import { check, drain, censusOk, settleGc, fbConserved, fbConservationReport } from './harness.mjs';

const CYCLES = 4096;

/**
 * Run the create/drain/[destroy] soak. Exported so t9 can drive the no-destroy
 * control against the SAME body.
 * @param {*} tracker a lite-leak tracker
 * @param {number} cycles
 * @param {{destroy?:boolean, keep?:object[], refs?:object[], sampleEvery?:number}} opts
 */
export async function soak(tracker, cycles, opts) {
    const doDestroy = opts.destroy !== false;
    const keep = opts.keep;
    const refs = opts.refs;
    const sampleEvery = opts.sampleEvery === undefined ? 512 : opts.sampleEvery;
    for (let c = 0; c < cycles; c++) {
        const sched = createScheduler({ maxTasks: 8 });
        // cleanup + tag close over NOTHING they track.
        tracker.track(sched, () => {}, 'sched');
        if (refs !== undefined && (c % sampleEvery) === 0) refs.push(new WeakRef(sched));
        for (let i = 0; i < 4; i++) sched.schedule(() => {});
        await drain(sched);
        if (doDestroy) sched.destroy();
        else if (keep !== undefined) keep.push(sched); // retain the leak for the control
        if ((c & 511) === 0) globalThis.gc();
    }
}

export async function run() {
    const tracker = createLeakTracker({ name: 'sched-soak' });
    const refs = [];

    const heapFirst = process.memoryUsage().heapUsed;
    await soak(tracker, CYCLES, { destroy: true, refs });

    // FinalizationRegistry fires after a collection AND a macrotask; settle drives both.
    await settleGc(8);

    check(tracker.size() === 0,
        () => 't7: leak tracker size ' + tracker.size() + ' != 0 after 4096 destroy cycles -- ' +
            'destroy() is not releasing the MessageChannel (schedulers not collected)');

    check(refs.length > 0, () => 't7: census sample was empty (nothing to prove)');
    check(censusOk(refs),
        () => 't7: every sampled destroyed scheduler is still live -- a MessageChannel retention leak');

    // No unbounded upward retention trend across the run.
    globalThis.gc();
    const heapEnd = process.memoryUsage().heapUsed;
    check(heapEnd < heapFirst + 64 * 1024 * 1024,
        () => 't7: heap grew from ' + heapFirst + ' to ' + heapEnd + ' across churn (retention trend)');

    await runFastBit();
}

/** FastBitScheduler soak (section 4.6). */
export async function runFastBit() {
    const NT = 32, CAP = 256;

    // --- fb-4096-fill-drain-cycles: conservation between every cycle ----------
    {
        const q = new FastBitScheduler(CAP, NT);
        for (let c = 0; c < CYCLES; c++) {
            for (let p = 0; p < NT; p += 4) for (let i = 0; i < 8; i++) q.push(c * 1000 + i, p);
            let v; while ((v = q.popMin()) !== -1) { /* drain */ }
            check(fbConserved(q), () => 'fb-4096-fill-drain-cycles: ' + fbConservationReport(q) + ' at cycle ' + c);
        }
        check(q.isEmpty() && q.activeMask === 0 && q.size === 0,
            () => 'fb-4096-fill-drain-cycles: not empty at end (mask ' + q.activeMask + ' size ' + q.size + ')');
    }

    // --- fb-tracker-clears + fb-census: a fresh instance per cycle collects ----
    {
        const tracker = createLeakTracker({ name: 'fastbit-soak' });
        const refs = [];
        for (let c = 0; c < CYCLES; c++) {
            const q = new FastBitScheduler(64, NT);
            // cleanup + tag close over NOTHING they track (held-value contract).
            tracker.track(q, () => {}, 'fastbit');
            if ((c % 512) === 0) refs.push(new WeakRef(q));
            for (let i = 0; i < 16; i++) q.push(i, i % NT);
            let v; while ((v = q.popMin()) !== -1) { /* drain */ }
            if ((c & 511) === 0) globalThis.gc();
        }
        await settleGc(8);
        check(tracker.size() === 0,
            () => 'fb-tracker-clears: tracker size ' + tracker.size() + ' != 0 after ' + CYCLES + ' cycles');
        check(refs.length > 0, () => 'fb-census: census sample empty');
        check(censusOk(refs), () => 'fb-census: every sampled FastBitScheduler is still live (retention)');
    }

    // --- fb-steady-instance-no-growth: one long-lived instance, no growth ------
    {
        const q = new FastBitScheduler(1024, NT);
        const capStart = q.capacity;
        const refStart = [];
        for (let p = 0; p < NT; p++) refStart.push(q.buckets[p]);
        globalThis.gc();
        const heap0 = process.memoryUsage().heapUsed;
        const churn = Int32Array.of(0, 3, 7, 12);
        for (let c = 0; c < CYCLES; c++) {
            for (let i = 0; i < 64; i++) { q.push(i, churn[i & 3]); q.popMin(); }
        }
        globalThis.gc();
        const heap1 = process.memoryUsage().heapUsed;
        check(q.capacity === capStart, () => 'fb-steady-instance-no-growth: capacity changed');
        for (let p = 0; p < NT; p++) check(q.buckets[p] === refStart[p], () => 'fb-steady-instance-no-growth: tier ' + p + ' reallocated');
        check(heap1 - heap0 < 8 * 1024 * 1024,
            () => 'fb-steady-instance-no-growth: heap grew ' + ((heap1 - heap0) / 1048576).toFixed(3) + ' MB');
    }
}
