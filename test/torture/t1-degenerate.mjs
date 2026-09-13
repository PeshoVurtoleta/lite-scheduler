/**
 * t1 -- degenerate (the doors). Every finding S-01..S-04 from ROADMAP section 2,
 * pinned by name. As of F1 (v1.0.3) this tier asserts the ENFORCED contract:
 * every non-integer / out-of-range priority coerces to Normal, a non-callable
 * onError is rejected at construction, a non-function task throws a TypeError at
 * the schedule() door, and an unknown config key is rejected. RED-FIRST: these
 * assertions were run against the undoored v1.0.2 and failed before the doors
 * landed (see the F1 session log).
 */

import { createScheduler, Priority } from '../../Scheduler.js';
import { check, drain } from './harness.mjs';

export async function run() {
    // --- S-01: a NaN priority must NOT preempt Normal ------------------------
    // The documented contract coerces out-of-range values (NaN included) to
    // Normal, so the NaN task runs AFTER the earlier Normal one, never before.
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('normal-first'), Priority.Normal);
        sched.schedule(() => order.push('nan'), NaN);
        await drain(sched);
        check(order[0] === 'normal-first' && order[1] === 'nan',
            () => 't1 S-01: NaN priority preempted Normal (order [' + order.join(',') + ']) -- ' +
                'a malformed priority must coerce to Normal, not jump the UserInput lane');
        sched.destroy();
    }

    // --- S-02: an in-range fractional priority coerces to Normal -------------
    // 3.7 is not an integer, so it coerces to Normal and shares the Normal lane,
    // running in schedule order -- never demoted to Background by truncation.
    {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('frac3.7'), 3.7);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        await drain(sched);
        check(order[0] === 'frac3.7' && order[1] === 'normal',
            () => 't1 S-02: 3.7 did NOT coerce to Normal (order [' + order.join(',') + ']) -- ' +
                'a fractional priority must share the Normal lane, not truncate to Background');
        sched.destroy();
    }

    // --- S-03: a non-callable onError is rejected at construction ------------
    // createScheduler({ onError: 'x' }) throws a library-named error at the
    // constructor -- not a deferred uncaughtException at flush time. No task
    // ever runs, because no scheduler is ever built.
    {
        let threw = false;
        let ran = false;
        try {
            const sched = createScheduler({ onError: 'x' });
            sched.schedule(() => { ran = true; });
            sched.destroy();
        } catch (e) {
            threw = /lite-scheduler: onError/.test(String(e && e.message));
        }
        check(threw,
            () => 't1 S-03: createScheduler({ onError: "x" }) did NOT throw a ' +
                '/lite-scheduler: onError/ error at construction');
        check(!ran,
            () => 't1 S-03: a task ran despite a non-callable onError -- construction must fail closed');
    }

    // --- S-04: a non-function task throws a TypeError at the door ------------
    // schedule(null) throws a TypeError synchronously, on the caller's stack,
    // before any pool touch. Nothing reaches onError.
    {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push(err) });
        let threwAtDoor = false;
        let caughtIsTypeError = false;
        try {
            sched.schedule(null);
        } catch (e) {
            threwAtDoor = true;
            caughtIsTypeError = e instanceof TypeError;
        }
        check(threwAtDoor === true && caughtIsTypeError,
            () => 't1 S-04: schedule(null) did NOT throw a TypeError at the door ' +
                '(threwAtDoor=' + threwAtDoor + ' caughtIsTypeError=' + caughtIsTypeError + ')');
        await drain(sched);
        check(errors.length === 0,
            () => 't1 S-04: a rejected task reached onError (' + errors.length + ' errors) -- ' +
                'the TypeError must land at the call site, never at flush time');
        sched.destroy();
    }

    // --- unknown config key: rejected at construction, naming the near key ----
    {
        let threw = false;
        try {
            createScheduler({ maxTask: 5000 });
        } catch (e) {
            threw = /maxTasks/.test(String(e && e.message));
        }
        check(threw,
            () => 't1 config: createScheduler({ maxTask: 5000 }) did NOT throw a ' +
                '/maxTasks/ error -- an unknown config key must be rejected with a hint');
    }
}
