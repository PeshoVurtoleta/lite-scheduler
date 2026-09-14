# 0004 -- Configurable tier count (`numTiers`)

Status: accepted (F2, v1.1.0)
Date: 2026-09-14

The draft hardcoded 32 tiers and always allocated 32 rings (128 KiB at the
default `capacityPerTier` of 1024, whatever the consumer's real lane count). The
routing mask is a single 32-bit int, so 32 is the hard ceiling; but many
consumers have 4 or 8 lanes and pay for 32. This record decides whether the tier
count is fixed or a constructor option.

---

## Options considered

- **Option A -- fixed 32 tiers.** One shape, no constructor arithmetic, the mask
  is always a full 32-bit int. A 4-lane consumer allocates 32 rings anyway.
- **Option B -- a `numTiers` constructor option, integer 2..32, default 32.** The
  consumer sizes the queue to its real lane count; the mask still lives in one
  32-bit int because bits above `numTiers-1` are never set.

### Decision: B.

Add `numTiers`, an integer in `2..32`, default `32`.
`constructor(capacityPerTier = 1024, numTiers = 32)`.

### Rationale

- **Zero hot-path cost.** The only place `numTiers` touches a hot body is the
  push priority door, whose upper bound changes from the literal `31` to a
  hoisted `this._maxPrio` field (`numTiers - 1`). That is a field read replacing a
  constant -- no added branch, no added allocation. `popMin`/`peekMin` are
  unchanged: the mask math (`x & -x`, `31 - Math.clz32(...)`) is identical because
  bits above `numTiers-1` are never set, so the lowest-set-bit is always a valid
  tier.
- **One cold validation.** `numTiers` is validated once in the constructor
  (integer, `2..32`), the same class of cold work as the capacity door. `1` is
  rejected: a one-tier priority queue is not a priority queue, it is a plain FIFO,
  and a caller who wrote `1` made a mistake, not a choice. `33` is rejected: it
  cannot fit a 32-bit mask.
- **Memory scales with the real lane count.** The table below is arithmetic
  (`capacity(rounded) * numTiers * 4` bytes for the ring buckets), not copied.

### The D-07 memory table

| capacityPerTier | numTiers | bytes (buckets) | note |
|---:|---:|---:|---|
| 1024 | 32 | 131072 | the draft's default: 128 KiB |
| 1024 | 8 | 32768 | 4x smaller for an 8-lane consumer |
| 1024 | 4 | 16384 | |
| 256 | 32 | 32768 | |
| 16777216 | 32 | 2147483648 | the documented ceiling, 2 GiB -- why the capacity door names it |

(`bytes = capacity(rounded) * numTiers * 4`; the cursor columns `heads`/`tails`/
`counts` add `numTiers * 4 * 3` more -- e.g. 384 bytes at `numTiers 32` -- and are
excluded from this table, which reports the dominant ring storage only.)

### Cost

Zero measurable hot-path cost -- see decisions/0003 "Door-cost baseline": the
priority door's field-read bound plus the two item-door compares hold the
shipped/draft throughput ratio at 0.987 (floor 0.90), majors 0 and pause 0.000
on both arms.
