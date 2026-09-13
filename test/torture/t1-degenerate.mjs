/**
 * t1 -- degenerate (the doors). Every finding S-01..S-04 from ROADMAP section 2,
 * pinned by name. This tier PINS TODAY's verified behavior: it must PASS today.
 * Each case carries an `F1 FLIPS THIS` comment stating what the documented
 * contract says the behavior SHOULD become in F1. When F1 lands the door, these
 * pins flip to the enforced-contract assertions.
 *
 * The reproduction recipes are the executed probes from ROADMAP section 2.
 */

import { createScheduler, Priority } from '../../Scheduler.js';
import { check, drain } from './harness.mjs';

export async function run() {
    // --- S-01: a NaN priority jumps the queue into the UserInput lane --------
    // Recipe: schedule a Normal task, then a NaN task -> the NaN task executes
    // FIRST. `(NaN < 1 || NaN > 4)` is false, so NaN slides past coercion, and
    // `(NaN - 1) | 0 === 0` routes it to SLL index 0 = UserInput.
    // F1 FLIPS THIS: the documented contract says out-of-range values (NaN
    // included) coerce to Normal -- the NaN task must then run AFTER the Normal
    // one, never preempt it.
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('normal-first'), Priority.Normal);
        sched.schedule(() => order.push('nan'), NaN);
        await drain(sched);
        check(order[0] === 'nan',
            () => 't1 S-01: NaN priority did NOT preempt Normal (order [' + order.join(',') + ']) -- ' +
                'todays behavior changed');
        sched.destroy();
    }

    // --- S-02: in-range fractional priorities truncate to the lane below ------
    // Recipe: schedule a task at 3.7, then a Normal task -> executed
    // ["normal","frac3.7"]. 3.7 passes the range check, then `(3.7 - 1) | 0 === 2`
    // routes it to SLL index 2 = Background (a demotion below Normal).
    // F1 FLIPS THIS: the docs state only integer Priority constants exist; a
    // fractional priority must coerce to Normal, so frac3.7 should share the
    // Normal lane and run in schedule order, not demote to Background.
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('frac3.7'), 3.7);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        await drain(sched);
        check(order[0] === 'normal' && order[1] === 'frac3.7',
            () => 't1 S-02: 3.7 did NOT truncate to Background (order [' + order.join(',') + ']) -- ' +
                'todays behavior changed');
        sched.destroy();
    }

    // --- S-03: a non-callable onError detonates as an uncaughtException -------
    // Recipe: createScheduler({ onError: 'x' }) + a throwing task -> the first
    // task error is passed to the (non-callable) sink, which throws
    // "onError is not a function" from inside the flush loop as an
    // uncaughtException -- far from the config mistake.
    // F1 FLIPS THIS: config.onError must be validated at construction; a
    // non-callable sink throws a library-named error at createScheduler(), not
    // a deferred uncaughtException at flush time.
    await new Promise((resolve) => {
        const prev = process.listeners('uncaughtException');
        process.removeAllListeners('uncaughtException');
        let caught = null;
        const handler = (e) => { caught = e; };
        process.on('uncaughtException', handler);

        const sched = createScheduler({ onError: 'x' }); // non-callable: accepted today
        sched.schedule(() => { throw new Error('boom'); });

        setTimeout(() => {
            process.removeListener('uncaughtException', handler);
            for (const p of prev) process.on('uncaughtException', p);
            check(caught !== null && /onError is not a function/.test(String(caught && caught.message)),
                () => 't1 S-03: a non-callable onError did NOT surface as ' +
                    '"onError is not a function" (caught ' + String(caught) + ') -- todays behavior changed');
            sched.destroy();
            resolve();
        }, 60);
    });

    // --- S-04: schedule(null) is accepted; the TypeError is deferred to flush -
    // Recipe: schedule(null) -> accepted at the door; at flush time `fn()` throws
    // a TypeError that is caught and routed to onError. Deferred, disconnected
    // from the caller's stack.
    // F1 FLIPS THIS: a non-callable task must throw a TypeError at schedule()
    // (the caller's stack), not silently enqueue and fail later in the flush.
    {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push(err) });
        // Accepted at the door today -- no throw here.
        let threwAtDoor = false;
        try { sched.schedule(null); } catch { threwAtDoor = true; }
        check(!threwAtDoor, () => 't1 S-04: schedule(null) threw at the door -- todays behavior changed');
        await drain(sched);
        check(errors.length === 1 && errors[0] instanceof TypeError,
            () => 't1 S-04: schedule(null) did NOT defer a TypeError to onError (got ' +
                errors.length + ' errors) -- todays behavior changed');
        sched.destroy();
    }
}
