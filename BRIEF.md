---
package: "@zakkster/lite-scheduler"
session: F2
version_target: 1.1.0
status: shipped -- /release 1.1.0 gates green 2026-09-14
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
findings: [D-01, D-02, D-03, D-04, D-05, D-06, D-07]
depends_on: [F1]
blocks: [F3]
---

# lite-scheduler F2 -- FastBitScheduler lands hardened (v1.1.0)

This brief is the F2 session of `ROADMAP.md` (read sections 0, 1, 2 -- the
DRAFT findings table -- 3, and the F2 block in section 5 before planning).
One deliverable: the draft's fuzz-proven mechanism ships from `Scheduler.js`
as the family's second member with EVERY door closed and full surface,
proven fail-before/pass-after, without one byte of change to the shipped
frame scheduler. The draft file is deleted in the same session.

## Context the planner must load

- ROADMAP.md sections 0 (the two-member verdict + the probe result that
  matters: the mechanism is proven, every defect is at the door), 1 (shared
  law + the conservation invariants), 2 (D-01..D-07 with verbatim
  reproductions), 3 (tier map + "The perf gate"), 5 (F2 block: the four
  decisions and the task list this brief binds).
- `FastBitScheduler.draft.js` (120 lines, repo root, tracked). Door sites
  (locate exactly; line numbers drift): `ceilPow2` does `n | 0` first --
  the D-03 fail-open (2**31 -> cap 2; 0/-5/NaN/1.5/Infinity -> 2); `push`
  validates priority but NOT item -- D-01 (-1 accepted, poisons the
  canonical `while ((h = popMin()) !== EMPTY)` drain) and D-02 (Int32Array
  coercion: `{}` -> 0, NaN -> 0, 1.5 -> 1, 2**31 -> negative, '7' -> 7);
  `sizeOf` reads `counts[priority]` unvalidated -- D-04 (out-of-bounds ->
  undefined, fail open); `EMPTY` is module-private -- D-05; no size /
  clear() / peekPriority() / capacity introspection -- D-06; 32 rings
  always allocated (128 KiB at default 1024) -- D-07, decision 0004.
- Current package facts (verified 2026-09-14): v1.0.3 published (latest);
  HEAD 68ead0d, tree clean. Unit suite 63 node:test tests green; torture
  t0/t1/t2/t5/t6/t7/t9 green -- FRAME-SCHEDULER LANES ONLY (grep proves
  zero FastBitScheduler references anywhere under test/); perf suite =
  one sync enqueue-door scenario + counters + one mustFail; `npm run
  verify` exit 0. F2 lights the second member's lanes from scratch.
- decisions/0001-task-door.md is the decision-record pattern (status,
  options, decision, rationale, measured cost). 0002-0005 follow it.
- Sibling suites to MINE, paths verified: `../LiteFastBit32/FastBit32.test.js`
  and `../LiteRingBuffer/RingBuffer.test.js`. READ them for vectors --
  bit-31 sign-bit behavior, mod-32 wrap abuse, signed/unsigned mask traps,
  wrap-boundary churn, full/empty disambiguation. Patterns only, NEVER
  imports: RingBuffer is Float32Array-backed (would corrupt handles above
  2^24); FastBit32 is deliberately fail-open -- the opposite contract.
- Perf-gate surface: read `node_modules/@zakkster/lite-perf-gate/llms.txt`
  AND `COOKBOOK.md` fresh -- never scenario shapes or thresholds from
  memory (the F0 lesson, twice proven). devDeps already pinned: perf-gate
  ^1.4.2, gc-profiler ^1.16.0, lite-leak ^1.10.0; node_modules installed.

## Law constraints binding this session

- Fail closed at the door, free in the body: popMin/peekMin bodies stay
  BYTE-IDENTICAL to the draft (the fuzz-proven mechanism). push gains
  exactly the item door (two integer compares). Constructor and sizeOf
  gain validation. Nothing else touches a hot body.
- The shipped frame scheduler is untouchable this session: the
  `createScheduler` / `schedule` / `performWork` hunks in the Scheduler.js
  diff are EMPTY -- assert by diff inspection. The F2 diff to existing
  code is additive only (new class, new named exports) plus the VERSION
  line.
- The handle contract (ROADMAP law 4): storage Int32Array; handles are
  non-negative Int32; `EMPTY = -1` is the ONE out-of-band value and it is
  EXPORTED. FastBitScheduler and EMPTY are named exports; the draft's
  default export does not carry over; the file's existing export shape is
  untouched.
- AR-02 discipline, with the F1 honesty lesson: every D-door test is
  proven RED against the DRAFT mechanism first, captured in the session
  log -- and the red count is HONEST. Count only tests that can
  legitimately fail against the draft; mechanism tests (FIFO, min-tier,
  tier 31, full-throw-drain) pass against the draft by design -- they are
  positive controls, not reds. Do not force reds; do not inflate the
  count (the F1 arithmetic over-count went to the reviewer).
- RED protocol (the draft is the only pre-fix target -- Scheduler.js has
  no second member yet): (1) author test/FastBitScheduler.test.js with
  its import pointed at `../FastBitScheduler.draft.js`; run; door and
  surface cases fail, mechanism cases pass; capture in the session log.
  (2) Land the hardened class in Scheduler.js. (3) Flip the import to
  `../Scheduler.js`; run; all green; capture. Delete the draft only
  after GREEN. The 1M fuzz MUST run green against the SHIPPED class.
- Never widen a budget: gc_maxMajor 0 / maxPauseMs 4 / arrayBuffers
  growth 0 unchanged; perf-gate thresholds stay at its defaults;
  allowNoGc / allowEmpty / allowInconclusive never in a gated run.
- Semver: 1.1.0 (minor -- new exported surface). Three-place sync in the
  same session; refresh package-lock.json after the bump
  (`npm install --package-lock-only` -- the F1 stale-lock lesson).
- ASCII-only; node:test only; test/ and decisions/ and the draft never in
  the tarball.

## TASKS

1. **decisions/0002-0005 BEFORE coding** (pattern per 0001):
   - 0002-dual-family.md: one package, one file, two members; neither
     references the other; segregation is C2's procedure. Codifies
     ROADMAP section 0.
   - 0003-storage.md: A (32 separate Int32Array rings, the draft,
     fuzz-proven) vs B (one flat Int32Array(32 * cap), index
     `(p << log2cap) | i`). Protocol: land A first; prototype B in the
     scratchpad; assertOps push/popMin churn on both; adopt B ONLY if
     >= A AND the full fuzz re-runs green on B. A measurement, not a
     preference; numbers into the record either way.
   - 0004-tiers.md: fixed 32 vs `numTiers` option (2..32, default 32).
     Recommendation: add it -- one constructor validation, priority door
     bound becomes numTiers-1 (hoisted), zero hot-path cost. The D-07
     memory table goes in the docs either way.
   - 0005-no-callbacks.md: `drain(cb)` REJECTED (re-enters user code
     mid-mutation, the B4 lesson). The drain loop IS the API. On the
     record so it is not re-proposed.
2. **RED capture** per the protocol above: the new suite's door cases
   (D-01 -1 handle; D-02 each coercion class -- {}, NaN, 1.5, 2**31,
   '7'; D-03 each bad capacity -- 2**31, 0, -5, NaN, 1.5, Infinity;
   D-04 sizeOf 32 / -1 / 1.5) plus surface cases (D-05 EMPTY import;
   D-06 size/clear/peekPriority/capacity/requestedCapacity) against the
   draft; failures logged with the honest count.
3. **The hardened class into Scheduler.js** as a named export; DELETE
   FastBitScheduler.draft.js after GREEN. The doors (all throwing
   library-named errors, all at the door):
   - constructor: capacityPerTier an integer, 1 <= n <= 2**24
     (documented ceiling); numTiers per 0004. D-03 dies -- nothing
     silently clamps; pow2 round-up stays but becomes OBSERVABLE via
     `capacity` + `requestedCapacity` getters (lite-ring-buffer
     precedent).
   - push: item door `(item | 0) === item && item >= 0` -> else throw.
     Two compares on the enqueue path. D-01 and D-02 die.
   - sizeOf: priority validated like push's door. D-04 dies.
   - Surface: `export const EMPTY = -1`; `size` (O(1) maintained
     counter); `clear()` (O(numTiers) cursor+mask+count reset, no
     realloc, documented cold); `peekPriority()` -> tier of next pop or
     -1; `capacity`, `requestedCapacity`.
4. **Storage decision 0003 measurement** per its protocol; the fuzz is
   the gate for any restructure.
5. **Mine the sibling suites** (read the two files; port applicable
   vectors into the tier tests with their lesson named in the test name).
6. **test/FastBitScheduler.test.js at LiteLru density**: every D finding
   as a named before/after test; tier-31 sign-bit; the full-throw-drain
   regression (D-08 positive); FIFO-across-wrap; every door case; the
   sibling vectors.
7. **Torture: light the FastBitScheduler lanes** of t0 (min-tier law,
   FIFO-within-tier metamorphic merge, peek===pop, isEmpty<=>mask<=>size,
   round-trip handles {0, 1, 2^31-1}), t1 (every D door), t2
   (wrap-boundary churn cap+1 laps; fill->throw->drain->refill; all 32
   tiers saturated; tier 31 alone; alternating 0/31; pop-empty storms),
   t5 (differential fuzz vs 32-plain-arrays oracle, 1M seeded mixed ops
   55/35/10 push/popMin/peekMin, conservation invariant after EVERY op,
   seed-replayable), t6 (measureOps churn, maxMajor 0,
   maxArrayBuffersGrowth 0, stabilize deep; PLUS the structural assert:
   buckets byteLength + cursor-column lengths byte-identical
   before/after), t7 (4096 fill/drain cycles, conservation between
   cycles). t9/controls: every new gate gets a red control (item door
   removed must fail t1; corrupted oracle must fail t5; BREAK still
   trips t6).
8. **Perf gate**: extend test/perf.test.mjs (surface read fresh) with
   the pure-sync scenarios this instrument exists for: push/popMin
   steady churn and the door-cost path; statsOf reports summed buckets
   byteLength as a counter (max delta 0 -- rings never grow,
   byte-exact); default arrayBuffers signal guards the backing stores
   (the B-08 blindness, covered natively). mustFail lane stays;
   thresholds stay default.
9. **Baseline then re-measure**: assertOps push/popMin churn against the
   DRAFT (undoored) BEFORE landing doors; same number against the
   shipped class after; within noise (>= 0.90 floor). Both numbers +
   provenance (node/machine/date) into CHANGELOG and decision 0003.
10. **bench/ floor**: popMin vs (a) naive 32-tier linear scan, (b)
    binary heap of (priority, seq) pairs -- same workload,
    provenance-stamped. The claim: two instructions vs a scan, visible
    when > 1 tier is populated.
11. **Docs + drift**: Scheduler.d.ts full FastBitScheduler declarations
    (class, EMPTY, getters -- no undeclared members); dts-drift.test.js
    extended to both members; llms.txt new member section (API,
    contract, the -1/EMPTY rule, the handle law, the D-07 memory
    table); README gains a MINIMAL new-member section only (re-spine is
    F3).
12. **CHANGELOG 1.1.0** (Added-heavy: the member, the doors, the surface,
    the lanes; Measured with task-9/10 numbers) + three-place sync
    1.1.0 + lockfile refresh.

## ASSERTIONS (falsifiable, each one checked by qa)

- The 1M-op fuzz is green against the SHIPPED class (not the draft),
  conservation invariant after every op, replayable by printed seed.
- Every D-01..D-06 door/surface test: RED against the draft captured in
  the session log, GREEN after -- honest counts (D-07 is a decision +
  doc table, not a red).
- `push(-1, p)` throws; the D-01 stranded-drain repro is impossible by
  construction. `push({}, p)`, `push(NaN, p)`, `push(1.5, p)`,
  `push(2**31, p)`, `push('7', p)` all throw -- nothing coerces.
- `new FastBitScheduler(2**31)` throws naming the ceiling; 0, -5, NaN,
  1.5, Infinity each throw; nothing silently clamps; `capacity` /
  `requestedCapacity` report the truth (e.g. 1000 -> 1024 observable).
- `sizeOf(32)` / `sizeOf(-1)` / `sizeOf(1.5)` throw -- never undefined.
- Tier 31 with `activeMask < 0`: push/pop/peek/size/clear/conservation
  all correct.
- The frame scheduler is byte-identical: the createScheduler / schedule
  / performWork hunks are EMPTY in the Scheduler.js diff; existing 63
  unit tests + frame-scheduler torture lanes pass unmodified.
- t6 FastBit lane: maxMajor 0, maxArrayBuffersGrowth 0, stabilize deep;
  buckets byteLength + cursor columns byte-identical across churn.
- `npm run perf` green: detector self-validates, mustFail trips,
  push/popMin scenario ~0 scavenges at N and k*N, buckets-byteLength
  counter delta 0. No allow-flags anywhere.
- assertOps within noise of the draft baseline (>= 0.90); floor bench
  numbers recorded with provenance; all numbers in CHANGELOG.
- `npm test` green (63 prior + the new suite, zero skipped); torture
  prints exactly `ok`; every control fails on demand; `npm run verify`
  exit 0 end to end.
- `npm pack --dry-run`: exactly 7 files, the draft ABSENT from tree and
  tarball, test/ + decisions/ excluded, d.ts + llms.txt + CHANGELOG
  present.
- ASCII grep zero hits (U+00D7/U+00B5 excepted); three-place sync at
  1.1.0; dts-drift green over both members.

## NON-GOALS

No cancellation FEATURE (the generation-check recipe is consumer-side,
documented in F3). No atomics / SharedArrayBuffer / MPSC (C4). No
frame-scheduler internal changes -- no mask routing retrofit (C1). No
`drain(cb)` (0005). No README re-spine, no example/ work (F3). No
budget or threshold widening anywhere. No commits -- the working tree
is left for /release 1.1.0.

## DONE WHEN

the class ships from Scheduler.js with every door closed and the draft
deleted; fuzz green at 1M against the shipped code with conservation
after every op; alloc + perf gates green and red-capable; the floor
bench and door cost are measured and recorded; the frame scheduler is
proven byte-identical; `npm run verify` is green end to end
