/**
 * @zakkster/lite-scheduler -- the perf gate (the SYNC lanes).
 *
 * Division of labour (ROADMAP section 3, "The perf gate"):
 *   - torture t6 owns the ASYNC schedule->flush lane (macrotask-driven).
 *   - THIS file owns the SYNC lanes: hot paths called N and k*N times in one
 *     synchronous window, gated by @zakkster/lite-perf-gate on scavenge scaling
 *     (~0 at both scales) and on each scenario's own custom counters (delta 0).
 *
 * Run with (perf-gate llms.txt / PerfGate.d.ts):
 *     node --expose-gc --max-semi-space-size=4 --test test/perf.test.mjs
 *
 * Every gated value stays at the instrument's documented default; nothing is
 * overridden and no opt-out is used anywhere in this file (intentionally, so the
 * gate cannot be softened -- see the A9 grep). Two independent suites: the frame
 * scheduler's enqueue lane, and the FastBitScheduler sync lane. They are kept
 * SEPARATE because perf-gate's counter lane fails closed on a counter key a
 * scenario did not measure, and the two members report different counters.
 */

import test from 'node:test';
import { zgcSuite } from '@zakkster/lite-perf-gate';
import { createScheduler, FastBitScheduler } from '../Scheduler.js';

// ============================================================
// Suite 1 -- the frame scheduler's sync enqueue lane (UNCHANGED from F1).
// ============================================================

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

// Heap-settle between the two suites: they share one process heap, so suite 1's
// churn residue can otherwise poison suite 2's negative-control window (the
// detector then reads stale young-gen scavenges and refuses to judge). A forced
// collection plus a flush tick between the suites clears it. This is hygiene, not
// a gate: it registers between the two suites' node:test cases (which run in
// source order) and touches no threshold and no scenario.
test('heap settle between the two perf suites (hygiene, not a gate)', async () => {
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 250));
    globalThis.gc?.();
});

// ============================================================
// Suite 2 -- the FastBitScheduler sync lane. Same defaults, nothing overridden.
// Separate suite (see the header): the counter lane fails closed on a counter
// key a scenario did not measure, and these scenarios report different counters
// than the frame scheduler's.
// ============================================================

// Corrected bounded workload (orchestrator note 1): residents in tiers 19 and 31
// keep high mask bits set (incl. the sign bit) so popMin runs against a multi-bit
// mask every iteration; the churn tiers cycle 0,3,7,12 at single occupancy (each
// pair drains what it pushed) so no tier ever approaches capacity. size is
// constant (16) across the window.
function fbSetup() {
    const q = new FastBitScheduler(1024, 32);
    for (let i = 0; i < 8; i++) { q.push(i, 19); q.push(i, 31); }
    const churn = Int32Array.of(0, 3, 7, 12);
    const handles = new Int32Array(1024);
    for (let i = 0; i < 1024; i++) handles[i] = i;
    return { q, churn, handles, ring: new Array(64) };
}

// Sum of every backing store's byteLength. Runs OUTSIDE the window (statsOf), so
// its loop costs the subject nothing. Delta gated at 0: the rings never grow.
function fbBucketBytes(q) {
    let sum = 0;
    for (let p = 0; p < q.numTiers; p++) sum += q.buckets[p].byteLength;
    return sum + q.heads.byteLength + q.tails.byteLength + q.counts.byteLength;
}

const fbChurn = {
    name: 'fastbit-push-popmin-churn',
    setup: fbSetup,
    hot: (st, n) => {
        const q = st.q, h = st.handles, c = st.churn;
        for (let i = 0; i < n; i++) { q.push(h[i & 1023], c[i & 3]); q.popMin(); }
    },
    statsOf: (st) => ({ bucketBytes: fbBucketBytes(st.q), fbSize: st.q.size }),
    teardown: (st) => st.q.clear(),
};

// The door-cost path: the same pair plus one sizeOf(19) per iteration, exercising
// the sizeOf door's passing side. All values are legal; nothing ever throws.
const fbDoorCost = {
    name: 'fastbit-door-cost',
    setup: fbSetup,
    hot: (st, n) => {
        const q = st.q, h = st.handles, c = st.churn;
        for (let i = 0; i < n; i++) { q.push(h[i & 1023], c[i & 3]); q.popMin(); q.sizeOf(19); }
    },
    statsOf: (st) => ({ bucketBytes: fbBucketBytes(st.q), fbSize: st.q.size }),
    teardown: (st) => st.q.clear(),
};

// mustFail: a real per-iteration heap record into a bounded 64-slot ring (recipe
// 6 shape: it escapes AND dies young, so escape analysis and pretenuring cannot
// make it invisible), plus the same churn pair. The run is green only when this
// scenario trips the gate.
const fbPerIterationAlloc = {
    name: 'fastbit-per-iteration-alloc',
    setup: fbSetup,
    hot: (st, n) => {
        const q = st.q, h = st.handles, c = st.churn, ring = st.ring;
        for (let i = 0; i < n; i++) {
            ring[i & 63] = { p: c[i & 3], h: h[i & 1023], i, t: 0 };
            q.push(h[i & 1023], c[i & 3]);
            q.popMin();
        }
    },
    teardown: (st) => st.q.clear(),
};

zgcSuite({
    scenarios: [fbChurn, fbDoorCost],
    counters: { bucketBytes: 0, fbSize: 0 },
    mustFail: [fbPerIterationAlloc],
});
