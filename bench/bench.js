/**
 * @zakkster/lite-scheduler benchmark harness.
 *
 * Compares six task-scheduling strategies on identical workloads:
 *
 *   A. lite-scheduler              (this library)
 *   B. setTimeout(fn, 0)           (the simplest async primitive)
 *   C. setTimeout + binary-heap PQ (the obvious DIY for priorities)
 *   D. queueMicrotask              (microtask queue, no priority)
 *   E. MessageChannel              (raw — no scheduling layer)
 *   F. React-style scheduler       (a minimal min-heap + MessageChannel impl,
 *                                   mimicking React's scheduler/src/forks/Scheduler.js
 *                                   sans cancellation, timers, or starvation logic)
 *
 * Workloads:
 *   1. Throughput          — schedule N no-op tasks, measure total drain time
 *   2. Priority isolation  — 1k high-priority + 10k low-priority, measure
 *                            time-to-completion of the LAST high-priority task
 *                            (the "head-of-line blocking" test)
 *   3. GC pressure         — 100k tasks; heap delta with --expose-gc
 *
 * Run: node --expose-gc bench/bench.js
 */

import { writeFileSync } from 'node:fs';
import { createScheduler, Priority } from '../Scheduler.js';

const GC = typeof globalThis.gc === 'function';
if (!GC) console.warn('[bench] --expose-gc not present; heap deltas will be unreliable.');

function nowMs() { return performance.now(); }

function snapHeap() {
    if (GC) globalThis.gc();
    return process.memoryUsage().heapUsed;
}

// ─────────────────────────────────────────────────────────────────
// Minimal binary heap for the DIY priority queue scheduler
// ─────────────────────────────────────────────────────────────────

class MinHeap {
    constructor() { this.h = []; this.seq = 0; }
    push(prio, fn) {
        // Stable tiebreaker via insertion sequence.
        this.h.push([prio, this.seq++, fn]);
        let i = this.h.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.h[p][0] < this.h[i][0] ||
                (this.h[p][0] === this.h[i][0] && this.h[p][1] < this.h[i][1])) break;
            [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
            i = p;
        }
    }
    pop() {
        const n = this.h.length;
        if (n === 0) return null;
        const top = this.h[0];
        const last = this.h.pop();
        if (n > 1) {
            this.h[0] = last;
            let i = 0;
            while (true) {
                const l = i * 2 + 1, r = l + 1;
                let s = i;
                if (l < this.h.length && (this.h[l][0] < this.h[s][0] ||
                    (this.h[l][0] === this.h[s][0] && this.h[l][1] < this.h[s][1]))) s = l;
                if (r < this.h.length && (this.h[r][0] < this.h[s][0] ||
                    (this.h[r][0] === this.h[s][0] && this.h[r][1] < this.h[s][1]))) s = r;
                if (s === i) break;
                [this.h[i], this.h[s]] = [this.h[s], this.h[i]];
                i = s;
            }
        }
        return top[2];
    }
    get size() { return this.h.length; }
}

// ─────────────────────────────────────────────────────────────────
// Six scheduler facades — all expose schedule(fn, prio) + waitDone()
// ─────────────────────────────────────────────────────────────────

function liteSchedulerFacade() {
    const s = createScheduler({ maxTasks: 16384, onCapacityExceeded: 'grow' });
    const prio = { high: Priority.UserInput, normal: Priority.Normal, low: Priority.Background };
    return {
        name: 'lite-scheduler',
        schedule(fn, p = 'normal') { s.schedule(fn, prio[p]); },
        waitDone() {
            return new Promise(resolve => {
                const tick = () => s.isBusy() ? setTimeout(tick, 0) : resolve();
                tick();
            });
        },
        destroy() { s.destroy(); },
    };
}

function setTimeoutFacade() {
    let pending = 0;
    let doneResolve = null;
    return {
        name: 'setTimeout(0)',
        schedule(fn) {
            pending++;
            setTimeout(() => {
                fn();
                pending--;
                if (pending === 0 && doneResolve) { doneResolve(); doneResolve = null; }
            }, 0);
        },
        waitDone() {
            if (pending === 0) return Promise.resolve();
            return new Promise(r => { doneResolve = r; });
        },
        destroy() {},
    };
}

function heapPQFacade() {
    // setTimeout + binary heap: the obvious DIY for "I want priorities."
    const heap = new MinHeap();
    let scheduled = false;
    let doneResolve = null;
    const prioMap = { high: 0, normal: 1, low: 2 };

    function drain() {
        scheduled = false;
        // Drain everything currently in the heap. (Same fairness model as a
        // single setTimeout flush — works fine for batch workloads.)
        while (heap.size > 0) {
            const fn = heap.pop();
            try { fn(); } catch (e) { console.error(e); }
        }
        if (doneResolve) { doneResolve(); doneResolve = null; }
    }

    return {
        name: 'setTimeout + heap PQ',
        schedule(fn, p = 'normal') {
            heap.push(prioMap[p], fn);
            if (!scheduled) { scheduled = true; setTimeout(drain, 0); }
        },
        waitDone() {
            if (heap.size === 0 && !scheduled) return Promise.resolve();
            return new Promise(r => { doneResolve = r; });
        },
        destroy() {},
    };
}

function microtaskFacade() {
    let pending = 0;
    let doneResolve = null;
    return {
        name: 'queueMicrotask',
        schedule(fn) {
            pending++;
            queueMicrotask(() => {
                fn();
                pending--;
                if (pending === 0 && doneResolve) { doneResolve(); doneResolve = null; }
            });
        },
        waitDone() {
            if (pending === 0) return Promise.resolve();
            return new Promise(r => { doneResolve = r; });
        },
        destroy() {},
    };
}

function messageChannelFacade() {
    // Raw MessageChannel: same primitive lite-scheduler uses, no scheduling layer.
    const ch = new MessageChannel();
    const queue = [];
    let scheduled = false;
    let doneResolve = null;

    ch.port1.onmessage = () => {
        scheduled = false;
        while (queue.length > 0) {
            const fn = queue.shift();
            try { fn(); } catch (e) { console.error(e); }
        }
        if (doneResolve) { doneResolve(); doneResolve = null; }
    };

    return {
        name: 'raw MessageChannel',
        schedule(fn) {
            queue.push(fn);
            if (!scheduled) { scheduled = true; ch.port2.postMessage(null); }
        },
        waitDone() {
            if (queue.length === 0 && !scheduled) return Promise.resolve();
            return new Promise(r => { doneResolve = r; });
        },
        destroy() {
            ch.port1.close();
            ch.port2.close();
        },
    };
}

function reactStyleFacade() {
    // A pared-down React scheduler clone: min-heap + MessageChannel + frame budget.
    // No starvation logic, no expiration timers — just the core "yield by deadline".
    const heap = new MinHeap();
    const ch = new MessageChannel();
    let scheduled = false;
    let deadline = 0;
    let doneResolve = null;
    const BUDGET = 5; // ms
    const prioMap = { high: 0, normal: 1, low: 2 };

    ch.port1.onmessage = () => {
        scheduled = false;
        deadline = performance.now() + BUDGET;
        let yielded = false;
        while (heap.size > 0) {
            if (performance.now() >= deadline) { yielded = true; break; }
            const fn = heap.pop();
            try { fn(); } catch (e) { console.error(e); }
        }
        if (yielded || heap.size > 0) {
            scheduled = true;
            ch.port2.postMessage(null);
        } else if (doneResolve) {
            doneResolve(); doneResolve = null;
        }
    };

    return {
        name: 'react-style (heap + MC + budget)',
        schedule(fn, p = 'normal') {
            heap.push(prioMap[p], fn);
            if (!scheduled) { scheduled = true; ch.port2.postMessage(null); }
        },
        waitDone() {
            if (heap.size === 0 && !scheduled) return Promise.resolve();
            return new Promise(r => { doneResolve = r; });
        },
        destroy() {
            ch.port1.close();
            ch.port2.close();
        },
    };
}

const facadeFactories = [
    liteSchedulerFacade,
    setTimeoutFacade,
    heapPQFacade,
    microtaskFacade,
    messageChannelFacade,
    reactStyleFacade,
];

// ─────────────────────────────────────────────────────────────────
// Workload 1: throughput — drain N no-op tasks
// ─────────────────────────────────────────────────────────────────

async function workloadThroughput(N) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`Workload 1: Throughput — drain ${N.toLocaleString()} no-op tasks`);
    console.log('─'.repeat(72));

    const results = [];
    for (const factory of facadeFactories) {
        // Warmup.
        for (let w = 0; w < 1; w++) {
            const fac = factory();
            for (let i = 0; i < Math.min(N, 1000); i++) fac.schedule(() => {});
            await fac.waitDone();
            fac.destroy();
        }
        // Trial.
        const trials = [];
        for (let r = 0; r < 3; r++) {
            const fac = factory();
            const heapBefore = snapHeap();
            const t0 = nowMs();
            for (let i = 0; i < N; i++) fac.schedule(() => {});
            await fac.waitDone();
            const t1 = nowMs();
            const heapAfter = snapHeap();
            trials.push({ ms: t1 - t0, heap: heapAfter - heapBefore });
            fac.destroy();
        }
        trials.sort((a, b) => a.ms - b.ms);
        const median = trials[Math.floor(trials.length / 2)];
        results.push({ label: factory().name, ms: median.ms, heap: median.heap, opsPerSec: N / (median.ms / 1000) });
    }

    printResults(results);
    return results;
}

// ─────────────────────────────────────────────────────────────────
// Workload 2: priority isolation — head-of-line blocking
//
// Schedule 5,000 low-priority tasks that each burn ~0.1ms of CPU.
// After 100 of them are queued, schedule ONE high-priority task that
// records its latency. Then queue the rest.
//
// Result: a FIFO scheduler runs ~100 burns first → ~10ms latency.
// A priority-respecting scheduler runs the high task in the first
// drain after it's scheduled → <2ms latency.
// ─────────────────────────────────────────────────────────────────

async function workloadPriorityIsolation() {
    const LOW_BEFORE = 100;
    const LOW_AFTER = 4_900;
    const BURN_MS = 0.1;
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`Workload 2: Head-of-line blocking — 1 high-prio surrounded by ${LOW_BEFORE + LOW_AFTER} low-prio`);
    console.log(`              low-prio tasks burn ~${BURN_MS}ms CPU each`);
    console.log(`              measures: latency from schedule(high) to high.run()`);
    console.log('─'.repeat(72));

    function burn() {
        const t = performance.now();
        while (performance.now() - t < BURN_MS) { /* spin */ }
    }

    const results = [];
    for (const factory of facadeFactories) {
        // Warmup.
        {
            const fac = factory();
            for (let i = 0; i < 100; i++) fac.schedule(() => {}, 'low');
            await fac.waitDone();
            fac.destroy();
        }

        const trials = [];
        for (let r = 0; r < 3; r++) {
            const fac = factory();
            let highScheduledAt = 0;
            let highRanAt = 0;
            const highDonePromise = new Promise(resolve => {
                // Queue the first batch of low-prio.
                for (let i = 0; i < LOW_BEFORE; i++) fac.schedule(burn, 'low');
                // Schedule the high-priority task; mark its schedule time.
                highScheduledAt = nowMs();
                fac.schedule(() => {
                    highRanAt = nowMs();
                    resolve();
                }, 'high');
                // Queue the rest of the low-prio tasks AFTER the high.
                for (let i = 0; i < LOW_AFTER; i++) fac.schedule(burn, 'low');
            });

            await highDonePromise;
            await fac.waitDone();
            trials.push({ ms: highRanAt - highScheduledAt });
            fac.destroy();
        }
        trials.sort((a, b) => a.ms - b.ms);
        const median = trials[Math.floor(trials.length / 2)];
        results.push({ label: factory().name, ms: median.ms });
    }

    const fastest = Math.min(...results.map(r => r.ms));
    console.log(`${'Strategy'.padEnd(36)} ${'high-latency (ms)'.padStart(20)} ${'vs best'.padStart(10)}`);
    for (const r of results) {
        const vs = (r.ms / fastest).toFixed(2) + '×';
        console.log(`${r.label.padEnd(36)} ${r.ms.toFixed(3).padStart(20)} ${vs.padStart(10)}`);
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────
// Workload 3: GC pressure
// ─────────────────────────────────────────────────────────────────

async function workloadGC() {
    const N = 50_000;
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`Workload 3: GC pressure — schedule ${N.toLocaleString()} tasks, measure heap delta`);
    console.log(`              (same facade is warmed at full N then re-measured — captures`);
    console.log(`               per-task allocation cost, not initial pool growth)`);
    console.log('─'.repeat(72));

    const results = [];
    for (const factory of facadeFactories) {
        const fac = factory();
        // Warmup at full workload size so any pool growth happens HERE.
        for (let i = 0; i < N; i++) fac.schedule(() => {});
        await fac.waitDone();

        // Now measure: re-run the same workload on the warmed facade.
        if (GC) globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < N; i++) fac.schedule(() => {});
        await fac.waitDone();
        if (GC) globalThis.gc();
        const after = process.memoryUsage().heapUsed;
        results.push({ label: fac.name, heap: after - before });
        fac.destroy();
    }

    const min = Math.min(...results.map(r => Math.max(0, r.heap)));
    console.log(`${'Strategy'.padEnd(36)} ${'heap Δ'.padStart(14)}`);
    for (const r of results) {
        const heap = r.heap < 1024
            ? `${r.heap} B`
            : r.heap < 1024 * 1024
                ? `${(r.heap / 1024).toFixed(1)} KB`
                : `${(r.heap / 1024 / 1024).toFixed(2)} MB`;
        console.log(`${r.label.padEnd(36)} ${heap.padStart(14)}`);
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────
// Pretty-printer
// ─────────────────────────────────────────────────────────────────

function printResults(results) {
    const fastest = Math.min(...results.map(r => r.ms));
    console.log(`${'Strategy'.padEnd(36)} ${'ms'.padStart(10)} ${'tasks/sec'.padStart(14)} ${'heap Δ'.padStart(12)} ${'vs best'.padStart(10)}`);
    for (const r of results) {
        const vs = (r.ms / fastest).toFixed(2) + '×';
        const heap = r.heap < 1024
            ? `${r.heap} B`
            : r.heap < 1024 * 1024
                ? `${(r.heap / 1024).toFixed(1)} KB`
                : `${(r.heap / 1024 / 1024).toFixed(2)} MB`;
        const ops = r.opsPerSec ? Math.round(r.opsPerSec).toLocaleString() : '—';
        console.log(`${r.label.padEnd(36)} ${r.ms.toFixed(3).padStart(10)} ${ops.padStart(14)} ${heap.padStart(12)} ${vs.padStart(10)}`);
    }
}

// ─────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────

console.log('@zakkster/lite-scheduler — benchmark harness');
console.log(`GC: ${GC ? 'enabled' : 'disabled (heap unreliable)'}`);
console.log(`Node: ${process.version} · ${process.platform}/${process.arch}`);

const all = {};
all.throughput10k = await workloadThroughput(10_000);
all.priorityIsolation = await workloadPriorityIsolation();
all.gc = await workloadGC();

writeFileSync(new URL('./bench-results.json', import.meta.url),
    JSON.stringify({ gc: GC, timestamp: new Date().toISOString(), results: all }, null, 2));

console.log('\nResults written to bench/bench-results.json');
