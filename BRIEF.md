---
package: "@zakkster/lite-scheduler"
session: C5
version_target: none (repo-only; 1.1.1 stays; no release)
status: done -- C5 cleared 2026-09-14 (reviewer APPROVED, qa PASS A1-A8, #profile 0 violations both demos; repo-only, no release)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [C5]
depends_on: [F3]
blocks: []
---

# lite-scheduler C5 -- the demos obey the same law they advertise

This brief executes the C5 candidates-ledger entry (ROADMAP.md, "C -- the
candidates ledger", C5 block: read it in full -- it is the violation
inventory noted by F3's audit). One deliverable: both files under example/
comply with the demo-audit law (hot-path allocation, forced reflow, CSS,
pointer events, ASCII) with zero change to anything shipped.

PURPOSE
  The demos are the package's storefront and its worst hypocrisy risk: a
  zero-GC scheduler demoed by a page that allocates per frame. F3 fixed one
  dead stats() call; the rest of the backlog is on record in C5. Clear it.

## Context the planner must load

- ROADMAP.md C5 block -- the known violation list, line-pinned.
- example/demo.html (475 lines) and example/demo-scheduler-arena.html
  (982 lines) -- current state, in full.
- The demo-audit law (the orchestrator holds the skill text and will embed
  it in the plan): zero-alloc frame loops and pointer handlers; reads
  before writes (forced reflow); cache every element lookup at init in a
  $-prefixed const; toFixed/toLocaleString only behind a ~10Hz
  frame-counter mask; pointer events not mouse*; pre-allocated typed-array
  ring buffers with power-of-2 bitmask; every :hover wrapped in
  @media (hover: hover); rem by default, px only for hairlines; no inline
  styles except custom properties; no bare {} scope blocks; ASCII-only
  bytes (U+00D7, U+00B5 excepted; HTML entities are ASCII bytes).

## Ground truth (propagate, never re-derive)

- Published/repo version: 1.1.1 everywhere; the diff must not touch a
  version site, a shipped file, or a test. files[] and `npm pack` are not
  in play: example/ never ships.
- Gates at 1.1.1 (must be untouched and re-proven once at the end):
  `npm test` 122/0; `node --expose-gc test/torture.mjs` ok, exit 0.
- lite-arena current is 1.9.0; the arena demo's used surface (new
  Arena(max), registerComponent({field: Float32Array...}), SparseSet
  .add/.idx/.data/.dense/.count, arena.spawn throws-when-full,
  arena.despawn) all exist at 1.9.0 (verified against the catalog card by
  the orchestrator). spawn is wrapped in try/catch and gated by full()
  in the demo already.
- Both demos require an HTTP server regardless of the importmap decision
  (ES modules do not load over file://).

TASKS (the C5 ledger block is authoritative if these ever diverge)

  - demo.html: full demo-law pass. Known: per-frame uncached
    getElementById + getContext + canvas.width resize in drawGauge/drawLoop;
    unthrottled toLocaleString/textContent telemetry; Math.max(20,
    ...history) spread; setLineDash array literals; live per-frame
    sched.stats() backpressure allocation in liteFeed (replace with a
    scheduled-minus-executed counter pair, zero alloc); :hover at ~:127/:132
    unwrapped; inline style= at ~:201/:210; px-only CSS; non-ASCII (em/en
    dashes, middle dot, box-drawing comment rules).
  - demo-scheduler-arena.html: full demo-law pass. Known: importmap pins
    @1.0.1 (stale); per-frame getBoundingClientRect (DOMRect alloc) in
    frame() and mouse handlers; per-frame closure into scheduler.schedule;
    per-frame sparkline canvas resize + getContext + spread + setLineDash +
    color-string concat; unthrottled toLocaleString particles badge;
    innerHTML + style.color telemetry writes; uncached getElementById in
    frame() and handlers; mouse* events; non-standard performance.memory;
    bare {} scope block; :hover at ~:149/:367/:438 unwrapped; px-only CSS;
    non-ASCII.
  - Importmap: @zakkster/lite-scheduler -> ../Scheduler.js (the repo's own
    current source -- kills the stale-pin class for the self-package);
    @zakkster/lite-arena -> jsdelivr pinned @1.9.0.
  - Histories become pre-allocated Float64Array rings (pow2 capacity,
    bitmask index); gauges/sparklines redraw only when their data changed
    (dirty flag), never resize their canvas per frame (size at init + on
    resize events only).
  - Telemetry: number-only spans updated via textContent (no innerHTML);
    color states via className using existing classes; counters behind a
    ~10Hz frame-counter mask or the existing 250 ms stats window.
  - performance.memory: remove the JS-heap stat row and its update; adjust
    the one footer note that references the heap line.
  - Both demos gain the dormant #profile hook from the demo-audit skill
    (dynamic import of @zakkster/lite-layout-profiler from jsdelivr, only
    when location.hash === '#profile'; never a static import, never in
    files[]).
  - ASCII policy: demo.html plain ASCII ("--", "-", "x"); arena demo keeps
    its typography via HTML entities (&mdash; &middot; &#9646; etc.) and
    CSS escapes (\25CF) -- all ASCII bytes; all JS/CSS comment banners
    become ASCII rules.

ASSERTIONS

  - Diff purity: git diff touches ONLY example/demo.html,
    example/demo-scheduler-arena.html, BRIEF.md, ROADMAP.md. Scheduler.js,
    Scheduler.d.ts, package.json, README.md, llms.txt, CHANGELOG.md,
    test/**, bench/** byte-identical.
  - ASCII grep over example/ returns zero non-ASCII bytes except U+00D7.
  - Zero occurrences inside any rAF-driven function body or pointer/input
    handler of: getElementById, querySelector, getContext,
    getBoundingClientRect, canvas .width=/.height= writes, array/object
    literals, spread, template strings, closures passed to schedulers,
    toLocaleString/toFixed/innerHTML/style.* outside a >=100ms throttle
    window (className swaps allowed).
  - Every :hover sits inside @media (hover: hover); zero mouse* listeners;
    zero performance.memory; zero inline style= except custom properties.
  - CSS lengths rem-first; px only on 1px hairlines and the 3px grain
    pattern.
  - Importmap resolves scheduler to ../Scheduler.js and arena to @1.9.0.
  - Gates re-proven green after the diff: npm test 122/0, torture ok.
  - Runtime proof (orchestrator, in-browser): both demos load with a clean
    console over HTTP, telemetry moves, and with #profile the
    layout-profiler reports violationCount 0 across a driven session.

NON-GOALS

  No library, test, or shipped-doc change of any kind. No version bump, no
  CHANGELOG entry (example/ does not ship), no /release. No committed
  demo-law guard tests this session -- recorded as a rider for the next
  release so shipped docs stay byte-stable at 1.1.1. The two Writes that
  land the rewritten demos must each leave a complete, working file (the
  machine's auto-commit routine may snapshot the tree between tool calls).

DONE WHEN
  both example files obey the demo-audit law end to end, prove it in a
  browser (clean console, #profile clean), the repo diff is demos-only,
  and the 1.1.1 gates are re-proven untouched.
