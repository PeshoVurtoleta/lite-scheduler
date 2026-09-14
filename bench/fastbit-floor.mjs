/**
 * bench/fastbit-floor.mjs -- the FastBitScheduler pop-min floor.
 *
 * Repo-only (never in package.json files[]). Run:
 *     node --expose-gc bench/fastbit-floor.mjs
 *
 * The claim under test: FastBitScheduler.popMin() is two instructions
 * (x & -x, then Math.clz32) -- no scan -- however many tiers are populated. The
 * honest comparisons:
 *   (a) FastBitScheduler.popMin (the bitmask routing table);
 *   (b) a naive 32-tier LINEAR SCAN over the same ring storage (no mask);
 *   (c) a binary HEAP of (priority, seq) pairs in a flat Int32Array with a
 *       lexicographic compare -- seq preserves FIFO within a tier, so it is the
 *       same data structure, not a heap that quietly drops the FIFO guarantee.
 *
 * The advantage is "visible when more than one tier is populated", so we report
 * at 1, 2, 8, and 32 populated tiers.
 */

import { arch, platform } from 'node:os';
import { FastBitScheduler } from '../Scheduler.js';

const NUM_TIERS = 32;
const PER_TIER = 512;     // items per populated tier
const REPEAT = 400;       // fill+drain cycles per measurement

// --- (b) naive 32-tier linear scan over identical ring storage --------------
class LinearScan {
    constructor(cap, nt) {
        this.cap = cap; this.mask = cap - 1; this.nt = nt;
        this.buckets = Array.from({ length: nt }, () => new Int32Array(cap));
        this.heads = new Uint32Array(nt);
        this.tails = new Uint32Array(nt);
        this.counts = new Uint32Array(nt);
    }
    push(item, p) {
        const t = this.tails[p];
        this.buckets[p][t] = item;
        this.tails[p] = (t + 1) & this.mask;
        this.counts[p]++;
    }
    popMin() {
        for (let p = 0; p < this.nt; p++) {       // the scan the mask replaces
            if (this.counts[p] !== 0) {
                const h = this.heads[p];
                const item = this.buckets[p][h];
                this.heads[p] = (h + 1) & this.mask;
                this.counts[p]--;
                return item;
            }
        }
        return -1;
    }
}

// --- (c) binary heap of (priority, seq, handle) with FIFO tiebreak ----------
class PairHeap {
    constructor(capPairs) {
        // three parallel columns keyed by heap position
        this.pri = new Int32Array(capPairs);
        this.seq = new Int32Array(capPairs);
        this.val = new Int32Array(capPairs);
        this.n = 0; this.counter = 0;
    }
    _less(i, j) {
        const pi = this.pri[i], pj = this.pri[j];
        if (pi !== pj) return pi < pj;
        return this.seq[i] < this.seq[j];       // FIFO within a tier
    }
    _swap(i, j) {
        let t = this.pri[i]; this.pri[i] = this.pri[j]; this.pri[j] = t;
        t = this.seq[i]; this.seq[i] = this.seq[j]; this.seq[j] = t;
        t = this.val[i]; this.val[i] = this.val[j]; this.val[j] = t;
    }
    push(item, p) {
        let i = this.n++;
        this.pri[i] = p; this.seq[i] = this.counter++; this.val[i] = item;
        while (i > 0) { const par = (i - 1) >> 1; if (this._less(i, par)) { this._swap(i, par); i = par; } else break; }
    }
    popMin() {
        if (this.n === 0) return -1;
        const item = this.val[0];
        this.n--;
        if (this.n > 0) {
            this.pri[0] = this.pri[this.n]; this.seq[0] = this.seq[this.n]; this.val[0] = this.val[this.n];
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1; let m = i;
                if (l < this.n && this._less(l, m)) m = l;
                if (r < this.n && this._less(r, m)) m = r;
                if (m === i) break;
                this._swap(i, m); i = m;
            }
        }
        return item;
    }
}

function tiersFor(k) {
    // Populate the k HIGHEST tiers, so the lowest populated tier sits at
    // NUM_TIERS-k: that is the scan's real cost (it walks 0..lowest), while the
    // mask jumps straight to it. At k=32 tier 0 is live and the scan
    // short-circuits -- the honest crossover.
    const out = [];
    for (let i = 0; i < k; i++) out.push(NUM_TIERS - 1 - i);
    return out;
}

function benchOne(makeQ, populated) {
    const total = populated.length * PER_TIER;
    // warmup
    for (let w = 0; w < 20; w++) {
        const q = makeQ();
        for (let p of populated) for (let i = 0; i < PER_TIER; i++) q.push(i + 1, p);
        for (let i = 0; i < total; i++) q.popMin();
    }
    globalThis.gc?.();
    const start = process.hrtime.bigint();
    let pops = 0;
    for (let r = 0; r < REPEAT; r++) {
        const q = makeQ();
        for (let p of populated) for (let i = 0; i < PER_TIER; i++) q.push(i + 1, p);
        for (let i = 0; i < total; i++) { q.popMin(); pops++; }
    }
    const ns = Number(process.hrtime.bigint() - start);
    return pops / (ns / 1e9); // pops/sec
}

const heapCap = NUM_TIERS * PER_TIER + 16;
const factories = {
    'FastBitScheduler.popMin': () => new FastBitScheduler(PER_TIER, NUM_TIERS),
    'naive 32-tier scan':      () => new LinearScan(PER_TIER, NUM_TIERS),
    'binary heap (pri,seq)':   () => new PairHeap(heapCap),
};

console.log('FastBitScheduler pop-min floor -- node ' + process.version + ', ' + platform() + ' ' + arch() + ', 2026-09-14');
console.log('populated tiers: 1, 2, 8, 32; ' + PER_TIER + ' items/tier; ' + REPEAT + ' cycles; pops/sec (higher is better)\n');

const K = [1, 2, 8, 32];
const rows = {};
for (const name of Object.keys(factories)) rows[name] = [];
for (const k of K) {
    const populated = tiersFor(k);
    for (const name of Object.keys(factories)) rows[name].push(benchOne(factories[name], populated));
}

const pad = (s, w) => (s + ' '.repeat(w)).slice(0, w);
console.log(pad('implementation', 26) + K.map((k) => pad(k + ' tier' + (k > 1 ? 's' : ''), 14)).join(''));
for (const name of Object.keys(factories)) {
    console.log(pad(name, 26) + rows[name].map((v) => pad((v / 1e6).toFixed(1) + ' M/s', 14)).join(''));
}
console.log('\nspeedup FastBit vs scan / heap at 32 tiers: ' +
    (rows['FastBitScheduler.popMin'][3] / rows['naive 32-tier scan'][3]).toFixed(2) + 'x / ' +
    (rows['FastBitScheduler.popMin'][3] / rows['binary heap (pri,seq)'][3]).toFixed(2) + 'x');
