# Changelog

All notable changes to `@zakkster/lite-scheduler` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-09-14

Docs-only release: the runtime surface is byte-identical to 1.1.0 -- the only
Scheduler.js change is the VERSION literal, and Scheduler.d.ts is untouched.
The diff carries no logic.

### Added

- test/docs.test.js: hermetic doc guards (spine order, relative links, ASCII,
  advertised-scripts-exist, provenance stamps), each a pure function over file
  text with a mutation control that proves it has teeth.
- dts-drift: llms.txt member parity for BOTH members, both directions (every
  documented method/getter appears in llms.txt; every `sched.`/`q.` member used
  in llms.txt is declared in the d.ts), plus a scrub control and a phantom
  `q.drain()` control.
- README Composability section: the lite-arena -> FastBitScheduler -> frame
  scheduler pipeline, with the slot-index/liveness zero-alloc cancellation
  recipe (store the arena slot INDEX, validate isAlive on pop) and the
  pure-data caveat.
- test/paste-run.mjs (repo-only): executes every runnable README/llms code
  block from the repo root; block classification is fail-closed (an unlisted
  fence is an error, not a skip).

### Changed

- README rebuilt on the LiteSepforge blueprint spine: the two-member family
  told once, one spine, two package-specific inserts (the handle contract,
  Benchmarks).
- llms.txt rewritten as a family document (frame member, FastBit member, shared
  invariants), every public member of both classes named.
- Every benchmark number re-measured and stamped (node v26.3.1, darwin arm64,
  2026-09-14); unstamped claims ("~330 lines", "5-10x", "2022 laptop") removed.
  The Testing section lists only npm scripts that exist.

### Fixed

- The published 1.1.0 entry understated the FastBitScheduler suite's case
  count: the qa boundary pins (+7) landed after the entry was drafted, so it
  read seven cases short. The suite is 44 cases; corrected in place above, and
  llms.txt carried the same stale count (now 44).

## [1.1.0] - 2026-09-14

The package gains a second, independent member. The frame scheduler is
byte-identical: `createScheduler`, `schedule`, and `performWork` are unchanged
(empty hunks in the 1.1.0 diff); every change is additive plus the `VERSION` line.

### Added

- `FastBitScheduler`: a 32-tier bucket priority queue with an O(1) bitmask routing
  table and one true ring buffer per tier, exported named from Scheduler.js. The
  package's second member; it and the frame scheduler never reference each other
  (decisions/0002).
- `EMPTY` (-1): the one out-of-band return from popMin/peekMin, now exported, so
  the canonical drain loop is writable by consumers.
- Doors (all fail closed, all at the door, all naming the library):
  - push: the item door -- (item | 0) === item && item >= 0. -1, {}, NaN, 1.5,
    2**31, '7' all throw; nothing coerces. (D-01, D-02)
  - constructor: capacityPerTier must be an integer 1..2**24; numTiers an integer
    2..32 (default 32). Nothing silently clamps. (D-03, decision 0004)
  - sizeOf: the priority door; it can never return undefined. (D-04)
- Surface: `size` (O(1) maintained), `clear()` (O(numTiers), cold, no realloc),
  `peekPriority()`, `capacity`, `requestedCapacity`, `numTiers`. (D-06)
- Torture lanes for the new member: t0 laws, t1 doors, t2 adversarial, t5 1M-op
  differential fuzz with the conservation invariant checked after every op, t6
  sync alloc lane, t7 4096-cycle soak, t9 controls C4/C5/C6.
- Perf-gate: a second zgcSuite covering push/popMin steady churn and the
  door-cost path, with summed-backing-store byteLength and size counters gated at
  delta 0.
- decisions/0002-dual-family, 0003-storage, 0004-tiers, 0005-no-callbacks.

### Changed

- VERSION -> 1.1.0.
- Error message prefix on the new member normalized to `lite-scheduler:` (the
  draft used `[scheduler]`; the draft was never published).
- llms.txt: the stale "36 node:test assertions" line corrected to 57 (frame
  scheduler; the reproducible `node --test` leaf count) plus the new 44-case
  FastBitScheduler suite. README's two "36" mentions corrected to match.

### Measured

Measured on node v26.3.1, darwin arm64, 2026-09-14 (gc-profiler 1.16.0, perf-gate
1.4.2), with the corrected bounded workload (residents in tiers 19 and 31 plus
single-occupancy churn tiers, so no tier approaches capacity).

- Door cost (measureOps, ops 200000, warmup 20000, stabilize deep, best-of-6):
  before (undoored draft) opsPerSec = 64921891; after (shipped) opsPerSec =
  59859325; ratio 0.922 (floor 0.90). majorsPerKOp 0 and maxPauseMsPerOp 0.000 on
  both arms. (The ratio is a conservative floor: the draft arm is both undoored
  and a small standalone module while the shipped arm is both doored and the large
  module, so both differences push the ratio the same way.)
- Storage layout (decision 0003): measured against a standalone layout-A twin to
  remove the module-shape confound. A (32 rings) best 58258083 ops/s vs B (one
  flat array) best 62460962 ops/s; adopted A. B's ~7% best-of edge sits inside
  A's own ~15% run-to-run variance, so it is not the clear outside-noise win the
  adoption rule requires against the default; the 1M fuzz on B was therefore moot
  and not run.
- Floor bench (bench/fastbit-floor.mjs), popMin vs a naive 32-tier linear scan
  and a binary heap of (priority, seq) pairs, 512 items/tier, pops/sec (M/s):

  | populated tiers | FastBit popMin | naive scan | binary heap |
  |---:|---:|---:|---:|
  | 1  | 33.4 | 28.3 | 19.5 |
  | 8  | 127.6 | 78.4 | 27.5 |
  | 32 | 122.4 | 145.4 | 21.1 |

  FastBit beats the (priority, seq) heap ~5.8x at every tier count, and beats the
  naive scan 1.2-1.6x when the populated tiers are high (the scan pays for the
  distance to the lowest set bit). Honest crossover: at 32 populated tiers, tier 0
  is always live, so the scan short-circuits immediately and edges the mask
  (0.84x) -- the mask's guarantee is distribution-independent O(1), which matters
  when the lowest populated tier is high or unpredictable.

## [1.0.3] - 2026-09-14

The documented priority contract becomes TRUE for every input, and misuse now
fails closed at the call site instead of detonating one macrotask later. The
flush loop (`performWork`) is byte-identical to 1.0.2; every change lives in the
`schedule()` enqueue door or the `createScheduler()` construction prologue. This
release resolves the S-01..S-04 Known Issues recorded in 1.0.2.

### Added

- The perf gate: `test/perf.test.mjs` on `@zakkster/lite-perf-gate` ^1.4.2
  (devDependency; `zgcSuite` at all-default thresholds) gates the sync enqueue
  path -- 0 scavenges required at N and k*N, `poolCapacity` /
  `immediateCapacity` counter delta 0 -- with an in-process must-fail control
  and a `controls.mjs` arm proving the suite fails without `--expose-gc`.
  npm scripts: `perf`; `verify` is now
  `test && perf && torture && torture:controls`.
- `decisions/0001-task-door.md` (repo-only): the S-04 throw-at-door and
  conservation-observability decisions on the record.
- 21 new tests (15 door/coercion regressions + 6 boundary pins); the unit
  suite is now 63.

### Changed

- **S-03**: `config.onError` is now validated at construction. A provided-but-
  non-callable sink (including explicit `null`) throws
  `lite-scheduler: onError must be a function` at `createScheduler()`, not a
  deferred uncaught exception at flush time. Migration: a non-callable onError
  now errors at the call site; pass a function or omit it.
- Unknown config keys are rejected at construction with the nearest known key
  named, e.g. `createScheduler({ maxTask: 5000 })` throws
  `unknown config key "maxTask" -- did you mean "maxTasks"?`. Migration: a
  typo'd option now errors at the call site instead of being silently ignored.
- **S-04**: `schedule(fn)` throws a `TypeError` when `fn` is not a function,
  synchronously at the call site (after the post-destroy no-op check, before any
  pool touch) -- never enqueued to fail at flush time. Migration: a non-function
  task now errors at the call site. (See `decisions/0001-task-door.md`.)

### Fixed

- **S-01**: a NaN priority no longer jumps the queue into the UserInput lane.
  Any priority that is not an integer in `[UserInput..Idle]` is coerced to
  `Normal`, so `schedule(A, Normal); schedule(B, NaN)` now runs `[A, B]`.
- **S-02**: an in-range fractional priority (`3.7`, `2.5`) no longer truncates
  to a lower lane; it coerces to `Normal` and runs in schedule order. A string
  such as `'3'` coerces to `Normal` as well. (Both S-01 and S-02 are
  doc-conformance fixes -- the doc always said out-of-range values coerce to
  Normal.)

### Measured

Measured on node v26.3.1, darwin arm64, 2026-09-14, with perf-gate 1.4.2 and
gc-profiler 1.16.0. Sync enqueue throughput (`measureOps`, mixed-priority
`schedule(noop, prio[i & 7])`, 200000 ops, 20000 warmup, `stabilize: 'deep'`):
opsPerSec 56218607 before the doors -> 57674983 after (ratio 1.026, above the
0.90 floor); `majorsPerKOp` 0 and `maxPauseMsPerOp` 0.000 in both runs. The
perf-gate scavenge-scaling gate reads 0 scavenges at N (200000) and k*N
(1600000) with `poolCapacity` / `immediateCapacity` counter delta 0, before and
after -- the two door compares add no allocation and no measurable cost. At
release: tests 63/63 pass; torture gate `majorsPerKOp=0 maxPauseMsPerOp=0.000`
over 3000 schedule->flush cycles, heap growth -0.004 MB over 100000 cycles
(ceiling 2 MB); perf suite 3/3 with the must-fail control caught.

## [1.0.2] - 2026-09-14

Tooling, harness and hygiene only. No runtime behavior change: the diff of
`Scheduler.js` is comment ASCII-scrub plus one added `export const VERSION`.

Measured at release (node v26.3.1, darwin arm64): tests 42/42 pass; torture
gate `majorsPerKOp=0 maxPauseMsPerOp=0.000` over 3000 schedule->flush cycles;
heap growth -0.004 MB over 100000 cycles (ceiling 2 MB); 4096-cycle
create/destroy soak leaves `tracker.size() === 0` (the destroy()
MessageChannel claim is now gated, not asserted).

### Added

- `export const VERSION` from `Scheduler.js` (and `Scheduler.d.ts`), completing
  the three-place version sync (package.json, VERSION const, llms.txt header).
- `CHANGELOG.md` (this file) shipped in `files[]`.
- Torture gate: `test/torture.mjs` with `@zakkster/lite-gc-profiler` and
  `@zakkster/lite-leak` devDependencies. Tiers t0 (laws), t1 (degenerate doors,
  pinning today's behavior), t2 (adversarial lifecycle), t5 (recorded-order
  fuzz), t6 (async zero-alloc gate), t7 (4096-cycle MessageChannel destroy
  soak), t9 (controls). Plus `test/controls.mjs` (the gate-must-fail driver)
  and `test/dts-drift.test.js` (surface + version drift guard).
- npm scripts: `torture`, `torture:controls`, `verify`
  (`test && torture && torture:controls`).

### Changed

- Test framework ported from vitest to `node:test` (`node:assert/strict`,
  `mock.fn`). All 36 assertions survive with their names and groups intact.
- ASCII-only source across `Scheduler.js`, `Scheduler.d.ts`, `llms.txt`,
  `README.md` and `bench/bench.js` (U+00D7 and U+00B5 excepted).

### Removed

- The `vitest` devDependency and the `test:watch` script.

### Known Issues

The following door defects are RECORDED here and pinned as passing `t1` cases
that document today's behavior; they are FIXED IN F1 (v1.0.3), not in this
release. See the [1.0.3] head above for where each landed: S-01 and S-02 under
Fixed; S-03, S-04, and unknown-key rejection under Changed.

- **S-01** (fixed in F1): A NaN priority jumps the queue into the UserInput
  lane. The doc contract says "out-of-range values are coerced to Normal", and
  the range check `p < UserInput || p > Idle` is false for NaN, so NaN slides
  past coercion; `(NaN - 1) | 0 === 0` routes it to SLL index 0 = UserInput. A
  malformed priority lands in the MOST privileged lane and preempts
  correctly-scheduled Normal work.
- **S-02** (fixed in F1): In-range fractional priorities silently truncate to
  the lane below: `3.7` -> Background (a demotion), `2.5` -> Normal.
  Undocumented; the doc says only integer constants exist.
- **S-03** (fixed in F1): `config.onError` is not validated. A non-callable
  sink converts the FIRST task error into an uncaught exception thrown from
  inside the flush loop -- the error SINK is the crash vector, and it detonates
  at flush time, far from the config mistake.
- **S-04** (fixed in F1): `schedule(null)` is accepted at the door; the
  TypeError surfaces at execution time inside the flush, routed to onError.
  Deferred, disconnected from the caller's stack. Decide: throw at the door vs
  document the deferral.

## [1.0.1] - 2025-05-17

### Fixed

- Lost-work regression: tasks scheduled DURING a flush (including an Immediate
  task scheduled by an SLL task) could be dropped instead of picked up in the
  same flush or the next macrotask. The flush completion check now re-arms the
  MessageChannel whenever SLL or immediate work remains.

## [1.0.0] - 2025-05-17

### Added

- Initial release. Zero-GC frame budget manager: five strict priority lanes
  (Immediate, UserInput, Normal, Background, Idle), MessageChannel-driven flush,
  a pre-allocated monomorphic task pool, an Immediate ring buffer, per-flush
  `budgetMs` with cooperative `shouldYield()`, `yieldTask()` promise scheduling,
  `stats()` introspection, and `destroy()` that closes the MessageChannel.
- Capacity policies `throw` / `grow` / `drop`, capped at `maxTasks * 16`.
- Module-default convenience exports and `setDefaultScheduler()`.

[1.1.1]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.1.1
[1.1.0]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.1.0
[1.0.3]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.3
[1.0.2]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.1
[1.0.0]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.0
