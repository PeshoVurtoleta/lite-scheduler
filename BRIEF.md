---
package: "@zakkster/lite-scheduler"
session: F1
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

# lite-scheduler F1 -- the priority door + the perf gate (v1.0.3)

This brief is the F1 session of `ROADMAP.md` (read sections 1, 2, 3 --
including the new "The perf gate" subsection -- and the F1 block in
section 5 before planning). Two deliverables: (1) the documented priority
contract becomes TRUE for every input (S-01..S-04 plus unknown config
keys), proven fail-before/pass-after; (2) `@zakkster/lite-perf-gate`
joins as the third gate instrument, gating the exact sync paths this
session touches.

## Context the planner must load

- ROADMAP.md sections 1 (law + invariants), 2 (S-01..S-04 with verbatim
  reproductions), 3 (torture spec + "The perf gate"), 5 (F1 block: the
  S-04 decision menu and the conservation-observability decision).
- Current package facts (verified 2026-09-14): v1.0.2 published to npm;
  42 node:test tests green (36 ported + 6 dts-drift); torture tiers
  t0/t1/t2/t5/t6/t7/t9 green; `npm run verify` exit 0. The t1 tier PINS
  today's broken doors as PASSING tests, each marked `F1 FLIPS THIS`
  (test/torture/t1-degenerate.mjs). CHANGELOG 1.0.2 Known Issues quotes
  S-01..S-04 as "fixed in F1".
- The door sites in Scheduler.js (locate exactly; line numbers drift):
  the sanitize step `if (priority < Priority.UserInput || priority >
  Priority.Idle) priority = Priority.Normal;` (NaN passes both compares;
  `(NaN - 1) | 0 === 0` then routes it to SLL index 0 = UserInput) and
  the lane index `(priority - 1) | 0` (truncation demotes 3.7 to
  Background and promotes nothing -- both against the doc sentence).
- Registry facts: `@zakkster/lite-perf-gate` latest 1.4.2. AFTER `npm
  install`, read `node_modules/@zakkster/lite-perf-gate/llms.txt` AND its
  `COOKBOOK.md` for the CURRENT surface -- never write scenario shapes,
  thresholds, or control names from memory (the F0 lesson, twice proven).
  The repo twin `../LitePerfGate/examples/trio.mjs` shows perf-gate +
  gc-profiler + lite-leak coexisting in one suite.

## Law constraints binding this session

- Fail closed at the door, free in the body: every fix lands in
  schedule() (enqueue) or createScheduler() (construction). The flush
  loop diff is EMPTY -- assert it by diff inspection, not intent.
- Unknown option key = error with a did-you-mean hint, never a silent
  ignore (lite-law). `createScheduler({maxTask: 5000})` must throw
  naming `maxTasks`.
- AR-02 discipline: every flipped door test is proven RED against the
  v1.0.2 code first, then green after the fix. Sequence inside the
  session: flip the t1 assertions and port the S-01 probe as a unit
  regression FIRST, run them against the untouched Scheduler.js, capture
  the failures in the session log, THEN fix, then green.
- Never widen a budget: gc_maxMajor 0 / maxPauseMs 4 unchanged;
  perf-gate thresholds stay at its defaults per its llms.txt;
  `allowNoGc` never appears in a gated run.
- Semver: 1.0.3 (patch). S-01/S-02 are doc-conformance FIXES; S-03 /
  unknown-key / S-04 are fail-closed door additions listed under Changed
  with a migration sentence each (misuse now errors at the call site).
- ASCII-only; node:test only; three-place version sync in the same
  session (package.json / VERSION const / llms.txt header).

## TASKS

1. **decisions/0001-task-door.md BEFORE coding** (two decisions on
   record, per ROADMAP F1): S-04 option A (throw TypeError at the
   schedule() door) vs B (document the deferral) -- recommendation A;
   and conservation observability: `_debug()` accessor vs behavioral
   gating only -- recommendation behavioral only. Record the reasoning
   and the measured enqueue cost either way.
2. **The priority door (S-01/S-02).** After the Immediate check, the
   sanitize becomes "anything that is not an integer in
   [UserInput..Idle] is Normal": `if ((priority | 0) !== priority ||
   priority < Priority.UserInput || priority > Priority.Idle) priority
   = Priority.Normal;`. NaN, 3.7, 2.5, -1, 99, Infinity, '3' all land
   in Normal. The llms.txt contract sentence updates to match.
3. **S-03.** Validate `config.onError` at construction: provided and
   not callable -> throw the same library-error shape as the
   budgetMs/maxTasks validators. Cold path.
4. **Unknown config keys.** Reject any own key outside the known set at
   construction, with the nearest known key in the message (simple
   edit-distance or prefix heuristic -- cold path, keep it small).
5. **S-04 per decision 0001** (A recommended): `typeof fn !==
   'function'` -> TypeError at schedule(), before any pool touch. One
   branch on the enqueue path, none in the flush loop.
6. **Flip t1 + regressions.** Rewrite the four pinned t1 cases to the
   fixed contract (drop the `F1 FLIPS THIS` markers); port the S-01
   probe (schedule Normal then NaN, assert order) into
   test/Scheduler.test.js as a named regression; add unit door cases
   for every input class in task 2 plus the maxTask typo and bad
   onError. RED-FIRST per the law constraint above.
7. **The perf gate.** devDep `@zakkster/lite-perf-gate` ^1.4.2. New
   `test/perf.test.mjs` via `zgcSuite` (surface from its llms.txt +
   COOKBOOK, read fresh):
     - Scenario "enqueue-door": setup creates a scheduler with a
       pre-sized pool, `onCapacityExceeded: 'drop'`, and a hoisted noop
       task; hot(state, n) calls schedule() n times (fills the pool,
       then exercises the drop path -- both must be allocation-free);
       statsOf reports `stats().poolCapacity` (statsOf runs OUTSIDE the
       hot window, so its allocation is legal) with counter max delta
       0; teardown destroys the scheduler. Expected: ~0 scavenges at N
       and k*N -- the scaling verdict.
     - mustFail scenario: per-iteration closure allocation (e.g.
       `schedule(() => i)`) must trip the gate -- the in-process red.
     - Measurement hygiene comes from the COOKBOOK, not from guessing:
       keep the macrotask flush out of the hot window (the drop policy
       + destroy-in-teardown shape above is the intent; adjust only per
       a documented recipe).
     - scripts: `"perf": "node --expose-gc --max-semi-space-size=4
       --test test/perf.test.mjs"`; `verify` = test && perf && torture
       && torture:controls. controls.mjs gains the arm: the perf file
       without `--expose-gc` must fail loudly.
8. **Baseline then re-measure.** BEFORE touching Scheduler.js, record
   the v1.0.2 enqueue assertOps number AND a perf-gate run on the
   undoored path; after the doors, both again: assertOps within noise,
   scavenges still ~0 at both scales. Numbers into the CHANGELOG.
9. **CHANGELOG 1.0.3**: Fixed (S-01, S-02), Changed (S-03 validation,
   unknown-key rejection, S-04 door per decision), a measured paragraph
   with the task-8 numbers (node/machine/date provenance). The 1.0.2
   Known Issues entries resolve here (history stays; the head says
   where each landed).
10. **Three-place sync 1.0.3** + llms.txt contract-sentence updates
    (priority coercion, unknown keys, schedule-throws-on-non-function
    if A). dts-drift stays green (no surface change expected).

## ASSERTIONS (falsifiable, each one checked by qa)

- Each of S-01..S-04 + unknown-key: the new test FAILS against v1.0.2
  Scheduler.js and PASSES after -- both runs captured in the session
  log.
- `schedule(A, Normal); schedule(B, NaN)` executes as
  `["normal-first", "nan"]` -- the S-01 probe inverted, now the
  regression.
- `createScheduler({maxTask: 5})` throws naming `maxTasks`;
  `createScheduler({onError: 'x'})` throws at construction, not at
  flush time.
- `npm test` green (42+ prior tests plus the new door cases), zero
  skipped; `npm run torture` prints exactly `ok`; `npm run
  torture:controls` green; LSCHED_TORTURE_BREAK=1 still trips.
- `npm run perf` green: detector self-validation passes, the mustFail
  scenario trips, enqueue-door shows ~0 scavenges at N and k*N,
  poolCapacity counter delta 0. The perf file without --expose-gc fails
  loudly via controls.mjs.
- assertOps enqueue number within noise of the pre-door baseline; both
  numbers in the CHANGELOG with provenance.
- The Scheduler.js diff contains door/construction changes ONLY -- the
  flush-loop hunk is empty.
- ASCII grep zero hits (U+00D7/U+00B5 excepted); `npm pack --dry-run`
  file set unchanged (7 files); three-place sync at 1.0.3.

## NON-GOALS

No FastBitScheduler (F2). No README re-spine, no example/ work (F3). No
frame-scheduler internal mask routing (C1). No new runtime features, no
new exports beyond what the S-04 decision requires (none expected). No
budget or threshold widening anywhere. No commits -- the working tree is
left for /release 1.0.3.

## DONE WHEN

the doc sentence is true for every input, proven red-first; unknown
config keys die with a hint; the perf gate is green, red-capable, and
wired into verify; the enqueue cost is measured, within noise, and
recorded; `npm run verify` is green end to end
