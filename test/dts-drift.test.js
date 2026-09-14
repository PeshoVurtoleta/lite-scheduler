/**
 * @zakkster/lite-scheduler -- .d.ts / llms.txt drift guard (node:test).
 *
 * A hand-written ambient .d.ts and an llms.txt earn their keep only if a gate
 * proves they never drift from the runtime. This suite reads the file TEXT of
 * Scheduler.js, Scheduler.d.ts, llms.txt and package.json (never imports them)
 * and asserts, each DERIVED by regex, never hardcoded:
 *
 *   (a) version parity : the VERSION literal in Scheduler.js EQUALS the version
 *       in package.json; Scheduler.d.ts DECLARES `VERSION`; the llms.txt header
 *       carries the same version.
 *   (b) surface parity : every RUNTIME export of Scheduler.js is declared in
 *       Scheduler.d.ts and mentioned in llms.txt (forward), and every runtime
 *       value export declared in the d.ts exists in Scheduler.js (reverse).
 *
 * Each check is a PURE function over text, so the same function proves teeth: the
 * mutation controls feed it a mutated COPY and assert it now reports a diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FastBitScheduler, EMPTY } from '../Scheduler.js';

const ROOT = new URL('../', import.meta.url);
const JS = readFileSync(new URL('Scheduler.js', ROOT), 'utf8');
const DTS = readFileSync(new URL('Scheduler.d.ts', ROOT), 'utf8');
const LLMS = readFileSync(new URL('llms.txt', ROOT), 'utf8');
const PKG = readFileSync(new URL('package.json', ROOT), 'utf8');

// --- pure extractors (text in, Set/string out) ------------------------------

/** VERSION string literal in Scheduler.js. */
function jsVersion(jsText) {
    const m = /export const VERSION\s*=\s*"([^"]+)"/.exec(jsText);
    assert.ok(m, 'Scheduler.js has no `export const VERSION = "..."` literal');
    return m[1];
}

/** version field in package.json. */
function pkgVersion(pkgText) {
    const m = /"version":\s*"([^"]+)"/.exec(pkgText);
    assert.ok(m, 'package.json has no version field');
    return m[1];
}

/** version in the llms.txt header (`# @zakkster/lite-scheduler vX.Y.Z`). */
function llmsVersion(llmsText) {
    const m = /#\s*@zakkster\/lite-scheduler\s+v([0-9][^\s]*)/.exec(llmsText);
    assert.ok(m, 'llms.txt header has no version');
    return m[1];
}

/** True if the d.ts declares a `VERSION` export. */
function dtsDeclaresVersion(dtsText) {
    return /export const VERSION\b/.test(dtsText);
}

/** Runtime (value) exports of a module text: const / class / function names. */
function runtimeExports(text) {
    const out = new Set();
    const re = /export\s+(?:const|class|function)\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.add(m[1]);
    return out;
}

/** Symmetric-difference report between two sets: [] when equal. */
function setDiff(a, b, labelA, labelB) {
    const diffs = [];
    for (const x of a) if (!b.has(x)) diffs.push(labelA + ' has ' + x + ' but ' + labelB + ' does not');
    for (const x of b) if (!a.has(x)) diffs.push(labelB + ' has ' + x + ' but ' + labelA + ' does not');
    return diffs;
}

// The intended runtime surface, pinned so a silent add/drop on BOTH sides is
// still caught.
const SURFACE = [
    'Priority', 'CapacityError', 'createScheduler', 'setDefaultScheduler',
    'schedule', 'shouldYield', 'isBusy', 'yieldTask', 'stats', 'VERSION',
    // second member (v1.1.0)
    'EMPTY', 'FastBitScheduler',
];

// FastBitScheduler's PUBLIC surface (methods + getters) and the internal fields
// that are deliberately NOT declared in the d.ts. The allowlist is explicit so
// adding an instance field silently is caught by the reverse check below.
const FB_METHODS = ['push', 'popMin', 'peekMin', 'peekPriority', 'isEmpty', 'sizeOf', 'clear'];
const FB_GETTERS = ['size', 'capacity', 'requestedCapacity', 'numTiers'];
const FB_INTERNAL = [
    'activeMask', 'buckets', 'heads', 'tails', 'counts',
    '_cap', '_mask', '_size', '_maxPrio', '_numTiers', '_requestedCapacity',
];

// --- the inventories --------------------------------------------------------

test('(a) version parity: Scheduler.js VERSION === package.json === llms.txt header + d.ts declares VERSION', () => {
    assert.equal(jsVersion(JS), pkgVersion(PKG));
    assert.equal(jsVersion(JS), llmsVersion(LLMS));
    assert.ok(dtsDeclaresVersion(DTS), 'Scheduler.d.ts must declare `export const VERSION`');
});

test('(b) surface parity: every runtime export of Scheduler.js is declared in d.ts and mentioned in llms.txt', () => {
    const js = runtimeExports(JS);
    // The pinned surface is exactly the runtime exports.
    const diffs = setDiff(js, new Set(SURFACE), 'Scheduler.js', 'pinned surface');
    assert.deepEqual(diffs, [], diffs.join('; '));
    const dts = runtimeExports(DTS);
    for (const nm of js) {
        assert.ok(dts.has(nm), 'Scheduler.d.ts is missing runtime export ' + nm);
        assert.ok(new RegExp('\\b' + nm + '\\b').test(LLMS), 'llms.txt does not mention export ' + nm);
    }
    // Reverse: every runtime value export declared in the d.ts exists in the JS.
    const rev = setDiff(js, dts, 'Scheduler.js', 'Scheduler.d.ts');
    assert.deepEqual(rev, [], rev.join('; '));
});

// --- teeth: each check must reject a mutated COPY (non-vacuity) --------------

test('control: unmutated text agrees (vacuity)', () => {
    assert.equal(jsVersion(JS), pkgVersion(PKG));
    assert.equal(jsVersion(JS), llmsVersion(LLMS));
    assert.deepEqual(setDiff(runtimeExports(JS), runtimeExports(DTS), 'a', 'b'), []);
});

test('control: desyncing package.json version fails version parity', () => {
    const mutated = PKG.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9"');
    assert.notEqual(jsVersion(JS), pkgVersion(mutated));
});

test('control: dropping VERSION from the d.ts fails the version check', () => {
    const mutated = DTS.replace(/export const VERSION\b[^\n]*\n/, '');
    assert.ok(!dtsDeclaresVersion(mutated), 'removing VERSION from the d.ts did not fail the check');
});

test('control: dropping a runtime export from the d.ts fails surface parity', () => {
    const mutated = DTS.replace(/export function yieldTask\([^;]*;/, '');
    const diffs = setDiff(runtimeExports(JS), runtimeExports(mutated), 'Scheduler.js', 'Scheduler.d.ts');
    assert.ok(diffs.length > 0, 'dropping yieldTask from the d.ts did not fail surface parity');
});

// --- member parity: FastBitScheduler prototype/instance vs the d.ts ----------

test('(c) FastBitScheduler: every public method + getter is declared, and every instance field is on the allowlist', () => {
    const proto = FastBitScheduler.prototype;
    // Forward: every public method exists at runtime AND is declared in the d.ts.
    for (const m of FB_METHODS) {
        assert.equal(typeof proto[m], 'function', 'FastBitScheduler.prototype.' + m + ' missing at runtime');
        assert.ok(new RegExp('\\b' + m + '\\s*\\(').test(DTS), 'Scheduler.d.ts does not declare method ' + m);
    }
    // Forward: every getter exists on the prototype AND is declared `readonly` in the d.ts.
    for (const g of FB_GETTERS) {
        const d = Object.getOwnPropertyDescriptor(proto, g);
        assert.ok(d && typeof d.get === 'function', 'FastBitScheduler getter ' + g + ' missing at runtime');
        assert.ok(new RegExp('readonly\\s+' + g + '\\s*:').test(DTS), 'Scheduler.d.ts does not declare readonly ' + g);
    }
    // Reverse: every instance OWN field must be on the internal allowlist (so a
    // silently-added field is caught) and must NOT be declared in the d.ts.
    const inst = new FastBitScheduler(16, 32);
    for (const key of Object.keys(inst)) {
        assert.ok(FB_INTERNAL.includes(key),
            'FastBitScheduler instance field "' + key + '" is not on the internal allowlist -- declare it or add it to FB_INTERNAL');
        assert.ok(!new RegExp('\\b' + key + '\\b\\s*:').test(DTS),
            'internal field "' + key + '" leaked into the d.ts surface');
    }
});

test('(d) EMPTY: -1 at runtime and typed as the literal -1 in the d.ts', () => {
    assert.equal(EMPTY, -1);
    assert.ok(/export const EMPTY\s*:\s*-1\b/.test(DTS), 'd.ts must type EMPTY as the literal -1, not number');
});

test('control: a member method absent from the d.ts is caught', () => {
    const mutated = DTS.replace(/peekPriority\([^)]*\)\s*:\s*number;/, '');
    assert.ok(!/\bpeekPriority\s*\(/.test(mutated), 'mutation did not remove peekPriority from the d.ts copy');
});

test('control: a silently-added instance field is caught by the allowlist', () => {
    const inst = new FastBitScheduler(16, 32);
    inst._sneaky = 1; // simulate a field added without updating the allowlist
    let caught = false;
    for (const key of Object.keys(inst)) if (!FB_INTERNAL.includes(key)) caught = true;
    assert.ok(caught, 'a field outside the allowlist was not detected');
});
