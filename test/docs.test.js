/**
 * @zakkster/lite-scheduler -- hermetic documentation guards (node:test).
 *
 * A README and an llms.txt are load-bearing: a sibling package's pipeline reads
 * them, and a human trusts them. These guards read the file TEXT of README.md,
 * llms.txt, CHANGELOG.md and package.json (never import a module) and assert
 * structural invariants that would otherwise rot silently:
 *
 *   1. SPINE ORDER   : README H2s follow the LiteSepforge blueprint spine, with
 *      exactly two package-specific inserts, each in its permitted slot.
 *   2. RELATIVE LINKS: every non-http, non-anchor `](path)` in README + llms
 *      resolves on disk (anchor stripped).
 *   3. ASCII         : README, llms, CHANGELOG carry no code point outside ASCII
 *      except U+00D7 and U+00B5.
 *   4. SCRIPTS EXIST : every `npm run <x>` / `npm test` token the README
 *      advertises maps to a real package.json scripts key.
 *   5. PROVENANCE    : the README Benchmarks section and the llms performance
 *      section each carry a `Measured on node v` stamp line.
 *
 * Every check is a PURE function over text, so the same function proves teeth:
 * the mutation controls feed it a mutated COPY and assert it now reports a diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const LLMS = readFileSync(new URL('llms.txt', ROOT), 'utf8');
const CHANGELOG = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');
const PKG = readFileSync(new URL('package.json', ROOT), 'utf8');

// --- pure extractors --------------------------------------------------------

/** All level-2 headings, in document order, as trimmed strings. */
function h2s(text) {
    const out = [];
    const re = /^##[ \t]+(.+?)[ \t]*$/gm;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
}

// The canonical blueprint spine (LiteSepforge order), one regex per H2 that is
// NOT a package-specific insert. Order here IS the asserted order.
const CANON = [
    /scheduler pair the ecosystem was missing/i,
    /^Table of contents$/i,
    /^Why this exists$/i,
    /^What you get$/i,
    /^Two schedulers, two jobs$/i,
    /^API reference$/i,
    /^Composability with the ecosystem$/i,
    /^Zero-GC design notes$/i,
    /^Design decisions worth knowing$/i,
    /^Testing$/i,
    /^What this is not$/i,
    /^Ecosystem$/i,
    /^License$/i,
];

// The two permitted package-specific inserts (mirroring the blueprint's own two
// inserts), each with the canonical neighbour it must sit between.
const INSERT_HANDLE = /^The handle contract$/i;      // between API reference and Composability
const INSERT_BENCH = /^Benchmarks$/i;                // between Zero-GC notes and Design decisions

function classifyH2(h) {
    for (let i = 0; i < CANON.length; i++) if (CANON[i].test(h)) return { kind: 'canon', i };
    if (INSERT_HANDLE.test(h)) return { kind: 'handle' };
    if (INSERT_BENCH.test(h)) return { kind: 'bench' };
    return { kind: 'stray' };
}

/** Returns a list of spine violations for a README text; [] when clean. */
function spineViolations(text) {
    const heads = h2s(text);
    const problems = [];
    let lastCanon = -1;
    const canonIndexAt = []; // position-in-heads for each canon slot, or -1
    for (let i = 0; i < CANON.length; i++) canonIndexAt.push(-1);
    heads.forEach((h, pos) => {
        const c = classifyH2(h);
        if (c.kind === 'stray') { problems.push('stray H2: "' + h + '"'); return; }
        if (c.kind === 'canon') {
            if (c.i <= lastCanon) problems.push('canonical H2 out of order: "' + h + '"');
            lastCanon = c.i;
            canonIndexAt[c.i] = pos;
        }
    });
    // every canonical section present
    for (let i = 0; i < CANON.length; i++) {
        if (canonIndexAt[i] === -1) problems.push('missing canonical H2 #' + i + ' (' + CANON[i] + ')');
    }
    // insert slotting: handle between API reference (5) and Composability (6)
    const api = canonIndexAt[5], compos = canonIndexAt[6];
    const zeroGc = canonIndexAt[7], decisions = canonIndexAt[8];
    const handlePos = heads.findIndex((h) => INSERT_HANDLE.test(h));
    const benchPos = heads.findIndex((h) => INSERT_BENCH.test(h));
    if (handlePos === -1) problems.push('missing insert: The handle contract');
    else if (!(api !== -1 && compos !== -1 && handlePos > api && handlePos < compos))
        problems.push('The handle contract not slotted between API reference and Composability');
    if (benchPos === -1) problems.push('missing insert: Benchmarks');
    else if (!(zeroGc !== -1 && decisions !== -1 && benchPos > zeroGc && benchPos < decisions))
        problems.push('Benchmarks not slotted between Zero-GC design notes and Design decisions');
    return problems;
}

/** Relative link targets (not http(s), not pure anchors) in a markdown text. */
function relLinks(text) {
    const out = [];
    const re = /\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim();
        if (/^https?:/i.test(raw)) continue;
        if (raw.startsWith('#')) continue;
        if (/^mailto:/i.test(raw)) continue;
        out.push(raw.split('#')[0]);
    }
    return out;
}

/** Code points outside ASCII except the two allowed (U+00D7, U+00B5). */
function nonAsciiOffenders(text) {
    const out = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f && cp !== 0x00d7 && cp !== 0x00b5) out.push(cp.toString(16));
    }
    return out;
}

/** npm script tokens advertised in a markdown text: `npm test`, `npm run X`. */
function advertisedScripts(text) {
    const out = new Set();
    let m;
    const reRun = /npm run ([a-zA-Z0-9:_-]+)/g;
    while ((m = reRun.exec(text)) !== null) out.add(m[1]);
    if (/\bnpm test\b/.test(text)) out.add('test');
    return out;
}

/** package.json scripts keys. */
function pkgScripts(pkgText) {
    const obj = JSON.parse(pkgText);
    return new Set(Object.keys(obj.scripts || {}));
}

/** Text of the section under an H2 whose title matches `re`, up to next H2. */
function sectionBody(text, re) {
    const heads = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
    for (let i = 0; i < heads.length; i++) {
        if (re.test(heads[i][1])) {
            const start = heads[i].index;
            const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
            return text.slice(start, end);
        }
    }
    return '';
}

// --- the guards -------------------------------------------------------------

test('1. spine order: README follows the blueprint spine with two slotted inserts', () => {
    const v = spineViolations(README);
    assert.deepEqual(v, [], v.join('; '));
});

test('2. relative links: every non-http link in README + llms resolves on disk', () => {
    const missing = [];
    for (const [label, text] of [['README.md', README], ['llms.txt', LLMS]]) {
        for (const rel of relLinks(text)) {
            const abs = fileURLToPath(new URL(rel, ROOT));
            if (!existsSync(abs)) missing.push(label + ' -> ' + rel);
        }
    }
    assert.deepEqual(missing, [], 'unresolved relative links: ' + missing.join(', '));
});

test('3. ascii: README, llms, CHANGELOG are ASCII (U+00D7 and U+00B5 excepted)', () => {
    for (const [label, text] of [['README.md', README], ['llms.txt', LLMS], ['CHANGELOG.md', CHANGELOG]]) {
        const off = nonAsciiOffenders(text);
        assert.deepEqual(off, [], label + ' has non-ASCII code points: ' + off.join(', '));
    }
});

test('4. scripts exist: every npm script the README advertises is a real package.json key', () => {
    const have = pkgScripts(PKG);
    const missing = [];
    for (const s of advertisedScripts(README)) if (!have.has(s)) missing.push(s);
    assert.deepEqual(missing, [], 'README advertises non-existent scripts: ' + missing.join(', '));
});

test('5. provenance: README Benchmarks and llms performance carry a node-version stamp', () => {
    const bench = sectionBody(README, /^Benchmarks$/i);
    assert.ok(bench, 'README has no Benchmarks section');
    assert.ok(/Measured on node v/.test(bench), 'README Benchmarks section carries no `Measured on node v` stamp');
    // llms.txt is not H2-structured; look at the whole file for its perf stamp.
    assert.ok(/Measured on node v/.test(LLMS), 'llms.txt carries no `Measured on node v` stamp');
});

// --- teeth: each structural check rejects a mutated COPY ---------------------

test('control: a reordered README fails the spine-order check', () => {
    // Swap "Why this exists" below "API reference" -> canonical order breaks.
    const mutated = README
        .replace(/^## Why this exists$/m, '## __MOVED_WHY__')
        .replace(/^## API reference$/m, '## API reference\n\n## Why this exists');
    const v = spineViolations(mutated);
    assert.ok(v.length > 0, 'reordering Why this exists did not trip the spine check');
});

test('control: a bogus advertised script fails the scripts-exist check', () => {
    const mutated = README + '\n\n```bash\nnpm run test:watch\n```\n';
    const have = pkgScripts(PKG);
    const missing = [];
    for (const s of advertisedScripts(mutated)) if (!have.has(s)) missing.push(s);
    assert.ok(missing.includes('test:watch'), 'a bogus `npm run test:watch` was not caught');
});
