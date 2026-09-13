/**
 * t0 -- laws. The frame scheduler's ordering + progress guarantees, each proven
 * on a fresh instance that is destroy()ed before the next (MessageChannel ports
 * keep the process alive; a leaked one hangs at exit).
 *
 * Laws:
 *   L1 within one flush: Immediate drains first, then UserInput -> Normal ->
 *      Background -> Idle (strict lane order).
 *   L2 FIFO within a single lane.
 *   L3 FIFO within the Immediate ring.
 *   L4 work scheduled mid-flush still runs (nothing lost).
 *   L5 the budget yield resumes on the next macrotask with nothing lost and the
 *      lane order preserved across the yield.
 */

import { createScheduler, Priority } from '../../Scheduler.js';
import { check, drain } from './harness.mjs';

export async function run() {
    // --- L1: strict lane order within one flush ------------------------------
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('idle'), Priority.Idle);
        sched.schedule(() => order.push('background'), Priority.Background);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        sched.schedule(() => order.push('user'), Priority.UserInput);
        sched.schedule(() => order.push('immediate'), Priority.Immediate);
        await drain(sched);
        check(
            order.length === 5 && order[0] === 'immediate' && order[1] === 'user' &&
            order[2] === 'normal' && order[3] === 'background' && order[4] === 'idle',
            () => 't0 L1: lane order was [' + order.join(',') + ']');
        sched.destroy();
    }

    // --- L2: FIFO within a single lane ---------------------------------------
    {
        const sched = createScheduler();
        const order = [];
        for (let i = 0; i < 64; i++) sched.schedule(() => order.push(i), Priority.Normal);
        await drain(sched);
        let ok = order.length === 64;
        for (let i = 0; ok && i < 64; i++) if (order[i] !== i) ok = false;
        check(ok, () => 't0 L2: FIFO within Normal broke -- [' + order.join(',') + ']');
        sched.destroy();
    }

    // --- L3: FIFO within the Immediate ring ----------------------------------
    {
        const sched = createScheduler();
        const order = [];
        for (let i = 0; i < 64; i++) sched.schedule(() => order.push(i), Priority.Immediate);
        await drain(sched);
        let ok = order.length === 64;
        for (let i = 0; ok && i < 64; i++) if (order[i] !== i) ok = false;
        check(ok, () => 't0 L3: FIFO within Immediate broke -- [' + order.join(',') + ']');
        sched.destroy();
    }

    // --- L4: work scheduled mid-flush still runs -----------------------------
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => {
            order.push('outer');
            sched.schedule(() => order.push('inner'));
            sched.schedule(() => order.push('inner-immediate'), Priority.Immediate);
        });
        await drain(sched);
        check(order.indexOf('outer') === 0 && order.indexOf('inner') > 0 &&
            order.indexOf('inner-immediate') > 0,
            () => 't0 L4: mid-flush schedule lost work -- [' + order.join(',') + ']');
        sched.destroy();
    }

    // --- L5: the budget yield resumes, nothing lost, lane order preserved ----
    {
        const sched = createScheduler({ budgetMs: 1 });
        const order = [];
        // Interleave lanes; each Normal task burns enough to force several yields.
        for (let i = 0; i < 40; i++) {
            sched.schedule(() => {
                const t = performance.now();
                while (performance.now() - t < 0.2) { /* burn */ }
                order.push('n' + i);
            }, Priority.Normal);
        }
        sched.schedule(() => order.push('user'), Priority.UserInput);
        await drain(sched, 10000);
        // UserInput ran before every Normal despite the many budget yields...
        check(order[0] === 'user', () => 't0 L5: UserInput did not preempt Normal across yields -- first was ' + order[0]);
        // ... and all 40 Normal tasks completed in FIFO, none lost to a yield.
        let ok = order.length === 41;
        for (let i = 0; ok && i < 40; i++) if (order[i + 1] !== 'n' + i) ok = false;
        check(ok, () => 't0 L5: budget resume lost or reordered Normal work -- ' + order.length + ' ran');
        sched.destroy();
    }
}
