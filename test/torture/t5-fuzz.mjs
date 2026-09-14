/**
 * t5 -- differential fuzz vs a recorded-order oracle.
 *
 * Seeded schedule patterns across all five priorities are enqueued before a
 * flush, then executed. The executed order must equal the oracle's prediction:
 * a stable sort by priority (Immediate first ... Idle last), FIFO within a lane
 * (see harness.predictOrder). Rounds include a tight-budget + CPU-burn variant
 * to prove budget interruptions never reorder or lose work.
 *
 * The round runner is exported so t9 can feed it a corrupted oracle and prove
 * the comparison has teeth.
 */

import { createScheduler, Priority, FastBitScheduler, EMPTY } from '../../Scheduler.js';
import { check, drain, makePrng, predictOrder, SEED, fbConserved, fbConservationReport } from './harness.mjs';

/**
 * Drive one seeded round and return { executed, predicted }.
 * @param {number} seed
 * @param {{count:number, budgetMs?:number, burn?:boolean}} opts
 */
export async function runRound(seed, opts) {
    const prng = makePrng(seed);
    const count = opts.count;
    const budgetMs = opts.budgetMs === undefined ? 10 : opts.budgetMs;
    const burn = opts.burn === true;
    const sched = createScheduler({ maxTasks: count, onCapacityExceeded: 'grow', budgetMs });
    const items = new Array(count);
    const executed = [];
    for (let i = 0; i < count; i++) {
        const prio = prng() % 5; // valid 0..4 (Immediate..Idle); doors are t1's job
        items[i] = { prio, id: i };
        const id = i;
        if (burn && prio !== Priority.Immediate) {
            sched.schedule(() => {
                const t = performance.now();
                while (performance.now() - t < 0.03) { /* burn */ }
                executed.push(id);
            }, prio);
        } else {
            sched.schedule(() => executed.push(id), prio);
        }
    }
    await drain(sched, 20000);
    sched.destroy();
    return { executed, predicted: predictOrder(items) };
}

/** First index where a and b differ, or -1 when identical (length included). */
export function firstMismatch(a, b) {
    if (a.length !== b.length) return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
    return -1;
}

/**
 * FastBitScheduler differential fuzz round vs a dumb plain-array oracle
 * (section 4.4). Runs `opts.ops` mixed ops (55 push / 35 popMin / 10 peekMin),
 * checking the returned value AND fbConserved after EVERY op. Does NOT die itself
 * -- it returns the recorded value streams and the first divergence, so t9 can
 * feed it a corrupted oracle and prove the comparison has teeth.
 *
 * @param {number} seed
 * @param {{ops:number, numTiers?:number, cap?:number}} opts
 * @returns {{results:number[], oracleResults:number[], conserved:boolean,
 *            mismatch:null|object, conservationFail:null|object, opsRun:number}}
 */
export function runFastBitRound(seed, opts) {
    const prng = makePrng((seed ^ 0xFB01) >>> 0);
    const NT = opts.numTiers === undefined ? 32 : opts.numTiers;
    const CAP = opts.cap === undefined ? 1024 : opts.cap;
    const OPS = opts.ops;

    const q = new FastBitScheduler(CAP, NT);
    const oracle = Array.from({ length: NT }, () => []);
    const oHead = new Int32Array(NT); // per-tier head index (avoids O(n) shift)

    const results = [];        // subject return values, value-returning ops only
    const oracleResults = [];  // aligned oracle return values
    let conserved = true;
    let mismatch = null;
    let conservationFail = null;

    const BOUNDARY = [0, 1, 2147483647];
    let bi = 0;

    let i = 0;
    for (; i < OPS; i++) {
        const roll = prng() % 100;
        let kind = roll < 55 ? 'push' : roll < 90 ? 'popMin' : 'peekMin';
        const p = prng() % NT;

        // Full-tier handling: convert a push into the same tier's full ring into a
        // popMin on BOTH subject and oracle, so they never diverge for a non-bug.
        if (kind === 'push' && q.sizeOf(p) === CAP) kind = 'popMin';

        if (kind === 'push') {
            let handle = prng() >>> 1; // guaranteed non-negative Int32
            if ((i % 9973) === 0) { handle = BOUNDARY[bi % BOUNDARY.length]; bi++; } // boundary injections
            q.push(handle, p);
            oracle[p].push(handle);
        } else if (kind === 'popMin') {
            // oracle popMin: lowest non-empty tier, FIFO
            let mp = -1;
            for (let t = 0; t < NT; t++) if (oHead[t] < oracle[t].length) { mp = t; break; }
            const want = mp === -1 ? EMPTY : oracle[mp][oHead[mp]++];
            const got = q.popMin();
            results.push(got); oracleResults.push(want);
            if (got !== want && mismatch === null) {
                mismatch = { opIndex: i, kind, handle: null, priority: mp, subject: got, oracle: want };
            }
        } else { // peekMin
            let mp = -1;
            for (let t = 0; t < NT; t++) if (oHead[t] < oracle[t].length) { mp = t; break; }
            const want = mp === -1 ? EMPTY : oracle[mp][oHead[mp]];
            const got = q.peekMin();
            results.push(got); oracleResults.push(want);
            if (got !== want && mismatch === null) {
                mismatch = { opIndex: i, kind, handle: null, priority: mp, subject: got, oracle: want };
            }
        }

        if (conserved && !fbConserved(q)) {
            conserved = false;
            conservationFail = { opIndex: i, report: fbConservationReport(q) };
        }
        if (mismatch !== null || !conserved) { i++; break; }
    }

    return { results, oracleResults, conserved, mismatch, conservationFail, opsRun: i };
}

export async function run() {
    // A spread of seeds derived from the run seed, plus a budget-interrupted round.
    const rounds = [
        { seed: (SEED ^ 0x1111) >>> 0, count: 600, budgetMs: 10, burn: false },
        { seed: (SEED ^ 0x2222) >>> 0, count: 800, budgetMs: 10, burn: false },
        { seed: (SEED ^ 0x3333) >>> 0, count: 300, budgetMs: 1, burn: true },
    ];
    for (let r = 0; r < rounds.length; r++) {
        const { executed, predicted } = await runRound(rounds[r].seed, rounds[r]);
        const mm = firstMismatch(executed, predicted);
        check(mm === -1,
            () => 't5 round ' + r + ' (seed ' + rounds[r].seed + '): executed order diverged from ' +
                'the lane-then-FIFO oracle at index ' + mm +
                ' (executed ' + executed[mm] + ', predicted ' + predicted[mm] +
                ', lengths ' + executed.length + '/' + predicted.length + ')');
    }

    // --- FastBit 1M-op differential fuzz vs the plain-array oracle ------------
    const fb = runFastBitRound(SEED, { ops: 1000000, numTiers: 32, cap: 1024 });
    check(fb.mismatch === null,
        () => 't5 fb-fuzz DIVERGED at op ' + fb.mismatch.opIndex + ' (' + fb.mismatch.kind +
            ', tier ' + fb.mismatch.priority + '): subject=' + fb.mismatch.subject +
            ' oracle=' + fb.mismatch.oracle +
            ' -- replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
    check(fb.conserved,
        () => 't5 fb-fuzz conservation broke at op ' + (fb.conservationFail && fb.conservationFail.opIndex) +
            ' -- ' + (fb.conservationFail && fb.conservationFail.report) +
            ' -- replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
    check(fb.opsRun === 1000000, () => 't5 fb-fuzz stopped early at op ' + fb.opsRun);
}
