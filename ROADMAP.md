# @zakkster/lite-scheduler -- enriched roadmap (dual-scheduler family)

Modeled on `../BLUEPRINT_ROADMAP.md`: shared law, decisions on the record,
session briefs anchored to findings, a torture-suite spec modeled on
`../LiteLru/test/`, and conservation invariants that catch whole bug classes
at once. Companion documents: `RESEARCH.md` (the two-primitive analysis that
produced this plan) and `FastBitScheduler.draft.js` (consumed by session F2,
then deleted).

**Every finding in section 2 was reproduced by running code on 2026-09-13**,
not inferred from reading. Probe outputs are quoted verbatim.

---

## 0. The verdict (read this first)

**The idea is right: one package, two schedulers, segregate later if adoption
says so.** The precedent is `../LiteLru` -- a family of cache policies under
one roof, tree-shakeable to one member, proven by ONE harness. This package
becomes the scheduling equivalent:

| Member | Kind | Problem it owns |
| --- | --- | --- |
| `createScheduler` (shipped, v1.0.1) | Time-aware, function-oriented, MessageChannel-driven | Browser frame budget: input stays responsive under thousands of background tasks |
| `FastBitScheduler` (draft) | Pure, handle-oriented, O(1) 32-tier bucket queue | Engine / ECS / job-system priority routing: pop the highest-priority handle in two instructions, zero time, zero macrotask |

They share one intellectual lineage (RESEARCH.md), one law (zero-GC), one
harness, one README -- and nothing at runtime. Neither imports the other.
That is exactly the LiteLru shape, and it is cheaper than two packages in
every dimension that matters today: one torture gate, one release drill, one
docs spine, one npm page telling one coherent story ("the two schedulers,
one law").

**Why not fold the bit-mask routing INTO the frame scheduler instead**
(RESEARCH.md options 1-3): the frame scheduler's lane scan is at most 4
iterations over 4 SLL heads -- the mask turns a 4-step loop into 2
instructions on a path dominated by `performance.now()` calls and task
invocation. The measurable win is in the standalone primitive, not in
retrofitting the shipped one. The retrofit stays on the candidates ledger
(C1) behind a benchmark, per the B3 lesson: never change two things at once.

**Registry facts (verified 2026-09-13; re-verified 2026-09-14 after the F0
publish):**

| Check | Result |
| --- | --- |
| `@zakkster/lite-scheduler` | 200, latest **1.0.2** (F0 shipped + published 2026-09-14), repo metadata correct (points at its own repo -- unlike the cross-wired lite-arena case in the blueprint) |
| `@zakkster/lite-fastbit-scheduler` | **404 -- the segregation name is free** (C2) |
| `@zakkster/lite-gc-profiler` | 1.16.0 (devDep pin `^1.16.0`) |
| `@zakkster/lite-leak` | 1.10.0 (devDep pin `^1.10.0`) |
| `@zakkster/lite-perf-gate` | **1.4.2** (devDep pin `^1.4.2` from F1 -- the sync-lane scavenge-scaling gate) |

**The single most important probe result:** the draft's core algorithm
survived a 200k-op differential fuzz against a brute-force oracle --
identical results, FIFO within tier, min-tier across tiers, mask/count
conservation intact, tier 31 (sign bit) correct, full-tier throw at the door
with state intact after. **Every defect found in the draft is at the door
(validation/contract), none in the mechanism.** The hardening work in F2 is
therefore additive: guards and surface, not surgery. Any storage restructure
(decision 0003) must keep that fuzz green -- it is the proof the mechanism
carries forward.

Why lite-fastbit32 and lite-ring-buffer matter here: the suite law is zero
runtime deps, so the scheduler INLINES both patterns rather than importing
them -- but the patterns arrive pre-proven. `activeMask` is a FastBit32
value; "highest priority = lowest set bit" is `FastBit32.lowest()` (`x & -x`
then `clz32`); each tier is a lite-ring-buffer with the pow2 mask-wrap
discipline. The draft already inlines both correctly (the fuzz says so), and
their test suites are the model for the tier tests.

---

## 1. Shared law (holds across every session)

1. **Two members, one file.** `Scheduler.js` exports both. `sideEffects:
   false` + named exports keep it tree-shakeable to one member (the LiteLru
   precedent). No second entry point, no subpath exports -- segregation, if
   it ever happens, is C2's procedure, not an exports-map hack.
2. **Neither member may import, construct, or reference the other.** The
   package is a family, not a stack. A future split must be a file move,
   not a refactor.
3. **Fail closed at the door, free in the body.** Every argument is
   validated where it enters (constructor, `push`, `schedule`); the hot
   bodies (`popMin`, the flush loop) gain zero instructions. A caller bug
   throws a library-named error at the call site -- it never becomes a
   silently-corrupted ring or a task in the wrong lane. Null is not zero;
   `-1` is not a handle; NaN is not a priority.
4. **The handle contract is signed Int32, non-negative.** Storage is
   `Int32Array`; `EMPTY = -1` is the one out-of-band value and it is
   exported, never hard-coded by consumers. Handles `>= 0` keeps every
   stored value SMI and keeps `-1` unambiguous. (Consequence for lite-arena
   interop: arena HANDLES go negative at generation >= 2048 by design --
   consumers store the arena slot INDEX, not the handle. F3 documents this.)
5. **Zero allocation on any steady path.** `push`/`popMin`/`peekMin` and the
   frame scheduler's schedule/flush cycle allocate nothing after
   construction. The gates: `maxMajor: 0`, `maxArrayBuffersGrowth: 0`,
   `stabilize: 'deep'` -- ArrayBuffer growth gated explicitly because the
   heap gate is documented blind to it (the B-08 lesson; every buffer in
   this package is a typed-array backing store).
6. **Every gate must be able to fail.** Controls for each tier, wired to
   `LSCHED_TORTURE_BREAK`, must exit non-zero. A green gate without a red
   control is decorative.
7. **A test that names a hazard must exercise the code path where the
   hazard lives** (the AR-02 lesson). Concretely: every finding below gets
   a test that FAILS against the pre-fix code and passes after. Prove both
   directions once; the blueprint's worst finding hid behind a test named
   for it.
8. **ASCII-only** in every shipped file and test (U+00D7 / U+00B5 excepted).
   `node:test` only. CHANGELOG + llms.txt + VERSION three-place sync from
   F0 forward. README spine per `../LiteSepforge/README.md` (F3).

### The conservation invariants

FastBitScheduler -- checked between torture phases, O(32), never on the hot
path:

```
for every p in 0..31:  ((activeMask >>> p) & 1) === (counts[p] > 0 ? 1 : 0)
sum(counts) === size
0 <= counts[p] <= capacity
```

The first line catches every mask/count desync (a lost bit-clear, a phantom
bit, a D-01-class poisoned drain) immediately. The frame scheduler's
equivalent -- `activeTasks + freeListLength === poolCapacity` -- is hidden
inside the factory closure; F1 decides between a checked-mode accessor and
behavioral gating (see the F1 brief).

---

## 2. Verified findings

Reproduced 2026-09-13 against the working tree (`Scheduler.js` at v1.0.1,
`FastBitScheduler.draft.js` as staged). Severity: **S1** = silent data loss
or corruption, **S2** = broken documented guarantee, **S3** =
hygiene/contract gap, **LAW** = suite-law violation.

### The shipped frame scheduler (`Scheduler.js`, published v1.0.1)

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **S-01** | **S2** | **A NaN priority jumps the queue into the UserInput lane.** The doc contract says "out-of-range values are coerced to Normal", and the range check `p < UserInput \|\| p > Idle` is false for NaN, so NaN slides past coercion; `(NaN - 1) \| 0 === 0` routes it to SLL index 0 = UserInput. A malformed priority lands in the MOST privileged lane and preempts correctly-scheduled Normal work. | `schedule(A, Normal); schedule(B, NaN)` -> executed `["nan","normal-first"]` |
| **S-02** | S2 | In-range fractional priorities silently truncate to the lane below: `3.7` -> Background (a demotion), `2.5` -> Normal. Undocumented; the doc says only integer constants exist. | `schedule(A, 3.7); schedule(B, Normal)` -> executed `["normal","frac3.7"]` |
| **S-03** | S3 | `config.onError` is not validated. A non-callable sink converts the FIRST task error into an uncaught exception thrown from inside the flush loop -- the error SINK is the crash vector, and it detonates at flush time, far from the config mistake. | `createScheduler({onError:'x'})` + throwing task -> `uncaughtException: onError is not a function` |
| **S-04** | S3 | `schedule(null)` is accepted at the door; the TypeError surfaces at execution time inside the flush, routed to onError. Deferred, disconnected from the caller's stack. Decide: throw at the door vs document the deferral. | `schedule(null)` -> onError receives `TypeError: fn is not a function` |
| **S-05** | LAW | Test suite is **vitest** (devDep, `"test": "vitest run"`), not node:test. 36 tests, 3 `vi.fn()` spies, no fake timers -- a mechanical port. | `package.json`, `test/Scheduler.test.js` |
| **S-06** | LAW | Non-ASCII in shipped files: `Scheduler.js` (4 lines: em-dashes, box-drawing rules), `Scheduler.d.ts` (2), `llms.txt` (16), `README.md` (79), `test/Scheduler.test.js` (31). | `grep -nP '[^\x00-\x7F]'` |
| **S-07** | LAW | **No torture gate.** No lite-gc-profiler / lite-leak devDeps. Every zero-GC claim in the README -- including "destroy() plugs the MessageChannel leak" -- is asserted, never gated. The pipeline law (`node --expose-gc test/torture.mjs`) cannot run. | repo |
| **S-08** | LAW | No `CHANGELOG.md`, no `VERSION` export, `files[]` lacks CHANGELOG. Two-place sync at best. | `package.json` |
| **S-09** | S3 | README spine predates the LiteSepforge blueprint (no positioning H2, no Composability pipeline, no Zero-GC design notes table, no Ecosystem section); bench numbers (May 2025) carry no provenance stamp. | compare to `../LiteSepforge/README.md` |

Positive verifications, for the record: integer out-of-range priorities DO
coerce to Normal as documented (`schedule(fn, 99)` probe); config validation
for `budgetMs` / `maxTasks` / `onCapacityExceeded` throws correctly; repo
metadata on the registry is correct.

### The draft (`FastBitScheduler.draft.js`)

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **D-01** | **S1** | **A pushed `-1` poisons the canonical drain loop and strands live work.** The header states the contract ("items MUST be non-negative... a stored -1 would collide with EMPTY") but nothing enforces it. `push(-1, 0)` is accepted; `while ((h = popMin()) !== EMPTY)` pops the -1, reads it as "queue empty", and exits with real items still enqueued in lower tiers. Silent, and the stranded work never runs. | `push(-1,0); push(7,1)` -> drain saw `[]`, `sizeOf(1) === 1`, `isEmpty() === false` after the "drain" |
| **D-02** | **S1** | Silent Int32Array coercion of items: `{}` -> `0` (a VALID-looking handle for someone else's slot 0), `NaN` -> `0`, `1.5` -> `1`, `2**31` -> `-2147483648` (a negative corrupt handle in the ring), `'7'` -> `7`. Every one is a caller bug converted into a plausible wrong answer. | `push` each -> popped `[0, 0, 1, -2147483648, 7]` |
| **D-03** | **S1** | **Constructor fails open on capacity.** `ceilPow2(n)` does `n \| 0` first, so `2**31` wraps negative and every pathological input clamps to 2: requested `2**31` -> cap **2**; `0`, `-5`, `NaN`, `1.5`, `Infinity` -> 2. A caller who asked for a billion-slot ring gets a two-slot ring and discovers it as "tier full" throws at runtime, nowhere near the constructor. | `new FastBitScheduler(2**31)._cap === 2` |
| **D-04** | S3 | `sizeOf(32)` / `sizeOf(-1)` / `sizeOf(1.5)` return `undefined` (out-of-bounds typed-array read). Fail open; `undefined > 0` is false so it even LOOKS like an answer. | probe |
| **D-05** | S3 | `EMPTY` is module-private. Every consumer hard-codes `-1`; the one out-of-band constant in the contract is not part of the API. | `'EMPTY' in module === false` |
| **D-06** | S3 | No `size`, no `clear()`, no capacity introspection. The silent pow2 round-up (1000 -> 1024) is observable only through the underscore-private `_cap`. lite-ring-buffer solved this with `requestedCapacity` -- follow it. | API surface |
| **D-07** | note | Fixed cost: 32 rings are always allocated -- 128 KiB at the default `capacityPerTier` 1024 (32 x 1024 x 4B) plus three 32-slot cursor columns, even for a 3-tier consumer. Not a bug (it IS the zero-GC promise); it is a decision to make explicit (0003: `numTiers` option vs documented fixed cost). | `buckets` byteLength sum = 131072 |

Positive verifications, for the record: **200k-op differential fuzz vs
oracle IDENTICAL** (push/popMin/peekMin, random tiers, conservation checked
after every op); tier 31 works with the mask sign bit set; a full-tier
`push` throws at the door and the tier drains intact afterwards; the file is
already ASCII-clean.

---

## 3. The torture suite (`test/torture.mjs`) -- spec

Modeled on `../LiteLru/test/` -- the same entry contract, the same tier
vocabulary, one harness proving both members. LiteLru is the bulletproof
reference: unit suites per member + `torture.mjs` gate + `controls.mjs` +
`dts-drift.test.js` + seeded replay. Adopt the shape wholesale.

### Layout

```
test/
  Scheduler.test.js          # ported 36+ unit tests (frame scheduler), node:test
  FastBitScheduler.test.js   # new boundary suite (F2), node:test, LiteLru density
  dts-drift.test.js          # public surface <-> Scheduler.d.ts <-> llms.txt, both members
  controls.mjs               # gate-must-fail runner (no --expose-gc, BREAK variants)
  perf.test.mjs              # lite-perf-gate zgcSuite -- sync-lane scavenge-scaling gate (F1+)
  torture.mjs                # entry: sequential tiers, prints exactly "ok", exit 0/1/2
  torture/
    harness.mjs              # seeded xorshift32, scratch pools, zero-alloc asserts, replay
    t0-laws.mjs              # metamorphic scheduling algebra
    t1-degenerate.mjs        # every door from section 2
    t2-adversarial.mjs       # sequences crafted to break cursors, lanes, lifecycle
    t5-fuzz.mjs              # differential fuzz vs oracles, 1M ops
    t6-alloc.mjs             # zero-alloc gates (sync + async lanes)
    t7-soak.mjs              # lite-leak lifecycle churn + conservation
    t9-controls.mjs          # every gate above, deliberately broken, must fail
```

`test/` never enters `files[]`; `npm pack --dry-run` proves it every session.

### Entry contract (mirrors `../LiteLru/test/torture.mjs` exactly)

- `--expose-gc` guard first: missing -> stderr remedy, **exit 1**.
- Peer preflight second: `@zakkster/lite-gc-profiler` and
  `@zakkster/lite-leak` imported dynamically; missing -> remedy, **exit 2**.
- Tiers run STRICTLY SEQUENTIALLY (the profiler is one-measurement-at-a-time
  and throws if nested). Success prints exactly `ok`, exit 0.
- Every failure prints the seed and the replay command:
  `TORTURE_SEED=<n> node --expose-gc test/torture.mjs`.
- `LSCHED_TORTURE_BREAK=1` injects a retained allocation into the t6 hot
  loop; the gate must then fail, or the run fails for the control passing.

### Harness rules (inherited, non-negotiable)

- All schedulers, scratch buffers and oracles allocated ONCE outside loops.
- Hot-loop assertions compare into pre-allocated scratch; message strings
  built only on failure (a template literal per iteration fails its own gate).
- The frame scheduler is macrotask-driven: its alloc lane uses
  `measureOpsAsync` (schedule -> flush-complete cycles); FastBitScheduler's
  lane uses plain `measureOps` (pure sync). Never nested, always sequential.
- Unknown profiler rule keys throw (v1.10+); read
  `node_modules/@zakkster/lite-gc-profiler/llms.txt` for the current
  surface before writing a gate -- do not write rule objects from memory.
- Never resolve an unexpected `inconclusive` with `allowInconclusive`.

### Tier map

**t0 -- laws.** FastBitScheduler: `popMin` always returns from the lowest
set tier; FIFO within a tier under ANY interleave of pushes (metamorphic:
merge two push sequences, pop order preserves per-tier order); `peekMin`
equals the next `popMin` and removes nothing; `isEmpty() <=> activeMask ===
0 <=> size === 0`; push/pop round-trips bit-exact for handles {0, 1,
2^31-1}. Frame scheduler: within one flush, Immediate drains before
UserInput before Normal before Background before Idle; FIFO within a lane;
work scheduled mid-flush still runs; the budget yield resumes on the next
macrotask with nothing lost.

**t1 -- degenerate (the doors).** Every case from section 2, pinned by
name: D-01 (-1 handle), D-02 (each coercion class), D-03 (each bad
capacity), D-04 (sizeOf abuse), S-01 (NaN priority), S-02 (fractionals),
S-03 (bad onError), S-04 (non-function task), priority 32 / -1 / 1.5 /
`'3'` / Infinity on `push`. In F0 these register as `todo` documenting
today's behavior; F1/F2 flip them to enforced doors.

**t2 -- adversarial.** Wrap-boundary churn (push/pop cycling `cap + 1`
times per tier so head/tail lap the ring); fill-to-cap -> throw -> drain ->
refill (the D-08 positive, kept as a regression); all 32 tiers saturated
then drained; tier 31 alone (mask sign bit); alternating 0/31; pop-empty
storms interleaved with pushes. Frame scheduler: an Immediate task that
schedules another Immediate task (bounded -- assert the documented
starvation semantics); `destroy()` called from inside a running task;
`schedule` during flush; capacity policy x {throw, grow, drop} at the
boundary; `yieldTask` resolution order.

**t5 -- differential fuzz.** FastBitScheduler vs a 32-plain-arrays oracle:
1M seeded mixed ops (push 55% / popMin 35% / peekMin 10%), compare every
result, check the conservation invariant after every op, replayable by
seed. Frame scheduler vs a recorded-order oracle: seeded schedule patterns
across all five priorities, assert the executed order equals the oracle's
predicted lane-then-FIFO order, budget interruptions included.

**t6 -- the zero-alloc gates.** FastBitScheduler lane: steady-state mixed
push/popMin churn under `measureOps`, `{maxMajor: 0,
maxArrayBuffersGrowth: 0, stabilize: 'deep'}` -- rings must never grow.
Plus the direct structural assertion no heap gate can substitute for:
`buckets[p].byteLength` and cursor-column lengths identical before/after.
Frame scheduler lane: `measureOpsAsync` over schedule->flush cycles at
steady pool size, same rules; `stats()` and `yieldTask` are documented
allocators and stay OUT of this loop.

**t7 -- soak + conservation.** lite-leak: 4096 cycles of
`createScheduler()` -> schedule -> flush -> `destroy()` -- **the
MessageChannel-leak claim finally gated** (S-07). FastBitScheduler: 4096
fill/drain cycles, conservation invariant checked after every cycle, heap
sampled across cycles not within one.

**t9 -- controls.** The BREAK-injected allocation trips t6; a control
scheduler with the item door removed must fail t1; a corrupted oracle must
fail t5; a control that skips `destroy()` must fail t7; `controls.mjs`
verifies the no-`--expose-gc` exit 1 and missing-peer exit 2 paths.

### The perf gate (`test/perf.test.mjs`, F1 forward)

`@zakkster/lite-perf-gate` 1.4.2 joins as the third instrument. Division of
labor: torture t6 owns the ASYNC flush lane (gc-profiler majors + heap
ceiling + pool byte-identity -- the macrotask fixture floor makes per-op
byte gating dishonest there); the perf gate owns the SYNC lanes, where its
scavenge-scaling verdict (zero-alloc => ~0 scavenges at N AND k*N) is the
sharpest available instrument. F1's door work is all sync (schedule()
enqueue, construction); F2's FastBitScheduler is pure sync -- both land
squarely in its lane.

- Own script (the flags differ from both `test` and `torture`):
  `node --expose-gc --max-semi-space-size=4 --test test/perf.test.mjs` as
  `"perf"`; `verify` becomes test && perf && torture && torture:controls.
- `zgcSuite` is the primary API: scenarios `{name, setup, hot(state, n),
  statsOf?, teardown?}`. `statsOf` runs outside the measurement window, so
  reporting `stats().poolCapacity` (itself a documented allocator) as a
  counter with max delta 0 is legal -- and proves the pool never grows
  under churn.
- Law 6 is satisfied natively: the detector self-validates on every
  invocation (positive + negative controls; refuses to judge, code 2, if
  either fails) and `config.mustFail` scenarios must trip in-process.
  `controls.mjs` gains one arm: the perf file run without `--expose-gc`
  must fail loudly (measure() throws, naming the run command).
- Surfaces are read fresh each session from node_modules (lite-perf-gate
  llms.txt + COOKBOOK.md; its trio example pairs it with gc-profiler and
  lite-leak in one suite). Never from memory.
- Thresholds never widen; `allowNoGc` never appears in a gated run.

---

## 4. Session order

```
F0 --> F1 --> F2 --> F3          (strictly in order; each is one /release)
                      \
                       C1..C4    (candidates ledger -- decisions, not sessions)
```

F0 blocks everything: no session ships unproven, and the gate is F0's
deliverable. F1 before F2 so the two members' door philosophies land
consistently (F2's doors are stricter; shipping them while the frame
scheduler still routes NaN to UserInput would make the package argue with
itself). F3 last because docs written before the surface stops moving get
written twice (the R4 lesson).

---

## 5. The briefs

===============================================================================
# F0 -- v1.0.2 -- law compliance + the torture harness (no behavior change)
===============================================================================

```markdown
---
package: "@zakkster/lite-scheduler"
version_target: 1.0.2
status: shipped -- /release gates green; published to npm 2026-09-14 (latest 1.0.2)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [S-05, S-06, S-07, S-08]
blocks: [F1, F2, F3]
---

# lite-scheduler -- enforce the law, stand up the gate

PURPOSE
  The package predates the suite law: vitest, non-ASCII source, no torture
  gate, no CHANGELOG, no VERSION. Nothing else can be trusted until one
  command proves the package. This session changes zero behavior.

TASKS
  - Port test/Scheduler.test.js to node:test. All 36 tests survive:
    `vi.fn()` (3 uses) -> `mock.fn()` from node:test; `expect().toThrow` ->
    `assert.throws`; keep the flush() helper as-is. `"test": "node --test
    test/*.test.js"`. Remove the vitest devDep.
  - ASCII scrub: Scheduler.js (4 lines), Scheduler.d.ts (2), llms.txt (16),
    README.md (79), test file (31), bench/bench.js (42 -- bench is source
    too; example/*.html waits for F3's demo session). Comment rules become
    `---`, em-dashes become `--`. Zero logic in the diff (verify: diff
    touches only comments and docs).
  - CHANGELOG.md born: retroactive 1.0.0 / 1.0.1 entries, then 1.0.2 with a
    Known Issues section recording S-01..S-04 verbatim (fixed in F1, not
    here). Add to files[].
  - `export const VERSION = "1.0.2"` from Scheduler.js; three-place sync
    (package.json / VERSION const / llms.txt header -- the lite-law
    definition; CHANGELOG gets the entry as well) from now on.
  - devDeps: @zakkster/lite-gc-profiler ^1.16.0, @zakkster/lite-leak ^1.10.0.
  - Build test/torture.mjs + harness + controls per section 3, with the
    FRAME-SCHEDULER lanes live: t0 (lane order, FIFO, budget resume),
    t2 (lifecycle adversarial), t5 (recorded-order oracle), t6 (async alloc
    gate), t7 (4096 create/destroy MessageChannel soak), t9 (controls).
    t1 doors registered as `todo` documenting TODAY's behavior (NaN ->
    UserInput etc.) so F1 has red tests waiting.
  - scripts: test / torture / torture:controls / bench / verify, mirroring
    ../LiteLru/package.json.
  - test/dts-drift.test.js: every export of Scheduler.js appears in
    Scheduler.d.ts and in llms.txt, both directions.

ASSERTIONS
  - `node --test` green, 36+ passing; grep proves no vitest import remains.
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0.
  - `node test/torture.mjs` (no flag) exits 1; missing peer exits 2;
    LSCHED_TORTURE_BREAK=1 exits non-zero.
  - The t7 soak passes -- the destroy() MessageChannel claim is now gated.
  - `grep -rnP '[^\x00-\x7F]' *.js *.ts *.txt *.md test/` -> zero hits
    (U+00D7/U+00B5 excepted).
  - `npm pack --dry-run` includes CHANGELOG.md, excludes test/ and
    FastBitScheduler.draft.js and RESEARCH.md and ROADMAP.md.

NON-GOALS
  No behavior change of any kind. No door fixes (F1). No FastBitScheduler
  (F2). No README re-spine (F3) -- the ASCII scrub is mechanical only.

DONE WHEN
  one command proves the package; the law violations are zero; the S-01..
  S-04 doors exist as named `todo` tests waiting to flip
```

===============================================================================
# F1 -- v1.0.3 -- the priority door (make the documented contract true)
===============================================================================

```markdown
---
package: "@zakkster/lite-scheduler"
version_target: 1.0.3
status: shipped -- /release 1.0.3 gates green 2026-09-14
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
findings: [S-01, S-02, S-03, S-04]
depends_on: [F0]
blocks: [F2]
---

# lite-scheduler -- a malformed priority must not outrank real work

PURPOSE
  The documented contract -- "out-of-range values are coerced to Normal" --
  is false for exactly the malformed inputs most likely to appear (NaN from
  a broken computation, a float from a config file). NaN lands in the MOST
  privileged lane and preempts correct work; 3.7 silently demotes to
  Background. Make the sentence in the docs true for every input.

TASKS
  - S-01/S-02: after the Immediate check, the sanitize step becomes
    "anything that is not an integer in [UserInput..Idle] is Normal":
    `if ((priority | 0) !== priority || priority < 1 || priority > 4)
    priority = 2`. Pin by name: NaN, 3.7, 2.5, -1, 99, Infinity, '3' each
    land in Normal; the S-01 probe (schedule Normal then NaN, assert order)
    ships as the regression test and MUST fail against v1.0.2 first.
  - S-03: validate `config.onError` at construction -- not callable ->
    throw the same library-error shape as the other config validators.
    Cold path, zero tradeoff.
  - Unknown config keys (lite-law: "an unknown option key is an error with
    a did-you-mean hint, never a silent ignore"): createScheduler currently
    ignores `{maxTask: 5000}` (typo for maxTasks) silently. Reject unknown
    keys at construction with the nearest-key hint. Cold path.
  - S-04 DECISION (record in decisions/0001-task-door.md before coding):
      A. Throw at the door: `typeof fn !== 'function'` -> TypeError at
         schedule(). One typeof on the enqueue path (not the flush loop).
         Fail closed, error at the caller's stack. CHANGELOG "Changed".
      B. Keep the deferral, document it: the current behavior routes the
         TypeError to onError at flush time. Zero code, one doc paragraph.
    Recommendation: A. The enqueue path is not the hot body (the flush loop
    is), the cost is one branch, and "the error surfaces where the bug is"
    is worth a patch-note. Measure and record either way.
  - Decide (same file) the frame scheduler's conservation observability:
    a `_debug()` accessor exposing free-list length under a flag vs
    behavioral gating only (schedule/execute N <= capacity tasks repeatedly;
    stats().poolCapacity must never grow). Recommendation: behavioral only
    -- no new surface on a shipped closure for a property the torture suite
    can prove from outside.
  - Stand up the perf gate (section 3, "The perf gate"): devDep
    @zakkster/lite-perf-gate ^1.4.2; test/perf.test.mjs via zgcSuite --
    the enqueue-door scenario (pre-sized pool, 'drop' policy, hoisted
    noop task; ~0 scavenges at N and k*N; stats().poolCapacity counter
    delta 0 via statsOf) plus a mustFail scenario (per-op closure) that
    trips; the `perf` script; `verify` chain extended; the controls.mjs
    arm that runs it without --expose-gc. The gate covers the NEW door
    branches.
  - Flip the F0 `todo` doors to enforced green tests.
  - CHANGELOG under Fixed (S-01/S-02 are doc-conformance bugfixes) and
    Changed (S-03 validation, unknown-key rejection, S-04 if A).

HOT PATH
  The flush loop gains zero instructions -- every change is in schedule()
  (enqueue) or createScheduler() (construction). Gate schedule() anyway,
  twice: the perf gate's scaling verdict proves the doored enqueue path
  still allocates nothing (~0 scavenges at N and k*N); assertOps proves
  throughput within noise of v1.0.2 (baseline measured BEFORE the doors
  land). Both numbers recorded in the CHANGELOG.

ASSERTIONS
  - The S-01 regression: fails against v1.0.2, passes after. Both proven.
  - Every t1 frame-scheduler door green; torture "ok"; controls fail.
  - Full unit suite green; no test weakened to pass.
  - `npm run perf` green: detector validated, mustFail trips, enqueue
    scenario ~0 scavenges at both scales, poolCapacity delta 0.
  - createScheduler({maxTask: 5}) throws naming `maxTasks`.
  - assertOps enqueue-path number recorded (pre-door baseline + after).

NON-GOALS
  No new features. No FastBitScheduler. No change to documented
  Immediate-ring or capacity-policy semantics.

DONE WHEN
  the doc sentence is true for every input; the doors are enforced tests;
  the enqueue cost is measured and recorded
```

===============================================================================
# F2 -- v1.1.0 -- FastBitScheduler lands (the headline)
===============================================================================

```markdown
---
package: "@zakkster/lite-scheduler"
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

# lite-scheduler -- the O(1) 32-tier handle scheduler, hardened

PURPOSE
  The draft's mechanism is proven (200k-op fuzz, identical to oracle; tier
  31 correct; fail-closed capacity throw). Its doors are not: -1 poisons
  the drain loop, objects coerce to handle 0, and a constructor asked for
  2^31 slots silently builds 2. This session moves the draft into
  Scheduler.js with every door closed, full surface, and its own torture
  lanes -- WITHOUT disturbing the proven core (the fuzz stays green through
  every change).

DECISIONS (record BEFORE coding)
  decisions/0002-dual-family.md -- one package, one file, two members;
    neither references the other; segregation is C2's procedure. (This
    codifies section 0.)
  decisions/0003-storage.md -- ring storage shape:
      A. 32 separate Int32Array rings (the draft). Proven by the fuzz as-is.
      B. One flat Int32Array(32 * cap), index (p << log2cap) | i. One
         allocation, no 32 object headers, single-buffer SoA purity;
         requires re-running the full fuzz after the mechanical change.
    Recommendation: B only if assertOps shows it >= A; the fuzz green is
    the gate either way. This is a measurement, not a preference.
  decisions/0004-tiers.md -- fixed 32 vs `numTiers` option (2..32,
    default 32): a 4-tier consumer at capacityPerTier 4096 pays 512 KiB
    for 64 KiB of need under fixed-32. The option costs one constructor
    validation and changes the priority door bound from 31 to numTiers-1;
    zero hot-path cost. Recommendation: add it -- but the D-07 memory
    table goes in the README either way.
  decisions/0005-no-callbacks.md -- `drain(cb)` REJECTED: a callback
    re-enters user code while the structure is mid-mutation (the B4
    raycast lesson). The drain loop IS the API. On the record so it is
    not re-proposed.

TASKS
  - Move the hardened class into Scheduler.js as a named export; DELETE
    FastBitScheduler.draft.js in the same commit.
  - The doors (all throwing library-named errors, all at the door, zero
    instructions added to popMin/peekMin bodies):
      * constructor: capacityPerTier must be an integer, 1 <= n <= 2**24
        (documented ceiling; 2^24 x 32 tiers x 4B = 2 GiB, already absurd).
        D-03 dies here. numTiers per decision 0004.
      * push: priority integer within bounds (draft already has it);
        item must satisfy `(item | 0) === item && item >= 0`. Two compares
        on the enqueue path. D-01 and D-02 die here.
      * sizeOf: priority validated the same way. D-04 dies.
  - The surface (D-05/D-06):
      * `export const EMPTY = -1` (and re-exported meaningfully in d.ts).
      * `size` (O(1), an incrementally maintained counter), `clear()`
        (O(32) cursor+mask reset, no realloc, documented cold),
        `peekPriority()` -> tier index of the next pop or -1,
        `capacity` + `requestedCapacity` getters (the lite-ring-buffer
        precedent).
  - test/FastBitScheduler.test.js at LiteLru density: every D finding as a
    named before/after test (each MUST fail against the draft first --
    prove it once in the session log); tier-31 sign-bit named test; the
    D-08 full-throw-drain regression; FIFO-across-wrap; every door case.
  - Mine ../LiteFastBit32/FastBit32.test.js and
    ../LiteRingBuffer/RingBuffer.test.js for tier-test vectors -- the
    scheduler inlines their two patterns, so their edge cases are its edge
    cases: bit-31 sign-bit behavior, mod-32 wraparound abuse (the reason
    the priority door exists), signed/unsigned comparison traps on the
    mask, wrap-boundary churn, full/empty disambiguation. READ the files;
    do not rewrite their lessons from memory. (Patterns only -- neither
    package is imported: RingBuffer is Float32Array-backed and would
    silently corrupt handles above 2^24; FastBit32 is deliberately
    fail-open, the opposite of this door's contract.)
  - Torture: light up the FastBitScheduler lanes of t0/t1/t2/t5/t6/t7 per
    section 3. The t5 fuzz goes to 1M ops. Conservation invariant checked
    between phases and after every t5 op.
  - Perf gate: extend test/perf.test.mjs with the scenarios this
    instrument was built for (pure sync): push/popMin steady churn and
    the door-cost path; statsOf reports summed buckets byteLength as a
    counter (max delta 0 -- rings never grow, byte-exact); the default
    arrayBuffers signal guards the typed-array backing stores natively
    (the B-08 blindness, covered by the instrument itself).
  - bench/: add the honest floor -- popMin vs (a) a naive 32-tier linear
    scan and (b) a binary heap of (priority, seq) pairs, same workload,
    provenance-stamped (node version, machine, date) per the blueprint
    law. The claim to beat: two instructions vs a scan, visible when > 1
    tier is populated.
  - Scheduler.d.ts: full FastBitScheduler declarations (class, EMPTY,
    getters -- the B-14 lesson: no undeclared members). dts-drift.test.js
    extended to the new member.
  - llms.txt: new member section (API, contract, the -1/EMPTY rule, the
    handle law, the memory table). README: a minimal new-member section
    only (the full re-spine is F3).
  - CHANGELOG minor entry; VERSION 1.1.0; three-place sync.

HOT PATH
  popMin/peekMin bodies are UNTOUCHED from the draft (the fuzz-proven
  mechanism). push gains two integer compares (the item door) -- assertOps
  push/popMin churn within noise of the draft baseline, both numbers
  recorded in the CHANGELOG. The doors live at the door.

ASSERTIONS
  - The 1M-op fuzz is green against the SHIPPED class (not the draft), with
    the conservation invariant after every op.
  - Every D finding: named test, failed-before / passes-after, both proven.
  - t6: maxMajor 0, maxArrayBuffersGrowth 0, stabilize deep, over a mixed
    churn; buckets byteLength + cursor columns byte-identical before/after.
  - Perf gate: push/popMin scenario ~0 scavenges at N and k*N;
    buckets-byteLength counter delta 0; arrayBuffers within default.
  - The drain-loop repro from D-01 now THROWS at push(-1) -- the stranded-
    work scenario is impossible by construction.
  - `new FastBitScheduler(2**31)` throws naming the ceiling; every D-03
    input throws; nothing silently clamps.
  - Tier 31: push/pop/peek/size/clear all correct with activeMask < 0.
  - assertOps within noise; bench floor numbers recorded with provenance.
  - `npm pack --dry-run`: draft file gone, test/ excluded, d.ts + llms.txt
    + CHANGELOG present.
  - torture "ok"; every control fails.

NON-GOALS
  No cancellation FEATURE (the generation-check recipe is consumer-side
  and lands as F3 documentation). No atomics / SharedArrayBuffer / MPSC
  (C4). No frame-scheduler internal changes (C1). No drain(cb) (0005).

DONE WHEN
  the class ships with every door closed and the draft deleted;
  fuzz green at 1M against the shipped code; alloc gates green;
  floor bench recorded; d.ts/llms/CHANGELOG in sync
```

===============================================================================
# F3 -- v1.1.1 -- one story: docs, bench provenance, composability
===============================================================================

```markdown
---
package: "@zakkster/lite-scheduler"
version_target: 1.1.1
status: shipped -- /release 1.1.1 gates green 2026-09-14
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [S-09]
depends_on: [F2]
---

# lite-scheduler -- the README describes the family, on the blueprint spine

PURPOSE
  After F2 the package IS the dual-scheduler family; the README still
  describes the 2025 single-member package on a pre-blueprint spine. Docs
  sessions come last so they are written once (the R4 lesson).

TASKS
  - README re-spine per ../LiteSepforge/README.md, exactly: title +
    one-line blockquote tagline; badges; positioning H2 ("The scheduler
    pair the ecosystem was missing") with inline install + a runnable
    quick-start FOR EACH member; TOC; Why this exists; What you get; a
    <details> deep-dive per member (frame budget mechanics; the
    activeMask/lowest-set-bit trick); API reference (signatures + a
    constants table: Priority lanes, EMPTY, capacity ceiling, VERSION);
    Composability (see below); <details> Zero-GC design notes with the
    allocation table (what allocates: createScheduler, grow policy,
    yieldTask, stats -- and what NEVER does: schedule/flush steady state,
    push/popMin) + the gated numbers; Design decisions worth knowing
    (0001..0005 distilled); Testing (counts + npm scripts); What this is
    not (not a job system, not a thread pool, not lodash.debounce);
    Ecosystem; License. ASCII throughout.
  - The Composability section is the payoff of the dual design -- one
    runnable end-to-end pipeline: lite-arena spawns entities ->
    FastBitScheduler routes SLOT INDICES by priority tier -> the frame
    scheduler drains within budgetMs via shouldYield. Two mandatory
    caveats, stated loudly:
      * arena HANDLES go negative at generation >= 2048 (by design) --
        store the arena slot INDEX (always >= 0), never the handle;
        validate liveness on pop (isAlive) -- which IS the zero-alloc
        cancellation pattern from RESEARCH.md section 5: bump the
        generation to cancel, the pop-side check skips stale work.
      * FastBitScheduler is pure data -- pair it with the frame scheduler
        (or rAF) for TIME; nothing about it wakes up on its own.
      * tier naming via lite-fastbit32's BitMapper (a CONSUMER-side dep,
        never the scheduler's): `mapper.get('Physics')` returns an integer
        0..31 and throws on unknown names -- fail-closed tier names instead
        of scattered magic numbers. Hoist the indices at init; `.get()` is
        a lookup, not a hot-loop call.
  - llms.txt: full family rewrite (it is what a sibling package's pipeline
    reads -- a stale llms.txt is how a sibling hallucinates a signature).
    dts-drift.test.js already guards it; extend to assert every public
    member of BOTH classes appears.
  - Doc-count sync (folded in from the 1.1.0 release): the FastBit suite
    is 44 cases since qa's +7 pins (whole-run: 111). Two shipped sites
    still say 37 -- llms.txt:149 (the family rewrite must carry 44, not
    propagate 37) and the CHANGELOG 1.1.0 entry (line 43, "37-case");
    fix both, record the CHANGELOG correction in 1.1.1's Fixed section.
    Grep '\b37\b' across shipped docs before closing (the 48.37x bench
    multiplier is a false positive).
  - Bench: re-run bench.js on current node, stamp every README number with
    version + node + machine + date; the May-2025 numbers either re-measured
    or removed. FastBitScheduler floor numbers from F2 included.
  - example/ demos: verify both load against the new surface; audit
    demo hot-path code against the demo-audit law (no per-frame allocation,
    no forced reflow); fix or note.
  - CHANGELOG docs entry. The diff contains NO logic -- assert it.

ASSERTIONS
  - Spine section order matches LiteSepforge exactly; ASCII grep zero.
  - Every code block in README and llms.txt RUNS (paste-run check, the
    composability pipeline included).
  - Drift guard: every export in d.ts and llms.txt, both directions, both
    members; every relative link resolves.
  - Bench numbers stamped; no unstamped performance claim survives.
  - `npm pack --dry-run` unchanged except README/llms/CHANGELOG bytes.

NON-GOALS
  No behavior change, no new API, no version-inflating features. ROADMAP.md
  / RESEARCH.md stay repo-only (not in files[]).

DONE WHEN
  one README tells the two-member story on the blueprint spine; every
  number is stamped; every example runs; drift is CI-caught
```

---

### C -- the candidates ledger (decisions on record, not sessions)

- **C1 -- frame-scheduler internal mask routing** (RESEARCH.md options 1-3):
  replace the 4-SLL linear scan with an activeMask + per-lane function
  rings. DEFERRED: the scan is <= 4 iterations on a path dominated by
  `performance.now()` and task invocation; closures must live in object
  rings regardless (functions are not Int32 handles), so the win shrinks to
  the lane-select micro-op. Revisit only with a profile showing lane-select
  on the flame graph, as a v2.0.0 with the full B3-style discipline
  (behavior-identical by fuzz, benched before/after, never mixed with other
  changes).
- **C2 -- segregation trigger + procedure.** Split FastBitScheduler into
  `@zakkster/lite-fastbit-scheduler` (name verified free) WHEN a concrete
  signal appears: engine-side consumers adopting it independently of the
  frame scheduler, or the members needing different release cadences.
  Procedure: file move to the new package; lite-scheduler re-exports for
  one minor with a CHANGELOG pointer; then a deprecation note on the
  re-export. Until that signal: one package (decision 0002).
- **C3 -- REJECTED: `drain(callback)`** (decision 0005, the B4 lesson) and
  **weighted/aging tiers** (rotating masks -- a different data structure
  wearing this one's name; a consumer can implement aging by re-pushing at
  a higher tier).
- **C4 -- REJECTED for this package: atomics / SharedArrayBuffer / MPSC.**
  Cross-thread scheduling changes every invariant (counts stop being
  single-writer); it is lite-channel territory, not a mode of this class.
- **C5 -- example/ demo backlog** (noted in F3's audit; out of a docs
  session's scope; the one mechanical fix -- a dead per-frame `stats()`
  allocation -- already landed in F3). demo.html: per-frame uncached
  getElementById (~:441-442), unthrottled toLocaleString textContent
  (~:444-450), `Math.max(20, ...history)` spread (~:415), per-frame
  setLineDash arrays (~:431, :437), `:hover` not wrapped in
  `@media (hover: hover)` (:127, :132), pre-existing non-ASCII (em/en
  dashes, middle dot, box drawing) -- demos sit outside the shipped-doc
  ASCII guard. demo-scheduler-arena.html: importmap pins
  `@zakkster/lite-arena@1.0.1` + `@zakkster/lite-scheduler@1.0.1` via
  jsdelivr (:560-561; used surface exists so it functions, but stale and
  network-loaded, not file://), per-frame toFixed/toLocaleString with no
  ~10 Hz throttle (:956-970), uncached getElementById (:972-973),
  mouse* instead of pointer events (:793, :800), non-standard
  `performance.memory` (:963), unwrapped `:hover` (:149, :367, :438).
  One demo-law session clears both files.

---

## 6. How to run it

In order: F0 -> F1 -> F2 -> F3, `status: planned -> shipped` after each
`/release`. Author the brief in the package (BRIEF.md from the session
block above), then planner -> coder -> reviewer -> qa, then `/release`.
The budget frontmatter never moves: this package has one identity -- zero
allocation on the steady path, doors that fail closed -- for both members.

### If you only do a subset

1. **F0 first regardless** (DONE -- shipped + published 2026-09-14). Nothing is provable without the gate, and the
   MessageChannel-leak claim has been shipping ungated since 1.0.0.
2. **F2 is the point.** It is the reason this roadmap exists: the proven
   mechanism from the draft, hardened to the suite law, under the family
   roof. F1 is its prerequisite so the two members' doors agree.
3. **F1 is the only fix of published behavior** -- NaN outranking real work
   is the kind of bug a consumer hits from a single broken computation
   upstream, and the fix is doc-conformance, shippable in an afternoon.
4. **F3 makes it a product.** Until then the npm page still sells the 2025
   single-member package.

### The habit this roadmap is built around

Every finding in section 2 came from an executed probe; the two worst
(S-01, D-01) are invisible in review -- the code READS like it validates
(the draft's header even states the exact contract D-01 breaks) -- and
obvious in a five-line run. The AR-02 lesson applies verbatim: the draft
documents "items MUST be non-negative" in its header comment while
enforcing nothing; a reader who trusts the comment ships the drain-loop
strand. Comments are not doors. Doors are code, and every door in this
roadmap has a test that watched it fail first.

MIT (c) Zahary Shinikchiev
