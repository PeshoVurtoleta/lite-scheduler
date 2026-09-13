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

import { createScheduler, Priority } from '../../Scheduler.js';
import { check, drain, makePrng, predictOrder, SEED } from './harness.mjs';

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
}
