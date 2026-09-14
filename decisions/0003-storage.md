# 0003 -- Storage layout for FastBitScheduler: 32 rings vs one flat array

Status: accepted (F2, v1.1.0)
Date: 2026-09-14

`FastBitScheduler` stores handles in a per-tier ring. The draft used 32 separate
`Int32Array` rings (Option A). A single flat `Int32Array` is the obvious
alternative (Option B). This record fixes the protocol and the adoption rule
**before** any number is measured, so the bar cannot move after the numbers
arrive. The numbers and the verdict are filled in after the measurement.

Storage element type is settled and not re-opened: the rings are `Int32Array`,
never `Float32Array`. A `Float32Array` store (the lite-ring-buffer element type)
would silently corrupt any handle above 2^24 -- the largest exactly-representable
integer in a 32-bit float -- so a handle of `2^24 + 1` would round to a
neighboring value and alias a different SoA row. `Int32Array` round-trips every
non-negative Int32 handle bit-exact, which is the handle contract's whole point.

---

## Options considered

- **Option A -- 32 separate `Int32Array` rings** (the draft, fuzz-proven).
  `buckets[p]` is its own `Int32Array(capacity)`; `heads`/`tails`/`counts` are
  parallel `Uint32Array(numTiers)`. `popMin`/`peekMin` index `buckets[p][h]`.
- **Option B -- one flat `Int32Array(numTiers << log2cap)`.** A single backing
  store; tier `p` slot `i` lives at index `(p << log2cap) | i`. One allocation,
  one object, better cache locality in principle for a full sweep.

## The protocol (written before measuring)

1. Land **Option A** in `Scheduler.js` (task 8). A is the default and the
   presumed outcome.
2. Prototype **Option B** in the scratchpad only (`layout-b.mjs`), never in
   `Scheduler.js`.
3. Measure `assertOps`/`measureOps` push/popMin churn on both, same ops, same
   warmup, same `stabilize`, same process shape, same corrected workload
   (residents + single-occupancy churn tiers -- orchestrator note 1).
4. Re-run the full 1M-op differential fuzz against a B-backed build.

## The adoption rule (from the plan section 1, verbatim)

B is **adopted ONLY if both** of these hold:

1. `assertOps` push/popMin churn on B is `>=` the same measurement on A, and
2. the full 1M-op differential fuzz re-runs **green** against the B-backed build.

If either fails, **A stands** and this record keeps B's number as the rejected
alternative. If B is adopted, ASSERTION A3 (byte-identity of `popMin`/`peekMin`
to the draft) is **replaced** by fuzz-equivalence (1M ops, identical oracle, zero
divergences) and this record quotes the exact `popMin` body diff hunk with the
sentence "the byte-identity guarantee was traded for measured throughput on
<date>, evidence below". This is a measurement, not a preference, and it is
decided once -- not re-opened during coding.

## The one authorized deviation from byte-identity (A path)

Even on the A path, `popMin` differs from the draft by **exactly one** statement:
the `_size` maintenance decrement required by the O(1) `size` counter. The draft
had no `size`. The exact hunk added inside `popMin`, immediately after
`const item = ...` reads the slot:

```js
        this._size--;                                // O(1) size counter
```

(placed before the `if (--this.counts[p] === 0)` region, one statement, no change
to any mechanism line). `peekMin` is byte-identical to the draft with no change
at all. This is the sole pre-authorized deviation; everything else in
`popMin`/`peekMin` is the draft's text including comments.

## Measurement (T13)

Provenance: node v26.3.1, darwin arm64, 2026-09-14 (measureOps, ops 200000,
warmup 20000, stabilize 'deep', corrected note-1 workload, --max-semi-space-size=4).

Methodology note (shape confound removed): the shipped A lives inside a large
module (`Scheduler.js`) while a naive B prototype is a tiny standalone module, and
V8 can JIT a small module more aggressively. To compare like for like, A was
re-measured as a **standalone twin** (`layout-a-std.mjs`) with the exact module
shape of the B prototype (`layout-b.mjs`) -- same methods, same imports, same file
size class. Both arms use best-of-5 (throughput is a floor; the best run has the
least interference); the run-to-run spread is also reported because it governs the
verdict.

- Option A (32 rings, standalone twin): best 58258083 ops/s; the twin's own
  run-to-run spread across runs was ~50.3M..58.3M (~15%).
- Option B (one flat array): best 62460962 ops/s.
- ratio B/A (best) = 1.072.
- 1M-op differential fuzz on B: **not run** (condition 1 was not met outside
  noise; condition 2 is therefore moot).
- **Adopted layout: A.** B's best-of edge (~7%) sits INSIDE A's own ~15%
  run-to-run variance, so it is not the CLEAR, outside-noise win the two-condition
  adoption rule requires against the default. Condition 1 ("B >= A") is not
  satisfied by an outside-noise margin, so A stands and B's number is recorded as
  the rejected alternative. A's `popMin`/`peekMin` remain byte-identical to the
  draft except the single `_size` statement quoted above (ASSERTION A3 holds).

## Door-cost baseline (T12; also in CHANGELOG Measured)

Provenance: node v26.3.1, darwin arm64, 2026-09-14 (measureOps, ops 200000,
warmup 20000, stabilize 'deep', corrected note-1 workload, --max-semi-space-size=4,
best-of-6).

- arm 1 (undoored draft): opsPerSec = 64921891
- arm 2 (shipped, doored class): opsPerSec = 59859325
- ratio shipped/draft = 0.922 (floor 0.90 -- pass)
- majorsPerKOp = 0 and maxPauseMsPerOp = 0.000 on both arms; bytesPerOp ~0.007-0.010
  (measurement noise, not a real allocation -- the workload allocates nothing).

The two item-door compares, the hoisted `_maxPrio` bound, and the O(1) `_size`
maintenance cost little: the shipped/draft ratio sits above the 0.90 floor and
neither arm produces a major GC or an over-budget pause. (The ratio is a
conservative floor: arm 1 is both undoored AND a small standalone module, arm 2 is
both doored AND the large shipped module, so both differences push the ratio the
same way -- the true door cost alone is smaller than 1 - 0.922.)
