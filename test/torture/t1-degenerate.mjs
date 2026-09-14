/**
 * t1 -- degenerate (the doors). Every finding S-01..S-04 from ROADMAP section 2,
 * pinned by name. As of F1 (v1.0.3) this tier asserts the ENFORCED contract:
 * every non-integer / out-of-range priority coerces to Normal, a non-callable
 * onError is rejected at construction, a non-function task throws a TypeError at
 * the schedule() door, and an unknown config key is rejected. RED-FIRST: these
 * assertions were run against the undoored v1.0.2 and failed before the doors
 * landed (see the F1 session log).
 */

import { createScheduler, Priority, FastBitScheduler, EMPTY } from '../../Scheduler.js';
import { check, drain } from './harness.mjs';

/** True iff fn() throws. */
function throws(fn) { try { fn(); return false; } catch { return true; } }

/**
 * Exported for t9 C4. Returns null when the item door bites on every bad item,
 * or a violation string when a bad item was accepted (the door is toothless).
 * The bad set is exactly the coercion classes an Int32Array store would swallow
 * silently (an object/null/undefined/NaN -> 0, '7' -> 7, 1.5 -> 1, 2**31 -> wrap,
 * -1 collides with EMPTY). A correct door throws on all of them.
 */
export function checkItemDoor(q) {
    const bad = [-1, {}, NaN, 1.5, 2 ** 31, '7', null, undefined];
    for (let i = 0; i < bad.length; i++) {
        if (!throws(() => q.push(bad[i], 0))) {
            return 'item door accepted ' + String(bad[i]) + ' (index ' + i + ')';
        }
    }
    return null;
}

/**
 * Exported for reuse. Returns null when the capacity door throws on every bad
 * capacity AND accepts 2**24 exactly (the inclusive ceiling), or a violation
 * string otherwise.
 */
export function checkCapacityDoor(Ctor) {
    const bad = [2 ** 31, 2 ** 24 + 1, 0, -5, NaN, 1.5, Infinity, '1024', null];
    for (let i = 0; i < bad.length; i++) {
        if (!throws(() => new Ctor(bad[i]))) return 'capacity door accepted ' + String(bad[i]);
    }
    if (throws(() => new Ctor(2 ** 24))) return 'capacity door rejected 2**24 (the inclusive ceiling)';
    return null;
}

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

    runFastBit();
}

/** FastBitScheduler doors (section 4.2). Every D door, fail closed + legibly. */
export function runFastBit() {
    // --- fb-door-item-negative -----------------------------------------------
    {
        const q = new FastBitScheduler(16, 32);
        for (let p = 0; p < 32; p += 5) {
            check(throws(() => q.push(-1, p)), () => 'fb-door-item-negative: push(-1,' + p + ') did not throw');
            check(throws(() => q.push(-2, p)), () => 'fb-door-item-negative: push(-2,' + p + ') did not throw');
            check(throws(() => q.push(-2147483648, p)), () => 'fb-door-item-negative: push(-2147483648,' + p + ') did not throw');
        }
    }

    // --- fb-door-item-{object,nan,fraction,2pow31,string,null,undefined,bigint}
    {
        const q = new FastBitScheduler(16, 32);
        const v = checkItemDoor(q); // object/nan/fraction/2pow31/string/null/undefined
        check(v === null, () => 'fb-door-item-coercion: ' + v);
        check(throws(() => q.push(10n, 0)), () => 'fb-door-item-bigint: push(10n,0) did not throw');
    }

    // --- fb-door-priority-out-of-range (positive control; still a gate) -------
    {
        const q = new FastBitScheduler(16, 32);
        for (const p of [32, -1, 1.5, NaN, Infinity, '0', null]) {
            check(throws(() => q.push(1, p)), () => 'fb-door-priority-out-of-range: push(1,' + String(p) + ') did not throw');
        }
    }

    // --- fb-door-capacity-* (2**24 accepted; the ceiling is inclusive) --------
    {
        const v = checkCapacityDoor(FastBitScheduler);
        check(v === null, () => 'fb-door-capacity: ' + v);
    }

    // --- fb-door-numTiers-* (1,33,0,-1,2.5,NaN,'8',null throw; 2 and 32 ok) ----
    {
        for (const n of [1, 33, 0, -1, 2.5, NaN, '8', null]) {
            check(throws(() => new FastBitScheduler(64, n)), () => 'fb-door-numTiers: new FastBitScheduler(64,' + String(n) + ') did not throw');
        }
        check(!throws(() => new FastBitScheduler(64, 2)), () => 'fb-door-numTiers: numTiers 2 was rejected');
        check(!throws(() => new FastBitScheduler(64, 32)), () => 'fb-door-numTiers: numTiers 32 was rejected');
    }

    // --- fb-door-sizeOf-* (never returns undefined) ---------------------------
    {
        const q = new FastBitScheduler(16, 32);
        for (const p of [32, -1, 1.5, NaN, '0', undefined]) {
            check(throws(() => q.sizeOf(p)), () => 'fb-door-sizeOf: sizeOf(' + String(p) + ') did not throw');
        }
        check(q.sizeOf(0) === 0, () => 'fb-door-sizeOf: sizeOf(0) on empty tier != 0');
    }

    // --- fb-door-error-messages-name-the-library ------------------------------
    {
        const q = new FastBitScheduler(16, 8);
        const msgs = [];
        const grab = (fn) => { try { fn(); } catch (e) { msgs.push(String(e && e.message)); } };
        grab(() => q.push(1, 8));       // bad priority
        grab(() => q.push(-1, 0));      // bad item
        grab(() => new FastBitScheduler(0)); // bad capacity
        grab(() => new FastBitScheduler(64, 1)); // bad numTiers
        grab(() => q.sizeOf(99));       // bad sizeOf
        // fill a tier and overflow it for the full-tier message
        const f = new FastBitScheduler(2, 8);
        f.push(1, 0); f.push(2, 0);
        grab(() => f.push(3, 0));       // full tier
        check(msgs.length === 6, () => 'fb-door-error-messages: expected 6 throws, saw ' + msgs.length);
        for (const m of msgs) check(m.startsWith('lite-scheduler:'), () => 'fb-door-error-messages: message does not start "lite-scheduler:" -- ' + m);
    }

    // --- fb-empty-returns-EMPTY ----------------------------------------------
    {
        const q = new FastBitScheduler(16, 32);
        check(q.popMin() === EMPTY, () => 'fb-empty-returns-EMPTY: popMin() on empty != EMPTY');
        check(q.peekMin() === EMPTY, () => 'fb-empty-returns-EMPTY: peekMin() on empty != EMPTY');
        check(q.peekPriority() === -1, () => 'fb-empty-returns-EMPTY: peekPriority() on empty != -1');
        check(EMPTY === -1, () => 'fb-empty-returns-EMPTY: EMPTY is not -1');
    }
}
