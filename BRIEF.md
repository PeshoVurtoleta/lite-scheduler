---
package: "@zakkster/lite-scheduler"
session: F3
version_target: 1.1.1
status: shipped -- /release 1.1.1 gates green 2026-09-14
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [S-09]
depends_on: [F2]
blocks: []
---

# lite-scheduler F3 -- the README describes the family, on the blueprint spine

This brief is the F3 session of `ROADMAP.md` (read the F3 block in full --
it is the authoritative scope -- plus RESEARCH.md section 5 and finding S-09).
One deliverable: the docs describe the two-member family, once, on the
LiteSepforge blueprint spine, with every number stamped and every example
running. The diff contains NO logic.

PURPOSE
  After F2 the package IS the dual-scheduler family; the README still
  describes the 2025 single-member package on a pre-blueprint spine. Docs
  sessions come last so they are written once (the R4 lesson).

## Context the planner must load

- ROADMAP.md, the F3 block ("# F3 -- v1.1.1 -- one story") -- verbatim scope,
  including the doc-count sync bullet folded in from the 1.1.0 release.
- RESEARCH.md section 5 (zero-alloc cancellation = generation bump + pop-side
  isAlive check) and finding S-09.
- ../LiteSepforge/README.md -- THE blueprint. Extract its exact spine:
  ordered section titles, which are <details>, what each contains.
- Current state: README.md, llms.txt, CHANGELOG.md, test/dts-drift.test.js,
  bench/ (bench.js, fastbit-floor.mjs, bench-results.json),
  example/ (demo.html, demo-scheduler-arena.html), Scheduler.d.ts (the full
  export surface of BOTH members), package.json (scripts + files[]).

## Ground truth (propagate, never re-derive)

- Test counts: frame suite 57, FastBit suite 44, dts-drift 10 --
  `npm test` total 111 / 0 fail.
- Two shipped sites still say 37: llms.txt:149 and CHANGELOG.md:43
  ("37-case", inside the published 1.1.0 entry). Fix both to 44; record the
  CHANGELOG correction in 1.1.1's Fixed section; close with a
  `grep -rn '\b37\b'` over shipped docs (the 48.37x bench multiplier is a
  false positive, everything else must die).
- npm scripts that EXIST: test, torture, torture:controls, perf, bench,
  verify. There is NO test:watch (removed in F0); the current README still
  advertises it -- the re-spined Testing section lists only real scripts.
- files[] ships exactly: Scheduler.js, Scheduler.d.ts, README.md, llms.txt,
  CHANGELOG.md, LICENSE (7 files with package.json, 29.2 kB at 1.1.0).
- Gates at 1.1.0 (the baseline this session must not disturb): tests
  111/0, torture ok exit 0, perf 8/8.

TASKS (verbatim scope -- ROADMAP F3 is authoritative if these ever diverge)

  - README re-spine per ../LiteSepforge/README.md, exactly: title + one-line
    blockquote tagline; badges; positioning H2 ("The scheduler pair the
    ecosystem was missing") with inline install + a runnable quick-start FOR
    EACH member; TOC; Why this exists; What you get; a <details> deep-dive
    per member (frame budget mechanics; the activeMask/lowest-set-bit trick);
    API reference (signatures + a constants table: Priority lanes, EMPTY,
    capacity ceiling, VERSION); Composability; <details> Zero-GC design notes
    with the allocation table (what allocates: createScheduler, grow policy,
    yieldTask, stats -- and what NEVER does: schedule/flush steady state,
    push/popMin) + the gated numbers; Design decisions worth knowing
    (0001..0005 distilled); Testing (counts + npm scripts); What this is not
    (not a job system, not a thread pool, not lodash.debounce); Ecosystem;
    License. ASCII throughout.
  - The Composability section is the payoff of the dual design -- one
    runnable end-to-end pipeline: lite-arena spawns entities ->
    FastBitScheduler routes SLOT INDICES by priority tier -> the frame
    scheduler drains within budgetMs via shouldYield. Three mandatory
    caveats, stated loudly:
      * arena HANDLES go negative at generation >= 2048 (by design) -- store
        the arena slot INDEX (always >= 0), never the handle; validate
        liveness on pop (isAlive) -- which IS the zero-alloc cancellation
        pattern from RESEARCH.md section 5.
      * FastBitScheduler is pure data -- pair it with the frame scheduler
        (or rAF) for TIME; nothing about it wakes up on its own.
      * tier naming via lite-fastbit32's BitMapper (a CONSUMER-side dep,
        never the scheduler's): fail-closed tier names; hoist indices at
        init, .get() is not a hot-loop call.
    OPEN DECISION for the planner: how the paste-run check obtains
    @zakkster/lite-arena (+ lite-fastbit32 if the example imports it) --
    devDependency vs ephemeral install in the check script vs sibling-path
    import. Zero RUNTIME deps is law; pick one, justify it.
  - llms.txt: full family rewrite (it is what a sibling package's pipeline
    reads -- a stale llms.txt is how a sibling hallucinates a signature).
    dts-drift.test.js already guards it; extend to assert every public
    member of BOTH classes appears, both directions.
  - Doc-count sync (see Ground truth): llms.txt:149 and CHANGELOG.md:43,
    37 -> 44; 1.1.1 Fixed section records the CHANGELOG correction.
  - Bench: re-run bench.js on current node, stamp every README number with
    version + node + machine + date; the May-2025 numbers either re-measured
    or removed. FastBitScheduler floor numbers from F2 included.
  - example/ demos: verify BOTH (demo.html, demo-scheduler-arena.html) load
    against the current surface; audit demo hot-path code against the
    demo-audit law (no per-frame allocation, no forced reflow); fix or note.
  - CHANGELOG 1.1.1 docs entry. The diff contains NO logic -- assert it.

ASSERTIONS

  - Spine section order matches LiteSepforge exactly; ASCII grep zero
    (U+00D7 and U+00B5 excepted).
  - Every code block in README and llms.txt RUNS (paste-run check, the
    composability pipeline included). Blocks that are signature listings or
    browser-only get classified as such by an explicit allowlist and are
    parse-checked instead -- the allowlist is part of the plan, not ad hoc.
  - Drift guard: every export in d.ts and llms.txt, both directions, both
    members; every relative link resolves.
  - Bench numbers stamped; no unstamped performance claim survives.
  - `npm pack --dry-run` unchanged except README/llms/CHANGELOG bytes:
    still 7 files, no new names.
  - No-logic diff: Scheduler.js, Scheduler.d.ts, package.json byte-identical
    to the 1.1.0 commit (`git diff --stat` proves it).
  - The full 1.1.0 gate set still green, untouched: tests 111/0, torture ok.

NON-GOALS

  No behavior change, no new API, no version-inflating features. ROADMAP.md
  and RESEARCH.md stay repo-only (not in files[]). NO VERSION BUMP during
  the pipeline: the three canonical sites (package.json, the VERSION const,
  the llms.txt header) stay at 1.1.0 until `/release 1.1.1` performs the
  sweep -- this keeps the F3 diff logic-free and the machine's auto-publish
  routine dormant. "New in 1.1.1" style content references to the target
  version are fine in CHANGELOG head drafting; version SITES are not.

DONE WHEN
  one README tells the two-member story on the blueprint spine; every
  number is stamped; every example runs; drift is CI-caught.
