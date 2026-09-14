# 0002 -- Two members, one package, one file (the dual family)

Status: accepted (F2, v1.1.0)
Date: 2026-09-14

This record locks the shape of the package the moment it gains a second member.
`FastBitScheduler` is a 32-tier bucket priority queue over handles; the frame
scheduler (`createScheduler`) is a MessageChannel-driven frame-budget manager.
They solve different problems and share no code. The question this record answers
is where the second member lives.

---

## Decision 1 -- one file, two independent members

Options considered:

- **Option A -- ship `FastBitScheduler` from the existing `Scheduler.js`, as a
  second top-level declaration, exported named.** No new file, no new package.
- **Option B -- create a second package `@zakkster/lite-fastbit-scheduler`.**

### Decision: A.

`FastBitScheduler` and `EMPTY` are appended to `Scheduler.js` as top-level
declarations and exported named, alongside the frame scheduler's existing
exports.

### Rationale

- `FastBitScheduler` never imports, references, reads, or mutates any part of the
  frame scheduler, and the frame scheduler never learns the mask exists. There is
  no shared state, no shared type, no shared helper: `ceilPow2` is private to the
  new section, the routing mask lives entirely inside the class. Two members in
  one file, zero coupling -- the file is a namespace, not a dependency graph.
- Tree-shaking makes the one-file choice free for a consumer who wants only one
  member. `package.json` declares `sideEffects: false`; both members are
  top-level `export` declarations with no module-level side effects. A bundler
  that sees `import { createScheduler } from '@zakkster/lite-scheduler'` drops the
  `FastBitScheduler` class, `EMPTY`, and `ceilPow2` entirely -- and the reverse
  holds for a consumer importing only `FastBitScheduler`. Nothing is paid for
  what is not imported.
- One file keeps the suite law ("single PascalCase main file per package") intact
  and avoids a second `package.json`, a second lockfile, a second CHANGELOG, a
  second README, and a second publish, for two members that fit comfortably in
  one file and one test surface.

### Consequences and the segregation trigger

Segregation into its own package is C2's procedure, deliberately deferred, not
refused. The trigger is named so the deferral is not a slow drift: **if the
second member grows a second source file OR takes on a runtime dependency the
frame scheduler does not share, it segregates into
`@zakkster/lite-fastbit-scheduler` at that point.** Until then, the maintenance
cost of a second member here is one banner-commented section and one extended
test suite; the cost of a premature second package is permanent. This is
reviewed at the next member, not re-opened per patch.

- The frame scheduler stays byte-identical this session: adding the second member
  is additive-only plus the single `VERSION` line, so the one-file choice costs
  the existing member nothing.
- The export shape is additive: existing exports are unchanged and unreordered;
  `FastBitScheduler` and `EMPTY` are the only new names. The draft's
  `export default` does not carry over -- the file has no default export and gains
  none.
