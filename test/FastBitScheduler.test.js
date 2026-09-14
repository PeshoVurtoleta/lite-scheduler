/**
 * @zakkster/lite-scheduler -- FastBitScheduler unit suite (the second member).
 *
 * AR-02 discipline: every D-01..D-06 finding (plus 0004's numTiers cases) is a
 * named test that legitimately FAILS against FastBitScheduler.draft.js and PASSES
 * against the hardened class in Scheduler.js. The ten mechanism cases are POSITIVE
 * CONTROLS -- they pass against the draft by design (the mask trick and the true
 * rings are the fuzz-proven part) and must stay green in both the red and green
 * runs. Honest counts: only tests that can legitimately fail against the draft are
 * reds.
 *
 * IMPORT SWITCH (T6 vs T9): the two lines below are the ONLY thing that changes
 * between the red run (draft) and the green run (shipped). TARGET is a module-level
 * string so the D-05 case can dynamic-import it and the file still parses when
 * EMPTY is not a static export of the draft.
 */

// >>> T9 flips these two lines from the draft to ../Scheduler.js <<<
import { FastBitScheduler, EMPTY } from '../Scheduler.js';
const TARGET = new URL('../Scheduler.js', import.meta.url).href;

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- D-01: the item door, negative handles ---------------------------------

test('D-01: push(-1, 0) throws -- a stored -1 collides with EMPTY and strands the canonical drain', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(-1, 0));
});

// --- D-02: the item door, coercion classes ---------------------------------

test('D-02a: push({}, 0) throws -- Int32Array coerces an object to 0, silently storing handle 0', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push({}, 0));
});

test('D-02b: push(NaN, 0) throws -- NaN coerces to 0, indistinguishable from a real handle 0', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(NaN, 0));
});

test('D-02c: push(1.5, 0) throws -- a fractional handle truncates to 1', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(1.5, 0));
});

test('D-02d: push(2**31, 0) throws -- 2**31 wraps to -2147483648, a negative stored handle', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(2 ** 31, 0));
});

test("D-02e: push('7', 0) throws -- a numeric string coerces to 7; null is not zero and '7' is not 7", () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push('7', 0));
});

// --- D-03: the constructor capacity door -----------------------------------

test("D-03a: new FastBitScheduler(2**31) throws naming the 2**24 ceiling -- ceilPow2's n|0 made it capacity 2", () => {
    assert.throws(() => new FastBitScheduler(2 ** 31), /2\*\*24|16777216/);
});

test('D-03b: new FastBitScheduler(0) throws -- 0 is not a capacity, and nothing may silently clamp', () => {
    assert.throws(() => new FastBitScheduler(0));
});

test('D-03c: new FastBitScheduler(-5) throws -- a negative capacity is a caller bug, not a clamp', () => {
    assert.throws(() => new FastBitScheduler(-5));
});

test('D-03d: new FastBitScheduler(NaN) throws -- null is not zero and NaN is not 1024', () => {
    assert.throws(() => new FastBitScheduler(NaN));
});

test('D-03e: new FastBitScheduler(1.5) throws -- a fractional capacity truncates silently', () => {
    assert.throws(() => new FastBitScheduler(1.5));
});

test('D-03f: new FastBitScheduler(Infinity) throws -- Infinity|0 is 0, the quietest fail-open of all', () => {
    assert.throws(() => new FastBitScheduler(Infinity));
});

// --- D-04: the sizeOf door -------------------------------------------------

test('D-04a: sizeOf(32) throws -- an out-of-range tier must not read undefined off the end', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.sizeOf(32));
});

test('D-04b: sizeOf(-1) throws -- a negative tier must not read undefined', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.sizeOf(-1));
});

test('D-04c: sizeOf(1.5) throws -- a fractional tier must not read undefined', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.sizeOf(1.5));
});

// --- D-05: EMPTY is exported -----------------------------------------------

test("D-05: EMPTY is a named export and equals -1 -- the drain loop's sentinel cannot be module-private", async () => {
    const m = await import(TARGET);
    assert.equal(m.EMPTY, -1);
});

// --- D-06: the missing surface ---------------------------------------------

test('D-06a: size is an O(1) maintained counter that tracks push/popMin exactly', () => {
    const q = new FastBitScheduler(16, 32);
    assert.equal(q.size, 0);
    q.push(10, 2);
    q.push(11, 2);
    q.push(12, 5);
    assert.equal(q.size, 3);
    q.popMin();
    assert.equal(q.size, 2);
    q.popMin();
    q.popMin();
    assert.equal(q.size, 0);
});

test('D-06b: clear() empties every tier, zeroes activeMask and size, and does not reallocate', () => {
    const q = new FastBitScheduler(16, 32);
    const refs = [];
    for (let p = 0; p < q.numTiers; p++) refs.push(q.buckets[p]);
    q.push(1, 0);
    q.push(2, 7);
    q.push(3, 31);
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.activeMask, 0);
    assert.equal(q.isEmpty(), true);
    for (let p = 0; p < q.numTiers; p++) {
        assert.equal(q.buckets[p], refs[p], 'clear() reallocated tier ' + p);
    }
});

test('D-06c: peekPriority() returns the tier of the next pop, and -1 when empty', () => {
    const q = new FastBitScheduler(16, 32);
    assert.equal(q.peekPriority(), -1);
    q.push(9, 5);
    q.push(8, 2);
    assert.equal(q.peekPriority(), 2);
    q.popMin();
    assert.equal(q.peekPriority(), 5);
});

test('D-06d: capacity reports the rounded-up allocation (1000 -> 1024)', () => {
    const q = new FastBitScheduler(1000, 32);
    assert.equal(q.capacity, 1024);
});

test('D-06e: requestedCapacity reports what the caller asked for (1000), so the round-up is observable', () => {
    const q = new FastBitScheduler(1000, 32);
    assert.equal(q.requestedCapacity, 1000);
});

// --- 0004: numTiers (Ledger B) ---------------------------------------------

test('0004a: new FastBitScheduler(1024, 8) builds 8 tiers and numTiers reports 8', () => {
    const q = new FastBitScheduler(1024, 8);
    assert.equal(q.numTiers, 8);
});

test('0004b: with numTiers 8, push(h, 8) throws -- the door bound is numTiers-1, not 31', () => {
    const q = new FastBitScheduler(1024, 8);
    assert.throws(() => q.push(1, 8));
});

test('0004c: new FastBitScheduler(1024, 33) throws -- more than 32 tiers cannot fit a 32-bit mask', () => {
    assert.throws(() => new FastBitScheduler(1024, 33));
});

test('0004d: new FastBitScheduler(1024, 1) throws -- a one-tier priority queue is a caller mistake, not a queue', () => {
    assert.throws(() => new FastBitScheduler(1024, 1));
});

// --- POSITIVE CONTROLS (pass against the draft; zero reds) ------------------

test('mechanism: popMin returns the lowest-numbered non-empty tier first (the min-tier law)', () => {
    const q = new FastBitScheduler(64, 32);
    q.push(100, 5);
    q.push(101, 2);
    q.push(102, 9);
    q.push(103, 2);
    assert.equal(q.popMin(), 101); // tier 2 first, FIFO
    assert.equal(q.popMin(), 103);
    assert.equal(q.popMin(), 100); // tier 5
    assert.equal(q.popMin(), 102); // tier 9
});

test('mechanism: FIFO within a tier is preserved across a full ring lap', () => {
    const cap = 8;
    const q = new FastBitScheduler(cap, 32);
    // Fill-to-capacity then fully drain, several cycles: the cursors advance by
    // cap each cycle and lap the ring, but occupancy never exceeds capacity.
    let next = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
        const base = next;
        for (let i = 0; i < cap; i++) q.push(next++, 3);
        for (let i = 0; i < cap; i++) assert.equal(q.popMin(), base + i); // FIFO
    }
    assert.equal(q.popMin(), -1);
});

test('mechanism: tier 31 alone works with activeMask < 0 (the sign bit is set)', () => {
    const q = new FastBitScheduler(16, 32);
    q.push(7, 31);
    assert.ok(q.activeMask < 0, 'bit 31 must make the mask negative');
    assert.equal(q.activeMask, -2147483648);
    assert.equal(q.popMin(), 7);
});

test('mechanism: a full tier throws, the drain empties it, and the refill succeeds (D-08 regression)', () => {
    const cap = 4;
    const q = new FastBitScheduler(cap, 32);
    for (let i = 0; i < cap; i++) q.push(i, 6);
    assert.throws(() => q.push(999, 6)); // full
    for (let i = 0; i < cap; i++) assert.equal(q.popMin(), i); // drain FIFO
    for (let i = 100; i < 100 + cap; i++) q.push(i, 6); // refill
    for (let i = 100; i < 100 + cap; i++) assert.equal(q.popMin(), i);
});

test('mechanism: peekMin() equals the next popMin() without mutating', () => {
    const q = new FastBitScheduler(16, 32);
    q.push(42, 4);
    q.push(43, 4);
    const peeked = q.peekMin();
    const peeked2 = q.peekMin();
    assert.equal(peeked, peeked2);
    assert.equal(peeked, q.popMin());
});

test('mechanism: popMin() on an empty scheduler returns -1', () => {
    const q = new FastBitScheduler(16, 32);
    assert.equal(q.popMin(), -1);
});

test('mechanism: push(h, 32) throws -- JS shift is mod 32, so tier 32 would silently alias tier 0', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(1, 32));
});

test('mechanism: push(h, -1) throws', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(1, -1));
});

test('mechanism: push(h, 1.5) throws', () => {
    const q = new FastBitScheduler(16, 32);
    assert.throws(() => q.push(1, 1.5));
});

test('mechanism: isEmpty() is true exactly when activeMask is 0', () => {
    const q = new FastBitScheduler(16, 32);
    assert.equal(q.isEmpty(), true);
    assert.equal(q.activeMask, 0);
    q.push(1, 3);
    assert.equal(q.isEmpty(), false);
    assert.notEqual(q.activeMask, 0);
    q.popMin();
    assert.equal(q.isEmpty(), true);
    assert.equal(q.activeMask, 0);
});

// --- sibling vector (ported from FastBit32; a mechanism control) -----------

test('fb-tier31-sign-bit (ported from FastBit32: bit 31 makes the mask negative)', () => {
    const q = new FastBitScheduler(16, 32);
    q.push(0, 31); // handle 0 must be distinguishable from absent
    q.push(2147483647, 31); // 2^31-1 must not wrap
    assert.ok(q.activeMask !== 0, 'never assert > 0 on a sign-bit mask');
    assert.ok(q.activeMask < 0);
    assert.equal(q.popMin(), 0);
    assert.equal(q.popMin(), 2147483647);
    assert.equal(q.popMin(), -1);
});

// --- sibling vector (ported from RingBuffer: round-up is observable) --------

test('fb-capacity-roundup-observable (ported from RingBuffer: capacity vs requestedCapacity)', () => {
    assert.equal(new FastBitScheduler(1, 32).capacity, 2); // min ring is 2
    assert.equal(new FastBitScheduler(100, 32).capacity, 128);
    assert.equal(new FastBitScheduler(100, 32).requestedCapacity, 100);
    assert.equal(new FastBitScheduler(1024, 32).capacity, 1024);
});

// --- QA boundary pins (F2 qa pass; genuine gaps, added only where missing) --

test('fb-clear-on-already-empty-queue-is-a-noop', () => {
    const q = new FastBitScheduler(16, 32);
    const refs = [];
    for (let p = 0; p < q.numTiers; p++) refs.push(q.buckets[p]);
    q.clear(); // never pushed to; clear() on an empty queue must not throw or reallocate
    assert.equal(q.size, 0);
    assert.equal(q.activeMask, 0);
    assert.equal(q.isEmpty(), true);
    for (let p = 0; p < q.numTiers; p++) {
        assert.equal(q.buckets[p], refs[p], 'clear() on an empty queue reallocated tier ' + p);
    }
});

test('fb-push-after-clear-lands-in-right-tier-with-fifo-reset', () => {
    const q = new FastBitScheduler(8, 32);
    q.push(1, 3);
    q.push(2, 3);
    q.clear();
    q.push(10, 3);
    q.push(11, 3);
    q.push(12, 7);
    assert.equal(q.size, 3);
    assert.equal(q.sizeOf(3), 2);
    assert.equal(q.peekPriority(), 3);
    assert.equal(q.popMin(), 10); // FIFO restarts at the front, not mid-ring
    assert.equal(q.popMin(), 11);
    assert.equal(q.popMin(), 12);
    assert.equal(q.popMin(), -1);
});

test('fb-numTiers-2-minimal-instance-full-push-pop-clear-cycle', () => {
    const q = new FastBitScheduler(4, 2);
    assert.equal(q.numTiers, 2);
    q.push(1, 0);
    q.push(2, 1);
    assert.equal(q.size, 2);
    assert.equal(q.popMin(), 1); // tier 0 first
    assert.equal(q.popMin(), 2);
    assert.equal(q.popMin(), -1);
    assert.throws(() => q.push(3, 2)); // tier 2 is out of range when numTiers is 2
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.isEmpty(), true);
});

test('fb-peekPriority-on-a-single-item-tier-0-queue', () => {
    const q = new FastBitScheduler(16, 32);
    q.push(5, 0);
    assert.equal(q.peekPriority(), 0);
    assert.equal(q.popMin(), 5);
    assert.equal(q.peekPriority(), -1);
});

test('fb-sizeOf-on-a-valid-empty-tier-returns-zero-not-undefined', () => {
    const q = new FastBitScheduler(16, 32);
    assert.equal(q.sizeOf(0), 0);
    assert.equal(q.sizeOf(31), 0);
    assert.notEqual(q.sizeOf(15), undefined);
});

test('fb-EMPTY-static-import-equals-negative-one', () => {
    // Assignment to an imported binding is a static ES-module SyntaxError, so the
    // "frozen" half of this pin is enforced by the language itself, not a runtime
    // assertion -- this checks the value carried by the static `import { EMPTY }`
    // binding used at the top of this file (D-05 only checks a dynamic re-import).
    assert.equal(EMPTY, -1);
});

test('fb-requestedCapacity-equals-capacity-when-the-request-is-already-a-power-of-two', () => {
    const q = new FastBitScheduler(1024, 32);
    assert.equal(q.requestedCapacity, q.capacity);
    assert.equal(q.requestedCapacity, 1024);
});
