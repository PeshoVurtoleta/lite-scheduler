/**
 * @zakkster/lite-scheduler — Unit test suite.
 *
 * Tests use a per-test scheduler instance with explicit `destroy()` to keep
 * the test process clean.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createScheduler,
    Priority,
    CapacityError,
} from './Scheduler.js';

// Helper: wait until the scheduler reports no pending work.
function flush(sched, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (!sched.isBusy()) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('flush timed out'));
            setTimeout(tick, 0);
        };
        tick();
    });
}

// ─────────────────────────────────────────────────────────────────
// Construction / configuration validation
// ─────────────────────────────────────────────────────────────────

describe('createScheduler: config validation', () => {
    it('accepts a default config', () => {
        const s = createScheduler();
        expect(s.isBusy()).toBe(false);
        s.destroy();
    });

    it('rejects non-positive budgetMs', () => {
        expect(() => createScheduler({ budgetMs: -5 })).toThrow(/budgetMs/);
        expect(() => createScheduler({ budgetMs: NaN })).toThrow(/budgetMs/);
        expect(() => createScheduler({ budgetMs: Infinity })).toThrow(/budgetMs/);
    });

    it('rejects negative maxTasks', () => {
        expect(() => createScheduler({ maxTasks: -1 })).toThrow(/maxTasks/);
        expect(() => createScheduler({ maxTasks: 1.5 })).toThrow(/maxTasks/);
    });

    it('rejects unknown capacity policies', () => {
        expect(() => createScheduler({ onCapacityExceeded: 'panic' })).toThrow(/onCapacityExceeded/);
    });

    it('accepts all three valid capacity policies', () => {
        for (const p of ['throw', 'grow', 'drop']) {
            const s = createScheduler({ onCapacityExceeded: p });
            expect(s).toBeDefined();
            s.destroy();
        }
    });
});

// ─────────────────────────────────────────────────────────────────
// Basic scheduling / execution
// ─────────────────────────────────────────────────────────────────

describe('schedule: basic execution', () => {
    let sched;
    beforeEach(() => { sched = createScheduler(); });
    afterEach(() => { sched.destroy(); });

    it('executes a single task', async () => {
        const fn = vi.fn();
        sched.schedule(fn);
        await flush(sched);
        expect(fn).toHaveBeenCalledOnce();
    });

    it('executes multiple tasks in FIFO order within a priority', async () => {
        const order = [];
        for (let i = 0; i < 5; i++) {
            sched.schedule(() => order.push(i));
        }
        await flush(sched);
        expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('starts in non-busy state', () => {
        expect(sched.isBusy()).toBe(false);
    });

    it('tracks total execution count via stats', async () => {
        expect(sched.stats().totalExecuted).toBe(0);
        sched.schedule(() => {});
        sched.schedule(() => {});
        sched.schedule(() => {});
        await flush(sched);
        expect(sched.stats().totalExecuted).toBe(3);
    });
});

// ─────────────────────────────────────────────────────────────────
// Priority lanes — the headline feature
// ─────────────────────────────────────────────────────────────────

describe('schedule: priority lanes', () => {
    let sched;
    beforeEach(() => { sched = createScheduler(); });
    afterEach(() => { sched.destroy(); });

    it('runs higher priorities before lower within a single flush', async () => {
        const order = [];
        sched.schedule(() => order.push('idle'), Priority.Idle);
        sched.schedule(() => order.push('background'), Priority.Background);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        sched.schedule(() => order.push('user'), Priority.UserInput);

        await flush(sched);
        expect(order).toEqual(['user', 'normal', 'background', 'idle']);
    });

    it('drains Immediate before any SLL work', async () => {
        const order = [];
        sched.schedule(() => order.push('normal'), Priority.Normal);
        sched.schedule(() => order.push('immediate'), Priority.Immediate);
        sched.schedule(() => order.push('user'), Priority.UserInput);

        await flush(sched);
        expect(order[0]).toBe('immediate');
        expect(order).toEqual(['immediate', 'user', 'normal']);
    });

    it('preserves FIFO within Immediate', async () => {
        const order = [];
        for (let i = 0; i < 10; i++) {
            sched.schedule(() => order.push(i), Priority.Immediate);
        }
        await flush(sched);
        expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('coerces out-of-range priorities to Normal', async () => {
        const order = [];
        sched.schedule(() => order.push('idle'), Priority.Idle);
        sched.schedule(() => order.push('weird-high'), 99); // → Normal
        sched.schedule(() => order.push('weird-neg'), -50); // -50 !== Immediate (0), coerced to Normal
        await flush(sched);
        expect(order.indexOf('weird-high')).toBeLessThan(order.indexOf('idle'));
        expect(order.indexOf('weird-neg')).toBeLessThan(order.indexOf('idle'));
    });
});

// ─────────────────────────────────────────────────────────────────
// Capacity policies
// ─────────────────────────────────────────────────────────────────

describe('schedule: capacity policies', () => {
    it('throws CapacityError under "throw" policy when SLL is full', () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'throw' });
        sched.schedule(() => {});
        sched.schedule(() => {});
        expect(() => sched.schedule(() => {})).toThrow(CapacityError);
        sched.destroy();
    });

    it('silently drops under "drop" policy', () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'drop' });
        sched.schedule(() => {});
        sched.schedule(() => {});
        expect(() => sched.schedule(() => {})).not.toThrow();
        sched.destroy();
    });

    it('grows under "grow" policy', async () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'grow' });
        const fn = vi.fn();
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        expect(sched.stats().poolCapacity).toBeGreaterThanOrEqual(4);
        await flush(sched);
        expect(fn).toHaveBeenCalledTimes(5);
        sched.destroy();
    });

    it('caps growth at maxTasks * 16', () => {
        const sched = createScheduler({ maxTasks: 1, onCapacityExceeded: 'grow' });
        try {
            for (let i = 0; i < 50; i++) sched.schedule(() => {});
            throw new Error('expected CapacityError to be thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(CapacityError);
        }
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────

describe('schedule: error handling', () => {
    it('catches sync errors and routes them to onError', async () => {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push({ msg, err }) });
        sched.schedule(() => { throw new Error('boom'); });
        sched.schedule(() => {});
        await flush(sched);
        expect(errors).toHaveLength(1);
        expect(errors[0].err.message).toBe('boom');
        sched.destroy();
    });

    it('catches errors from Immediate tasks', async () => {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push(msg) });
        sched.schedule(() => { throw new Error('immediate-boom'); }, Priority.Immediate);
        await flush(sched);
        expect(errors[0]).toMatch(/Immediate/);
        sched.destroy();
    });

    it('continues processing after a task throws', async () => {
        const sched = createScheduler({ onError: () => {} });
        let ranAfter = false;
        sched.schedule(() => { throw new Error('first'); });
        sched.schedule(() => { ranAfter = true; });
        await flush(sched);
        expect(ranAfter).toBe(true);
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// shouldYield / isBusy
// ─────────────────────────────────────────────────────────────────

describe('shouldYield', () => {
    it('returns true outside of an active flush', () => {
        const sched = createScheduler();
        expect(sched.shouldYield()).toBe(true);
        sched.destroy();
    });

    it('returns false inside a fresh flush with a generous budget', async () => {
        const sched = createScheduler({ budgetMs: 100 });
        let snapshot = null;
        sched.schedule(() => { snapshot = sched.shouldYield(); });
        await flush(sched);
        expect(snapshot).toBe(false);
        sched.destroy();
    });
});

describe('isBusy', () => {
    it('reflects pending work', async () => {
        const sched = createScheduler();
        expect(sched.isBusy()).toBe(false);
        sched.schedule(() => {});
        expect(sched.isBusy()).toBe(true);
        await flush(sched);
        expect(sched.isBusy()).toBe(false);
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// yieldTask — promise-based scheduling
// ─────────────────────────────────────────────────────────────────

describe('yieldTask', () => {
    it('resolves on the next tick', async () => {
        const sched = createScheduler();
        const before = Date.now();
        await sched.yieldTask();
        expect(Date.now() - before).toBeLessThan(50);
        sched.destroy();
    });

    it('respects priority', async () => {
        const sched = createScheduler();
        const order = [];
        const a = sched.yieldTask(Priority.Idle).then(() => order.push('idle'));
        const b = sched.yieldTask(Priority.UserInput).then(() => order.push('user'));
        const c = sched.yieldTask(Priority.Normal).then(() => order.push('normal'));
        await Promise.all([a, b, c]);
        expect(order).toEqual(['user', 'normal', 'idle']);
        sched.destroy();
    });

    it('rejects after destroy', async () => {
        const sched = createScheduler();
        sched.destroy();
        await expect(sched.yieldTask()).rejects.toThrow(/destroyed/);
    });
});

// ─────────────────────────────────────────────────────────────────
// destroy() — cleanup semantics
// ─────────────────────────────────────────────────────────────────

describe('destroy', () => {
    it('is idempotent', () => {
        const sched = createScheduler();
        sched.destroy();
        expect(() => sched.destroy()).not.toThrow();
    });

    it('schedule becomes a no-op', () => {
        const sched = createScheduler();
        sched.destroy();
        let ran = false;
        sched.schedule(() => { ran = true; });
        expect(ran).toBe(false);
        expect(sched.isBusy()).toBe(false);
    });

    it('drops in-flight tasks', async () => {
        const sched = createScheduler();
        const fn = vi.fn();
        sched.schedule(fn);
        sched.destroy();
        await new Promise(r => setTimeout(r, 20));
        expect(fn).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────
// Stats snapshot
// ─────────────────────────────────────────────────────────────────

describe('stats', () => {
    it('reflects queued tasks before drain', () => {
        const sched = createScheduler();
        sched.schedule(() => {});
        sched.schedule(() => {});
        sched.schedule(() => {}, Priority.Immediate);
        const s = sched.stats();
        expect(s.activeSllTasks).toBe(2);
        expect(s.activeImmediateTasks).toBe(1);
        expect(s.totalExecuted).toBe(0);
        sched.destroy();
    });

    it('counts executed tasks across drains', async () => {
        const sched = createScheduler();
        for (let i = 0; i < 100; i++) sched.schedule(() => {});
        await flush(sched);
        expect(sched.stats().totalExecuted).toBe(100);
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// The "lost work" bug regression — tasks queued during a flush
// ─────────────────────────────────────────────────────────────────

describe('regression: tasks scheduled inside a flush still run', () => {
    it('handles a task scheduling another task', async () => {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => {
            order.push('outer');
            sched.schedule(() => order.push('inner'));
        });
        await flush(sched);
        expect(order).toEqual(['outer', 'inner']);
        sched.destroy();
    });

    it('handles long chains of self-scheduling tasks', async () => {
        const sched = createScheduler();
        let count = 0;
        const step = () => {
            count++;
            if (count < 100) sched.schedule(step);
        };
        sched.schedule(step);
        await flush(sched, 5000);
        expect(count).toBe(100);
        sched.destroy();
    });

    it('an Immediate task scheduled by an SLL task is drained next', async () => {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => {
            order.push('sll');
            sched.schedule(() => order.push('immediate'), Priority.Immediate);
        });
        await flush(sched);
        expect(order).toEqual(['sll', 'immediate']);
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// Frame budget — long-running tasks pause and resume
// ─────────────────────────────────────────────────────────────────

describe('frame budget', () => {
    it('completes all tasks regardless of tight budget', async () => {
        // Each task burns ~0.5ms. With budgetMs=2, the scheduler yields
        // every ~4 tasks. All 50 should still complete.
        const sched = createScheduler({ budgetMs: 2 });
        let executed = 0;
        for (let i = 0; i < 50; i++) {
            sched.schedule(() => {
                const t = performance.now();
                while (performance.now() - t < 0.5) { /* burn */ }
                executed++;
            });
        }
        await flush(sched, 10000);
        expect(executed).toBe(50);
        sched.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────
// Immediate ring buffer wraparound under growth
// ─────────────────────────────────────────────────────────────────

describe('immediate ring buffer', () => {
    it('handles capacity growth correctly', async () => {
        const sched = createScheduler({ onCapacityExceeded: 'grow' });
        let count = 0;
        // 2000 > default capacity (1024); triggers at least one grow.
        for (let i = 0; i < 2000; i++) {
            sched.schedule(() => count++, Priority.Immediate);
        }
        await flush(sched, 5000);
        expect(count).toBe(2000);
        expect(sched.stats().immediateCapacity).toBeGreaterThanOrEqual(2048);
        sched.destroy();
    });
});
