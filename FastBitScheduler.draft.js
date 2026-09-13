/**
 * FastBitScheduler -- a 32-tier bucket priority queue with an O(1) bitmask
 * routing table and one TRUE ring buffer per tier.
 *
 * Companion to Learning/BucketQueue.md (PART 5). This is the "bitset-accelerated
 * pop" from PART 3 made real: the routing table replaces pop's linear scan.
 *
 * The design rests on one trick: instead of SCANNING 32 tiers to find the
 * highest-priority non-empty one, keep a single 32-bit int `activeMask` whose
 * bit p is 1 exactly when tier p holds >= 1 item. "Highest priority" is then
 * "lowest set bit" -- two instructions (`x & -x`, then `Math.clz32`), no loop,
 * however many tiers are populated. Bit 0 = P0 = highest priority.
 *
 * Layout (Structure-of-Arrays; zero allocation after construction):
 *   activeMask : Int32       -- routing table; bit p set <=> tier p non-empty
 *   buckets[p] : Int32Array  -- ring storage for tier p (HANDLES, not objects)
 *   heads[p]   : Uint32      -- read cursor  (next slot to pop)
 *   tails[p]   : Uint32      -- write cursor (next slot to push)
 *   counts[p]  : Uint32      -- live items in tier p (the ring's fill level)
 *
 * Contract (fail closed -- suite law: a caller bug throws at the door):
 *   - priority MUST be an integer 0..31 (0 = highest). JS shift is mod 32, so an
 *     unchecked priority 32 would silently alias tier 0 -- we refuse it instead.
 *   - items MUST be non-negative Int32 HANDLES (indices into some external SoA),
 *     because Int32Array stores 32-bit ints and popMin() reserves -1 for "empty":
 *     an object would coerce to 0, and a stored -1 would collide with EMPTY.
 *   - a tier at capacity throws rather than silently dropping the write.
 *
 * Why counts[] exists: in a real ring `head` can pass `tail` around the circle,
 * so `head === tail` is ambiguous -- it means BOTH full and empty. The count
 * column disambiguates, and it doubles as the full-check and the "clear the bit"
 * trigger. It is the one field that turns a linear-arena-with-reset into a ring.
 */

const EMPTY = -1; // out-of-band return from popMin/peekMin (stored items are >= 0)

/** Round n up to the next power of two, so ring indices wrap with `& (cap-1)`
 *  instead of the slower `% cap`. (Same power-of-two-stride habit as the suite.) */
function ceilPow2(n) {
    n = n | 0;
    if (n < 2) return 2;
    n--; n |= n >> 1; n |= n >> 2; n |= n >> 4; n |= n >> 8; n |= n >> 16;
    return (n + 1) >>> 0;
}

export class FastBitScheduler {
    constructor(capacityPerTier = 1024) {
        const cap = ceilPow2(capacityPerTier);
        this._cap  = cap;          // ring capacity per tier (power of two)
        this._mask = cap - 1;      // wrap mask: (i + 1) & _mask -- no branch, no %

        // A single 32-bit int is the O(1) routing table. Bit p set == tier p live.
        this.activeMask = 0;

        // 32 parallel rings (SoA). No Map, no resize, no per-op allocation.
        this.buckets = Array.from({ length: 32 }, () => new Int32Array(cap));

        // Per-tier ring cursors + fill level.
        this.heads  = new Uint32Array(32);
        this.tails  = new Uint32Array(32);
        this.counts = new Uint32Array(32);
    }

    /** O(1) push. Throws on a bad priority or a full tier (fail closed). */
    push(item, priority) {
        if ((priority | 0) !== priority || priority < 0 || priority > 31) {
            throw new RangeError(
                "[scheduler] priority must be an integer 0..31, got " + priority
            );
        }
        if (this.counts[priority] === this._cap) {
            throw new RangeError(
                "[scheduler] tier " + priority + " is full (" + this._cap + ")"
            );
        }

        const t = this.tails[priority];
        this.buckets[priority][t] = item;            // write at the tail cursor
        this.tails[priority] = (t + 1) & this._mask; // TRUE ring wrap
        this.counts[priority]++;

        this.activeMask |= (1 << priority);          // this tier now has data
    }

    /** O(1) true pop-min: the item from the highest-priority non-empty tier.
     *  Returns EMPTY (-1) when every tier is empty. */
    popMin() {
        if (this.activeMask === 0) return EMPTY;

        // Isolate the lowest set bit (two's complement), then turn it into its
        // index -- the highest priority present -- with no scan.
        const lowestBit = this.activeMask & -this.activeMask;
        const p = 31 - Math.clz32(lowestBit);

        const h = this.heads[p];
        const item = this.buckets[p][h];             // read at the head cursor
        this.heads[p] = (h + 1) & this._mask;        // ring wrap -- no reset needed

        // Last item in this tier? Clear its routing bit so popMin skips it. The
        // cursors are left where they are; count keeps them honest, so slots are
        // reused in place with zero GC.
        if (--this.counts[p] === 0) {
            this.activeMask &= ~lowestBit;
        }

        return item;
    }

    /** Read the next item without removing it. EMPTY if the scheduler is empty. */
    peekMin() {
        if (this.activeMask === 0) return EMPTY;
        const p = 31 - Math.clz32(this.activeMask & -this.activeMask);
        return this.buckets[p][this.heads[p]];
    }

    isEmpty() { return this.activeMask === 0; }
    sizeOf(priority) { return this.counts[priority]; }
}

export default FastBitScheduler;
