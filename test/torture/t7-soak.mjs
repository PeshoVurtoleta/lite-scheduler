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
import { createScheduler } from '../../Scheduler.js';
import { check, drain, censusOk, settleGc } from './harness.mjs';

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
}
