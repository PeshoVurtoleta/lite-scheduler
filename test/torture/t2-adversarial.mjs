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

import { createScheduler, Priority, CapacityError, FastBitScheduler, EMPTY } from '../../Scheduler.js';
import { check, drain, makePrng, SEED, fbConserved, fbConservationReport } from './harness.mjs';

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

    runFastBit();
}

/** FastBitScheduler abuse sequences (section 4.3). */
export function runFastBit() {
    const prng = makePrng((SEED ^ 0xFB02) >>> 0);

    // --- fb-wrap-churn-cap-plus-1-laps: head/tail each lap the ring > once -----
    {
        const cap = 8;
        const q = new FastBitScheduler(cap, 32);
        let next = 0, expect = 0;
        const pairs = (cap + 1) * cap; // > cap laps
        for (let i = 0; i < pairs; i++) {
            q.push(next++, 5);
            check(q.popMin() === expect++, () => 'fb-wrap-churn: FIFO broke at pair ' + i);
            check(fbConserved(q), () => 'fb-wrap-churn: ' + fbConservationReport(q));
        }
        check(q.isEmpty(), () => 'fb-wrap-churn: not empty after churn');
    }

    // --- fb-fill-throw-drain-refill (D-08 regression) -------------------------
    {
        const cap = 4;
        const q = new FastBitScheduler(cap, 32);
        for (let i = 0; i < cap; i++) q.push(i, 6);
        check(q.sizeOf(6) === cap, () => 'fb-fill-throw-drain-refill: tier not full');
        let threw = false; try { q.push(999, 6); } catch { threw = true; }
        check(threw, () => 'fb-fill-throw-drain-refill: over-capacity push did not throw');
        for (let i = 0; i < cap; i++) check(q.popMin() === i, () => 'fb-fill-throw-drain-refill: first drain not FIFO at ' + i);
        for (let i = 100; i < 100 + cap; i++) q.push(i, 6);
        for (let i = 100; i < 100 + cap; i++) check(q.popMin() === i, () => 'fb-fill-throw-drain-refill: refill drain not FIFO at ' + i);
    }

    // --- fb-all-32-tiers-saturated -------------------------------------------
    {
        const cap = 4, nt = 32;
        const q = new FastBitScheduler(cap, nt);
        for (let p = 0; p < nt; p++) for (let i = 0; i < cap; i++) q.push(p * 1000 + i, p);
        check(q.size === nt * cap, () => 'fb-all-32-tiers-saturated: size ' + q.size + ' != ' + nt * cap);
        for (let p = 0; p < nt; p++) for (let i = 0; i < cap; i++) {
            check(q.popMin() === p * 1000 + i, () => 'fb-all-32-tiers-saturated: drain order broke at tier ' + p + ' i ' + i);
        }
        check(q.isEmpty() && q.activeMask === 0, () => 'fb-all-32-tiers-saturated: not empty at end (mask ' + q.activeMask + ')');
    }

    // --- fb-tier-31-alone: the sign bit is the trap --------------------------
    {
        const q = new FastBitScheduler(16, 32);
        q.push(77, 31); q.push(78, 31);
        check(q.activeMask === -2147483648, () => 'fb-tier-31-alone: activeMask ' + q.activeMask + ' != -2147483648');
        check(q.activeMask < 0, () => 'fb-tier-31-alone: mask not negative');
        check(q.peekMin() === 77 && q.peekPriority() === 31, () => 'fb-tier-31-alone: peek wrong');
        check(q.sizeOf(31) === 2 && q.size === 2, () => 'fb-tier-31-alone: size wrong');
        check(fbConserved(q), () => 'fb-tier-31-alone: ' + fbConservationReport(q));
        check(q.popMin() === 77 && q.popMin() === 78, () => 'fb-tier-31-alone: pop order wrong');
        check(q.isEmpty(), () => 'fb-tier-31-alone: not empty after drain');
        q.push(9, 31); q.clear();
        check(q.isEmpty() && q.activeMask === 0 && q.size === 0, () => 'fb-tier-31-alone: clear left state');
    }

    // --- fb-alternating-0-and-31: tier 0 always wins even with bit 31 set ------
    {
        const q = new FastBitScheduler(4096, 32);
        let h = 1;
        for (let i = 0; i < 10000; i++) {
            q.push(h++, 0);
            q.push(h++, 31);
            if ((prng() & 1) === 0) {
                // Both tiers are always non-empty here; odd handles went to tier 0,
                // even handles to tier 31, so the min-tier pop must be odd (tier 0).
                const got = q.popMin();
                check(got % 2 === 1, () => 'fb-alternating-0-and-31: popped an even handle (tier 31) while tier 0 had work, at ' + i + ' got ' + got);
            }
            if (q.sizeOf(0) > 4000 || q.sizeOf(31) > 4000) { q.clear(); h = 1; }
        }
    }

    // --- fb-pop-empty-storm: 100k popMin on empty, nothing moves --------------
    {
        const q = new FastBitScheduler(16, 32);
        for (let i = 0; i < 100000; i++) {
            check(q.popMin() === EMPTY, () => 'fb-pop-empty-storm: popMin != EMPTY at ' + i);
        }
        check(q.activeMask === 0 && q.size === 0, () => 'fb-pop-empty-storm: state moved');
    }

    // --- fb-clear-midchurn-is-idempotent (buckets same reference) -------------
    {
        const q = new FastBitScheduler(16, 32);
        const refs = [];
        for (let p = 0; p < q.numTiers; p++) refs.push(q.buckets[p]);
        for (let i = 0; i < 50; i++) q.push(i, i % 32);
        q.clear();
        check(q.isEmpty() && q.size === 0 && q.activeMask === 0, () => 'fb-clear-midchurn: first clear did not empty');
        q.clear(); // idempotent
        check(q.isEmpty() && q.size === 0, () => 'fb-clear-midchurn: second clear changed something');
        for (let p = 0; p < q.numTiers; p++) check(q.buckets[p] === refs[p], () => 'fb-clear-midchurn: tier ' + p + ' reallocated');
        // Usable afterwards; FIFO restarts cleanly.
        q.push(500, 3); q.push(501, 3);
        check(q.popMin() === 500 && q.popMin() === 501, () => 'fb-clear-midchurn: FIFO did not restart');
    }

    // --- fb-throw-leaves-state-untouched -------------------------------------
    {
        const q = new FastBitScheduler(2, 32); // cap 2 per tier
        q.push(10, 4); q.push(12, 4);          // tier 4 now full (2 == cap)
        q.push(11, 7);
        const snap = () => JSON.stringify({ size: q.size, mask: q.activeMask, h: Array.from(q.heads), t: Array.from(q.tails), c: Array.from(q.counts) });
        const before = snap();
        // A door throw (bad item, bad priority, full tier) must leave state bit-identical.
        try { q.push(-1, 4); } catch {}   // bad item
        check(snap() === before, () => 'fb-throw-leaves-state-untouched: bad-item throw mutated state');
        try { q.push(5, 99); } catch {}   // bad priority
        check(snap() === before, () => 'fb-throw-leaves-state-untouched: bad-priority throw mutated state');
        try { q.push(14, 4); } catch {}   // full tier
        check(snap() === before, () => 'fb-throw-leaves-state-untouched: full-tier throw mutated state');
    }
}
