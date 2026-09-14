# 0005 -- No `drain(cb)`: the drain loop is the API

Status: accepted (F2, v1.1.0)
Date: 2026-09-14

A convenience `drain(cb)` that pops every item and hands each to a callback is an
obvious-looking addition to `FastBitScheduler`. This record rejects it, on the
record, so it is not re-proposed.

---

## Options considered

- **Option A -- add `drain(callback)`**: internally
  `while ((h = this.popMin()) !== EMPTY) callback(h);`.
- **Option B -- no callback surface. The drain loop written by the consumer IS
  the API**: `while ((h = q.popMin()) !== EMPTY) { ... }`.

### Decision: B. `drain(cb)` is REJECTED.

### Rationale

- **Re-entrancy during mutation is the B4 lesson.** `drain(cb)` re-enters user
  code in the middle of a mutation, while `activeMask`, `heads`, `tails`, and
  `counts` are mid-flight. A callback that calls `push` or `clear` during the
  drain either corrupts the cursor triple (a `push` that flips a mask bit the loop
  already cleared, a `clear` that zeroes the cursors the loop is walking) or
  forces a re-entrancy guard onto the hot body -- a byte in `popMin` that every
  non-callback caller pays for, to protect a convenience nobody needs.
- **The loop is already the smallest correct form.** `while ((h = q.popMin())
  !== EMPTY) { ... }` is one line, allocates nothing, and lets the consumer push
  or clear mid-drain on their own stack with their own understanding of the
  consequences -- no hidden re-entrancy, no guard.
- **This is exactly why `EMPTY` is exported and why the item door exists.** The
  drain loop is only sound because `popMin()` returns the sentinel `EMPTY` (`-1`)
  when the queue is empty, and because the item door refuses to store any `-1`
  (or any negative, or any non-integer) -- so no stored handle can ever be
  mistaken for the sentinel and strand the items behind it. The exported `EMPTY`
  and the closed item door together make the consumer-written loop correct;
  `drain(cb)` would add surface without adding safety.

### Consequences

- No callback surface on `FastBitScheduler`. The documented consumption pattern
  is the `while ((h = q.popMin()) !== EMPTY)` loop, shown in llms.txt and README.
- Fail closed by keeping the surface minimal: fewer entry points into a
  mid-mutation state, no re-entrancy guard on the hot body.
