/**
 * t2 -- adversarial lifecycle. Sequences crafted to break cursors, lanes and the
 * MessageChannel lifecycle. Every scheduler is destroy()ed before the tier ends.
 *
 *   A1 destroy() called from inside a running task -- no crash, later tasks drop.
 *   A2 schedule() during a flush -- picked up, nothing lost, deep chains.
 *   A3 capacity policy x {throw, grow, drop} at the exact boundary.
 *   A4 a bounded Immediate task that self-schedules Immediate work.
 *   A5 yieldTask() resolution order across priorities.
 */

import { createScheduler, Priority, CapacityError } from '../../Scheduler.js';
import { check, drain } from './harness.mjs';

export async function run() {
    // --- A1: destroy() from inside a running task ----------------------------
    {
        const sched = createScheduler();
        let ranFirst = false;
        let ranSecond = false;
        let threw = false;
        sched.schedule(() => { ranFirst = true; sched.destroy(); });
        sched.schedule(() => { ranSecond = true; });
        try {
            await drain(sched, 500);
        } catch {
            // drain times out only if destroy left the scheduler busy; that IS a fail.
            threw = true;
        }
        check(ranFirst, () => 't2 A1: the destroying task did not run');
        check(!ranSecond, () => 't2 A1: a task after in-task destroy() still ran');
        check(!threw, () => 't2 A1: in-task destroy() left the scheduler busy (drain timed out)');
        check(sched.isBusy() === false, () => 't2 A1: scheduler still busy after in-task destroy()');
        sched.destroy();
    }

    // --- A2: schedule() during a flush, deep self-scheduling chain -----------
    {
        const sched = createScheduler();
        let count = 0;
        const step = () => { count++; if (count < 500) sched.schedule(step); };
        sched.schedule(step);
        await drain(sched, 10000);
        check(count === 500, () => 't2 A2: self-scheduling chain lost work (count ' + count + ')');
        sched.destroy();
    }

    // --- A3: capacity policy x {throw, grow, drop} at the boundary -----------
    {
        // throw: the 3rd schedule into a 2-slot pool throws CapacityError.
        const st = createScheduler({ maxTasks: 2, onCapacityExceeded: 'throw' });
        st.schedule(() => {});
        st.schedule(() => {});
        let threw = false;
        try { st.schedule(() => {}); } catch (e) { threw = e instanceof CapacityError; }
        check(threw, () => 't2 A3(throw): the over-capacity schedule did not throw CapacityError');
        st.destroy();

        // drop: the 3rd schedule is silently discarded; only 2 run.
        const sd = createScheduler({ maxTasks: 2, onCapacityExceeded: 'drop' });
        let ran = 0;
        sd.schedule(() => ran++);
        sd.schedule(() => ran++);
        sd.schedule(() => ran++); // dropped
        await drain(sd);
        check(ran === 2, () => 't2 A3(drop): expected 2 tasks to run, saw ' + ran);
        sd.destroy();

        // grow: the pool doubles; all 5 run and poolCapacity grew.
        const sg = createScheduler({ maxTasks: 2, onCapacityExceeded: 'grow' });
        let g = 0;
        for (let i = 0; i < 5; i++) sg.schedule(() => g++);
        check(sg.stats().poolCapacity >= 4, () => 't2 A3(grow): pool did not grow (cap ' + sg.stats().poolCapacity + ')');
        await drain(sg);
        check(g === 5, () => 't2 A3(grow): expected 5 tasks to run, saw ' + g);
        sg.destroy();
    }

    // --- A4: a bounded Immediate task that self-schedules Immediate work ------
    // Documented starvation semantics: Immediate tasks drain fully within one
    // flush, so a self-scheduling Immediate keeps the ring going. Bounded by a
    // counter so it terminates; assert every hop ran, in FIFO.
    {
        const sched = createScheduler();
        const order = [];
        let n = 0;
        const step = () => { order.push(n); n++; if (n < 200) sched.schedule(step, Priority.Immediate); };
        sched.schedule(step, Priority.Immediate);
        await drain(sched, 10000);
        let ok = order.length === 200;
        for (let i = 0; ok && i < 200; i++) if (order[i] !== i) ok = false;
        check(ok, () => 't2 A4: bounded Immediate self-schedule lost or reordered work (' + order.length + ' ran)');
        sched.destroy();
    }

    // --- A5: yieldTask() resolution order across priorities -------------------
    {
        const sched = createScheduler();
        const order = [];
        const a = sched.yieldTask(Priority.Idle).then(() => order.push('idle'));
        const b = sched.yieldTask(Priority.UserInput).then(() => order.push('user'));
        const c = sched.yieldTask(Priority.Normal).then(() => order.push('normal'));
        await Promise.all([a, b, c]);
        check(order[0] === 'user' && order[1] === 'normal' && order[2] === 'idle',
            () => 't2 A5: yieldTask order was [' + order.join(',') + ']');
        sched.destroy();
    }
}
