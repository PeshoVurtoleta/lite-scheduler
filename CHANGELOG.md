# Changelog

All notable changes to `@zakkster/lite-scheduler` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

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
release:

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

[1.0.2]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.1
[1.0.0]: https://github.com/PeshoVurtoleta/lite-scheduler/releases/tag/v1.0.0
