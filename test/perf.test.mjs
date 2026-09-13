/**
 * @zakkster/lite-scheduler -- the perf gate (the SYNC enqueue lane).
 *
 * Division of labour (ROADMAP section 3, "The perf gate"):
 *   - torture t6 owns the ASYNC schedule->flush lane (macrotask-driven, gated
 *     on majorsPerKOp / maxPauseMsPerOp + a heap-growth soak + pool byte-identity).
 *   - THIS file owns the SYNC enqueue lane: schedule() called N and k*N times in
 *     one synchronous window, gated by @zakkster/lite-perf-gate on scavenge
 *     scaling (~0 at both scales) and on the scheduler's own poolCapacity /
 *     immediateCapacity counters (delta 0).
 *
 * Run with (perf-gate llms.txt:92 / PerfGate.d.ts:181):
 *     node --expose-gc --max-semi-space-size=4 --test test/perf.test.mjs
 *
 * Every threshold is a documented perf-gate default (maxScavenges 2,
 * maxRetainedKB 64, maxOldGen 0, maxArrayBuffersKB 64, N 200000, k 8,
 * flushMs 100). None is overridden. allowNoGc / allowEmpty never appear.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { createScheduler } from '../Scheduler.js';

// Shared setup: a pre-sized pool with the 'drop' policy so the window stays
// allocation-free once the pool is full (Scheduler.js `if (policy === "drop")
// return;` fires before any grow), which is also what makes poolCapacity
// provably constant. Priorities come from an Int32Array (SMI) so no boxed
// HeapNumber is charged to the subject.
function setup() {
    const s = createScheduler({ maxTasks: 4096, onCapacityExceeded: 'drop', budgetMs: 10, onError: () => {} });
    const noop = () => {};
    const prio = Int32Array.of(1, 2, 3, 4, 99, -1, 2, 2);
    return { s, noop, prio };
}

// The ONLY code in the measurement window. Both new door branches
// (typeof fn, (priority | 0) !== priority) execute on every iteration.
const enqueueDoor = {
    name: 'enqueue-door',
    setup,
    hot: (st, n) => {
        const s = st.s, noop = st.noop, p = st.prio;
        for (let i = 0; i < n; i++) s.schedule(noop, p[i & 7]);
    },
    statsOf: (st) => ({
        poolCapacity: st.s.stats().poolCapacity,
        immediateCapacity: st.s.stats().immediateCapacity,
    }),
    teardown: (st) => st.s.destroy(),
};

// mustFail: a real per-iteration closure allocation (recipe 6). The run is
// green only when this scenario trips the gate.
const perIterationClosure = {
    name: 'enqueue-per-iteration-closure',
    setup,
    hot: (st, n) => {
        const s = st.s;
        for (let i = 0; i < n; i++) s.schedule(() => i);
    },
    teardown: (st) => st.s.destroy(),
};

zgcSuite({
    scenarios: [enqueueDoor],
    counters: { poolCapacity: 0, immediateCapacity: 0 },
    mustFail: [perIterationClosure],
});
