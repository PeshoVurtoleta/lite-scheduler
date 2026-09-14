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

import { createScheduler, Priority, FastBitScheduler, EMPTY } from '../../Scheduler.js';
import { check, drain, makePrng, SEED, fbConserved, fbConservationReport } from './harness.mjs';

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

    await runFastBit();
}

/**
 * FastBitScheduler laws (section 4.1). Pure sync; no scheduler lifecycle. Every
 * case name is prefixed `fb-` so a failure names the member immediately.
 */
export async function runFastBit() {
    const prng = makePrng((SEED ^ 0xFB00) >>> 0);
    const NT = 32;
    const CAP = 4096;

    // --- fb-min-tier-law: every popMin comes from the lowest non-empty tier ---
    {
        const q = new FastBitScheduler(CAP, NT);
        // A plain-array oracle of per-tier FIFOs to know the true min tier.
        const oracle = Array.from({ length: NT }, () => []);
        let h = 1;
        for (let i = 0; i < 10000; i++) {
            const p = prng() % NT;
            if (q.sizeOf(p) < CAP) { q.push(h, p); oracle[p].push(h); h++; }
            // Interleave pops so tiers empty and refill.
            if ((prng() & 1) === 0) {
                let min = -1;
                for (let t = 0; t < NT; t++) if (oracle[t].length > 0) { min = t; break; }
                const got = q.popMin();
                if (min === -1) { check(got === EMPTY, () => 'fb-min-tier-law: popMin on empty returned ' + got); }
                else {
                    const want = oracle[min].shift();
                    check(got === want, () => 'fb-min-tier-law: expected handle ' + want + ' from tier ' + min + ', got ' + got);
                }
            }
        }
    }

    // --- fb-fifo-within-tier: pop order equals push order, exactly -------------
    {
        const q = new FastBitScheduler(64, NT);
        for (let i = 0; i < 64; i++) q.push(1000 + i, 7);
        for (let i = 0; i < 64; i++) check(q.popMin() === 1000 + i, () => 'fb-fifo-within-tier broke at ' + i);
    }

    // --- fb-metamorphic-merge: interleaving pushes cannot change the output ----
    {
        const a = 3, b = 9; // a < b
        const X = [10, 11, 12, 13, 14];
        const Y = [20, 21, 22];
        // Interleave the pushes arbitrarily (seeded), but keep per-tier order.
        const q = new FastBitScheduler(64, NT);
        let xi = 0, yi = 0;
        while (xi < X.length || yi < Y.length) {
            const pickX = yi >= Y.length || (xi < X.length && (prng() & 1) === 0);
            if (pickX) q.push(X[xi++], a); else q.push(Y[yi++], b);
        }
        const drainOut = [];
        let v; while ((v = q.popMin()) !== EMPTY) drainOut.push(v);
        const merged = X.concat(Y); // tier a's whole FIFO, then tier b's
        check(drainOut.length === merged.length && drainOut.every((x, i) => x === merged[i]),
            () => 'fb-metamorphic-merge: drain [' + drainOut.join(',') + '] != X++Y [' + merged.join(',') + ']');
    }

    // --- fb-peek-equals-pop: peekMin equals next popMin, leaves state unchanged -
    {
        const q = new FastBitScheduler(CAP, NT);
        for (let i = 0; i < 10000; i++) {
            const p = prng() % NT;
            if (q.sizeOf(p) < CAP) q.push((prng() >>> 1) || 1, p);
            if (!q.isEmpty() && (prng() & 1) === 0) {
                const sz = q.size, am = q.activeMask, pk = q.peekMin();
                check(q.size === sz && q.activeMask === am,
                    () => 'fb-peek-equals-pop: peekMin mutated state at ' + i);
                check(pk === q.popMin(), () => 'fb-peek-equals-pop: peekMin != next popMin at ' + i);
            }
        }
    }

    // --- fb-empty-triad: isEmpty <=> activeMask===0 <=> size===0 --------------
    {
        const q = new FastBitScheduler(CAP, NT);
        for (let i = 0; i < 10000; i++) {
            if ((prng() & 3) !== 0) { const p = prng() % NT; if (q.sizeOf(p) < CAP) q.push((prng() >>> 1) || 1, p); }
            else q.popMin();
            const e = q.isEmpty();
            check(e === (q.activeMask === 0), () => 'fb-empty-triad: isEmpty != (activeMask===0) at ' + i + ' mask=' + q.activeMask);
            check(e === (q.size === 0), () => 'fb-empty-triad: isEmpty != (size===0) at ' + i);
            // never assert activeMask > 0 -- the sign bit makes a live tier-31 mask negative
            if (!e) check(q.activeMask !== 0, () => 'fb-empty-triad: non-empty but mask 0 at ' + i);
        }
    }

    // --- fb-handle-roundtrip-boundaries: 0, 1, 2^31-1 round-trip bit-exact -----
    {
        const q = new FastBitScheduler(16, NT);
        const boundary = [0, 1, 2147483647];
        for (let p = 0; p < NT; p += 7) {
            for (const bnd of boundary) q.push(bnd, p);
        }
        for (let p = 0; p < NT; p += 7) {
            for (const bnd of boundary) check(q.popMin() === bnd, () => 'fb-handle-roundtrip: ' + bnd + ' did not round-trip on tier ' + p);
        }
    }

    // --- fb-peek-priority-law: peekPriority == next pop tier; -1 when empty ----
    {
        const q = new FastBitScheduler(64, NT);
        check(q.peekPriority() === -1, () => 'fb-peek-priority-law: empty peekPriority != -1');
        q.push(5, 12); q.push(6, 4); q.push(7, 30);
        check(q.peekPriority() === 4, () => 'fb-peek-priority-law: expected 4, got ' + q.peekPriority());
        q.popMin();
        check(q.peekPriority() === 12, () => 'fb-peek-priority-law: expected 12, got ' + q.peekPriority());
        q.popMin();
        check(q.peekPriority() === 30, () => 'fb-peek-priority-law: expected 30, got ' + q.peekPriority());
        q.popMin();
        check(q.peekPriority() === -1, () => 'fb-peek-priority-law: drained peekPriority != -1');
    }

    // --- fb-conservation-after-every-op: fbConserved after each of 10k ops -----
    {
        const q = new FastBitScheduler(CAP, NT);
        for (let i = 0; i < 10000; i++) {
            if ((prng() % 3) !== 0) { const p = prng() % NT; if (q.sizeOf(p) < CAP) q.push((prng() >>> 1) || 1, p); }
            else q.popMin();
            check(fbConserved(q), () => 'fb-conservation-after-every-op at op ' + i + ' -- ' + fbConservationReport(q));
        }
    }
}
