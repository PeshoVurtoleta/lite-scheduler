/**
 * @zakkster/lite-scheduler -- Unit test suite.
 *
 * Tests use a per-test scheduler instance with explicit `destroy()` to keep
 * the test process clean.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    createScheduler,
    Priority,
    CapacityError,
} from '../Scheduler.js';

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

// -------------------------------------------------------------------
// Construction / configuration validation
// -------------------------------------------------------------------

describe('createScheduler: config validation', () => {
    it('accepts a default config', () => {
        const s = createScheduler();
        assert.equal(s.isBusy(), false);
        s.destroy();
    });

    it('rejects non-positive budgetMs', () => {
        assert.throws(() => createScheduler({ budgetMs: -5 }), /budgetMs/);
        assert.throws(() => createScheduler({ budgetMs: NaN }), /budgetMs/);
        assert.throws(() => createScheduler({ budgetMs: Infinity }), /budgetMs/);
    });

    it('rejects negative maxTasks', () => {
        assert.throws(() => createScheduler({ maxTasks: -1 }), /maxTasks/);
        assert.throws(() => createScheduler({ maxTasks: 1.5 }), /maxTasks/);
    });

    it('rejects unknown capacity policies', () => {
        assert.throws(() => createScheduler({ onCapacityExceeded: 'panic' }), /onCapacityExceeded/);
    });

    it('accepts all three valid capacity policies', () => {
        for (const p of ['throw', 'grow', 'drop']) {
            const s = createScheduler({ onCapacityExceeded: p });
            assert.notEqual(s, undefined);
            s.destroy();
        }
    });
});

// -------------------------------------------------------------------
// Basic scheduling / execution
// -------------------------------------------------------------------

describe('schedule: basic execution', () => {
    let sched;
    beforeEach(() => { sched = createScheduler(); });
    afterEach(() => { sched.destroy(); });

    it('executes a single task', async () => {
        const fn = mock.fn();
        sched.schedule(fn);
        await flush(sched);
        assert.equal(fn.mock.callCount(), 1);
    });

    it('executes multiple tasks in FIFO order within a priority', async () => {
        const order = [];
        for (let i = 0; i < 5; i++) {
            sched.schedule(() => order.push(i));
        }
        await flush(sched);
        assert.deepEqual(order, [0, 1, 2, 3, 4]);
    });

    it('starts in non-busy state', () => {
        assert.equal(sched.isBusy(), false);
    });

    it('tracks total execution count via stats', async () => {
        assert.equal(sched.stats().totalExecuted, 0);
        sched.schedule(() => {});
        sched.schedule(() => {});
        sched.schedule(() => {});
        await flush(sched);
        assert.equal(sched.stats().totalExecuted, 3);
    });
});

// -------------------------------------------------------------------
// Priority lanes -- the headline feature
// -------------------------------------------------------------------

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
        assert.deepEqual(order, ['user', 'normal', 'background', 'idle']);
    });

    it('drains Immediate before any SLL work', async () => {
        const order = [];
        sched.schedule(() => order.push('normal'), Priority.Normal);
        sched.schedule(() => order.push('immediate'), Priority.Immediate);
        sched.schedule(() => order.push('user'), Priority.UserInput);

        await flush(sched);
        assert.equal(order[0], 'immediate');
        assert.deepEqual(order, ['immediate', 'user', 'normal']);
    });

    it('preserves FIFO within Immediate', async () => {
        const order = [];
        for (let i = 0; i < 10; i++) {
            sched.schedule(() => order.push(i), Priority.Immediate);
        }
        await flush(sched);
        assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('coerces out-of-range priorities to Normal', async () => {
        const order = [];
        sched.schedule(() => order.push('idle'), Priority.Idle);
        sched.schedule(() => order.push('weird-high'), 99); // -> Normal
        sched.schedule(() => order.push('weird-neg'), -50); // -50 !== Immediate (0), coerced to Normal
        await flush(sched);
        assert.ok(order.indexOf('weird-high') < order.indexOf('idle'));
        assert.ok(order.indexOf('weird-neg') < order.indexOf('idle'));
    });
});

// -------------------------------------------------------------------
// Capacity policies
// -------------------------------------------------------------------

describe('schedule: capacity policies', () => {
    it('throws CapacityError under "throw" policy when SLL is full', () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'throw' });
        sched.schedule(() => {});
        sched.schedule(() => {});
        assert.throws(() => sched.schedule(() => {}), CapacityError);
        sched.destroy();
    });

    it('silently drops under "drop" policy', () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'drop' });
        sched.schedule(() => {});
        sched.schedule(() => {});
        assert.doesNotThrow(() => sched.schedule(() => {}));
        sched.destroy();
    });

    it('grows under "grow" policy', async () => {
        const sched = createScheduler({ maxTasks: 2, onCapacityExceeded: 'grow' });
        const fn = mock.fn();
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        sched.schedule(fn);
        assert.ok(sched.stats().poolCapacity >= 4);
        await flush(sched);
        assert.equal(fn.mock.callCount(), 5);
        sched.destroy();
    });

    it('caps growth at maxTasks * 16', () => {
        const sched = createScheduler({ maxTasks: 1, onCapacityExceeded: 'grow' });
        try {
            for (let i = 0; i < 50; i++) sched.schedule(() => {});
            throw new Error('expected CapacityError to be thrown');
        } catch (e) {
            assert.ok(e instanceof CapacityError);
        }
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// Error handling
// -------------------------------------------------------------------

describe('schedule: error handling', () => {
    it('catches sync errors and routes them to onError', async () => {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push({ msg, err }) });
        sched.schedule(() => { throw new Error('boom'); });
        sched.schedule(() => {});
        await flush(sched);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].err.message, 'boom');
        sched.destroy();
    });

    it('catches errors from Immediate tasks', async () => {
        const errors = [];
        const sched = createScheduler({ onError: (msg, err) => errors.push(msg) });
        sched.schedule(() => { throw new Error('immediate-boom'); }, Priority.Immediate);
        await flush(sched);
        assert.match(errors[0], /Immediate/);
        sched.destroy();
    });

    it('continues processing after a task throws', async () => {
        const sched = createScheduler({ onError: () => {} });
        let ranAfter = false;
        sched.schedule(() => { throw new Error('first'); });
        sched.schedule(() => { ranAfter = true; });
        await flush(sched);
        assert.equal(ranAfter, true);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// shouldYield / isBusy
// -------------------------------------------------------------------

describe('shouldYield', () => {
    it('returns true outside of an active flush', () => {
        const sched = createScheduler();
        assert.equal(sched.shouldYield(), true);
        sched.destroy();
    });

    it('returns false inside a fresh flush with a generous budget', async () => {
        const sched = createScheduler({ budgetMs: 100 });
        let snapshot = null;
        sched.schedule(() => { snapshot = sched.shouldYield(); });
        await flush(sched);
        assert.equal(snapshot, false);
        sched.destroy();
    });
});

describe('isBusy', () => {
    it('reflects pending work', async () => {
        const sched = createScheduler();
        assert.equal(sched.isBusy(), false);
        sched.schedule(() => {});
        assert.equal(sched.isBusy(), true);
        await flush(sched);
        assert.equal(sched.isBusy(), false);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// yieldTask -- promise-based scheduling
// -------------------------------------------------------------------

describe('yieldTask', () => {
    it('resolves on the next tick', async () => {
        const sched = createScheduler();
        const before = Date.now();
        await sched.yieldTask();
        assert.ok(Date.now() - before < 50);
        sched.destroy();
    });

    it('respects priority', async () => {
        const sched = createScheduler();
        const order = [];
        const a = sched.yieldTask(Priority.Idle).then(() => order.push('idle'));
        const b = sched.yieldTask(Priority.UserInput).then(() => order.push('user'));
        const c = sched.yieldTask(Priority.Normal).then(() => order.push('normal'));
        await Promise.all([a, b, c]);
        assert.deepEqual(order, ['user', 'normal', 'idle']);
        sched.destroy();
    });

    it('rejects after destroy', async () => {
        const sched = createScheduler();
        sched.destroy();
        await assert.rejects(sched.yieldTask(), /destroyed/);
    });
});

// -------------------------------------------------------------------
// destroy() -- cleanup semantics
// -------------------------------------------------------------------

describe('destroy', () => {
    it('is idempotent', () => {
        const sched = createScheduler();
        sched.destroy();
        assert.doesNotThrow(() => sched.destroy());
    });

    it('schedule becomes a no-op', () => {
        const sched = createScheduler();
        sched.destroy();
        let ran = false;
        sched.schedule(() => { ran = true; });
        assert.equal(ran, false);
        assert.equal(sched.isBusy(), false);
    });

    it('drops in-flight tasks', async () => {
        const sched = createScheduler();
        const fn = mock.fn();
        sched.schedule(fn);
        sched.destroy();
        await new Promise(r => setTimeout(r, 20));
        assert.equal(fn.mock.callCount(), 0);
    });
});

// -------------------------------------------------------------------
// Stats snapshot
// -------------------------------------------------------------------

describe('stats', () => {
    it('reflects queued tasks before drain', () => {
        const sched = createScheduler();
        sched.schedule(() => {});
        sched.schedule(() => {});
        sched.schedule(() => {}, Priority.Immediate);
        const s = sched.stats();
        assert.equal(s.activeSllTasks, 2);
        assert.equal(s.activeImmediateTasks, 1);
        assert.equal(s.totalExecuted, 0);
        sched.destroy();
    });

    it('counts executed tasks across drains', async () => {
        const sched = createScheduler();
        for (let i = 0; i < 100; i++) sched.schedule(() => {});
        await flush(sched);
        assert.equal(sched.stats().totalExecuted, 100);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// The "lost work" bug regression -- tasks queued during a flush
// -------------------------------------------------------------------

describe('regression: tasks scheduled inside a flush still run', () => {
    it('handles a task scheduling another task', async () => {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => {
            order.push('outer');
            sched.schedule(() => order.push('inner'));
        });
        await flush(sched);
        assert.deepEqual(order, ['outer', 'inner']);
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
        assert.equal(count, 100);
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
        assert.deepEqual(order, ['sll', 'immediate']);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// Frame budget -- long-running tasks pause and resume
// -------------------------------------------------------------------

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
        assert.equal(executed, 50);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// Immediate ring buffer wraparound under growth
// -------------------------------------------------------------------

describe('immediate ring buffer', () => {
    it('handles capacity growth correctly', async () => {
        const sched = createScheduler({ onCapacityExceeded: 'grow' });
        let count = 0;
        // 2000 > default capacity (1024); triggers at least one grow.
        for (let i = 0; i < 2000; i++) {
            sched.schedule(() => count++, Priority.Immediate);
        }
        await flush(sched, 5000);
        assert.equal(count, 2000);
        assert.ok(sched.stats().immediateCapacity >= 2048);
        sched.destroy();
    });
});

// -------------------------------------------------------------------
// regression S-01/S-02: the priority door (F1, v1.0.3)
// -------------------------------------------------------------------

describe('regression S-01/S-02: every non-integer / out-of-range priority is Normal', () => {
    let sched;
    beforeEach(() => { sched = createScheduler(); });
    afterEach(() => { sched.destroy(); });

    // For each degenerate input, bracket the subject with a Normal task before
    // and a Normal task after. Coercion to Normal means the subject shares the
    // Normal lane and runs in strict schedule order: before < subject < after.
    // A subject that jumps into UserInput (NaN, pre-fix) runs before 'before';
    // one demoted to Background (3.7 / '3', pre-fix) runs after 'after'. Both
    // break the ordering -- the discriminating probe.
    for (const [label, prio] of [
        ['NaN', NaN],
        ['3.7', 3.7],
        ['2.5', 2.5],
        ['-1', -1],
        ['99', 99],
        ['Infinity', Infinity],
        ["'3' (string)", '3'],
    ]) {
        it('coerces ' + label + ' to the Normal lane', async () => {
            const order = [];
            sched.schedule(() => order.push('before'), Priority.Normal);
            sched.schedule(() => order.push('subject'), prio);
            sched.schedule(() => order.push('after'), Priority.Normal);
            await flush(sched);
            assert.deepEqual(order, ['before', 'subject', 'after'],
                'expected before < subject < after, got [' + order.join(',') + ']');
        });
    }

    it('S-01 probe: schedule(Normal) then schedule(NaN) runs in order', async () => {
        const order = [];
        sched.schedule(() => order.push('normal-first'), Priority.Normal);
        sched.schedule(() => order.push('nan'), NaN);
        await flush(sched);
        assert.deepEqual(order, ['normal-first', 'nan']);
    });
});

// -------------------------------------------------------------------
// createScheduler / schedule: the construction + task doors (F1, v1.0.3)
// -------------------------------------------------------------------

describe('createScheduler: door additions', () => {
    it('rejects an unknown config key naming the nearest known key', () => {
        assert.throws(() => createScheduler({ maxTask: 5000 }), /maxTasks/);
    });

    it('rejects a non-callable onError (string) at construction', () => {
        assert.throws(() => createScheduler({ onError: 'x' }), /lite-scheduler: onError/);
    });

    it('rejects an explicit null onError at construction (null is not zero)', () => {
        assert.throws(() => createScheduler({ onError: null }), /onError/);
    });

    it('throws a TypeError on schedule(null)', () => {
        const sched = createScheduler();
        assert.throws(() => sched.schedule(null), TypeError);
        sched.destroy();
    });

    it('throws a TypeError on schedule(undefined)', () => {
        const sched = createScheduler();
        assert.throws(() => sched.schedule(undefined), TypeError);
        sched.destroy();
    });

    it('throws a TypeError on a non-function Immediate task', () => {
        const sched = createScheduler();
        assert.throws(() => sched.schedule(42, Priority.Immediate), TypeError);
        sched.destroy();
    });

    it('constructs without throwing when all four known keys are supplied', () => {
        assert.doesNotThrow(() => {
            const sched = createScheduler({
                maxTasks: 8, budgetMs: 5, onCapacityExceeded: 'drop', onError: () => {},
            });
            sched.destroy();
        });
    });

    it('constructs without throwing when called with no argument', () => {
        assert.doesNotThrow(() => createScheduler().destroy());
    });

    it('constructs without throwing when called with an empty object', () => {
        assert.doesNotThrow(() => createScheduler({}).destroy());
    });

    it('hints the nearest known key even when the typo is a case mismatch', () => {
        assert.throws(() => createScheduler({ maxtasks: 5 }), /maxTasks/);
    });
});

// -------------------------------------------------------------------
// QA boundary sweep (F1 qa gate): post-destroy no-op, boolean priority
// coercion, no-arg / empty-config construction, lowercase key hint.
// -------------------------------------------------------------------

describe('QA boundary sweep', () => {
    it('post-destroy schedule(null) stays a silent no-op (destroyed check precedes the type door)', () => {
        const sched = createScheduler();
        sched.destroy();
        assert.doesNotThrow(() => sched.schedule(null));
        assert.doesNotThrow(() => sched.schedule(undefined));
    });

    it('a boolean true priority coerces to Normal, not Immediate', async () => {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('bool-true'), true);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        await flush(sched);
        assert.deepEqual(order, ['bool-true', 'normal']);
        sched.destroy();
    });

    it('a boolean false priority coerces to Normal, not Immediate', async () => {
        const sched = createScheduler();
        const order = [];
        sched.schedule(() => order.push('bool-false'), false);
        sched.schedule(() => order.push('normal'), Priority.Normal);
        await flush(sched);
        assert.deepEqual(order, ['bool-false', 'normal']);
        sched.destroy();
    });
});
