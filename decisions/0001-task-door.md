# 0001 -- The task door (S-04) and conservation observability

Status: accepted (F1, v1.0.3)
Date: 2026-09-14

This record locks two F1 decisions before any `Scheduler.js` byte is edited.

---

## Decision 1 -- S-04: non-function task at `schedule()`

`schedule(fn)` today accepts a non-callable `fn`, enqueues it, and lets the
`fn()` call inside the flush loop throw a `TypeError` that is caught and routed
to `onError` one macrotask later, disconnected from the caller's stack.

Options considered:

- **Option A -- throw a `TypeError` at the `schedule()` door.** Reject a
  non-function synchronously, on the caller's own stack, before any pool touch.
- **Option B -- document the deferral.** Leave the behavior; state in the docs
  that a bad task surfaces at flush time via `onError`.

### Decision: A.

Throw `TypeError` at the `schedule()` door.

### Rationale

- The hot body of this scheduler is the flush loop (`performWork`), not the
  enqueue path. The enqueue path already branches on `destroyed` and on
  `priority === Priority.Immediate`; one more `typeof fn !== 'function'` compare
  is in the same class of work and adds no allocation on the passing path (the
  error message string is concatenated only inside the throwing branch).
- The error lands on the caller's stack, at the call site, instead of arriving
  at `onError` one macrotask later where it is disconnected from the mistake.
- Fail closed at the door, free in the body: this is the lite-law shape for the
  whole family. `null` is not a task.

### Door position

The check is inserted **after** `if (destroyed) return;` and **before** the
`if (priority === Priority.Immediate)` branch -- i.e. before any ring or pool
touch. Placing it after the destroyed check preserves the published contract
sentence "schedule() no-ops after destroy" (llms.txt): a destroyed scheduler
still silently ignores every call, including a bad one.

### Cost

Measured enqueue cost, mixed-priority `schedule(noop, prio[i & 7])`,
`gc-profiler` sync lane (`measureOps`, ops 200000, warmup 20000,
stabilize 'deep'), node v26.3.1, darwin arm64, 2026-09-14:

- before (v1.0.2, undoored): opsPerSec = 56218607
- after  (v1.0.3, doored):   opsPerSec = 57674983 (ratio 1.026, above the 0.90 floor)
- majorsPerKOp = 0, maxPauseMsPerOp = 0.000 both runs.
- perf-gate scavenges at N and k*N: 0 / 0 both runs; poolCapacity delta 0.

The two door compares (`typeof fn`, `(priority | 0) !== priority`) cost nothing
measurable: the after/before ratio is above the 0.90 floor and neither run
produces a major GC or an over-budget pause. The door is free in practice, not
just in theory.

---

## Decision 2 -- conservation observability

The pool invariant `activeTasks + freeListLength === poolCapacity` could be
exposed for testing via a shipped `_debug()` accessor, or proven only from
outside by existing gates.

Options considered:

- **Option A -- ship a `_debug()` accessor** returning the internal counters.
- **Option B -- behavioral gating only.** Prove conservation from outside.

### Decision: B.

Behavioral only. No new surface.

### Rationale

- The pool's byte-identity across churn is already proven from outside by
  `test/torture/t6-alloc.mjs` sub-gate C (`stats().poolCapacity` and
  `stats().immediateCapacity` are identical before and after the churn) and by
  the new perf-gate `poolCapacity` / `immediateCapacity` counters, whose gated
  delta is 0.
- A shipped closure grows the public surface (and the dts-drift surface parity
  set) for a property an external gate already proves. Every export is a
  maintenance and compatibility cost; this one buys nothing the gates lack.
- Fail closed by keeping the surface minimal: fewer knobs, fewer foot-guns.
