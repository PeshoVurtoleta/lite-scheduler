# Changelog

All notable changes to `@zakkster/lite-scheduler` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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

[1.0.3]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.3
[1.0.2]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.1
[1.0.0]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.0
