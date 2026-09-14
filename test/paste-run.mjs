/**
 * test/paste-run.mjs -- repo-only runner (NOT an npm script; package.json is frozen).
 *
 *   node test/paste-run.mjs
 *
 * Extracts every fenced code block from README.md and llms.txt, classifies each
 * against an EXPLICIT, FAIL-CLOSED allowlist (source#index + a fingerprint the
 * block must contain), and:
 *   - `run`       : writes the block to the scratchpad and executes it with
 *                   `node --input-type=module` from the REPO ROOT cwd, so the
 *                   package self-reference (exports map) and the --no-save
 *                   lite-arena install both resolve. Must exit 0 within 20 s.
 *   - `signature` : a ts / pseudo listing -- balanced fences only (guaranteed by
 *                   extraction); not executed.
 *   - `browser`   : DOM-touching -- `node --check` when it is plain JS, else
 *                   balanced-fence only.
 *   - `bash`      : shell -- not executed.
 *   - `mermaid`   : diagram -- skipped.
 * An UNCLASSIFIED block is a FAILURE. The allowlist must be total.
 *
 * Prerequisite (idempotent): `npm install --no-save @zakkster/lite-arena`, after
 * which package.json and the lockfile MUST be unchanged (fail closed otherwise).
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// --- the allowlist: source#index -> { class, fp } --------------------------
// `fp` is a substring the block MUST contain -- a guard so a reordered doc can
// never silently reclassify a block.
const ALLOW = {
    'README#0': { class: 'bash', fp: 'npm i' },                    // install
    'README#1': { class: 'run', fp: 'backgroundBeforeUser' },      // frame quick-start
    'README#2': { class: 'run', fp: 'FastBitScheduler' },          // FastBit quick-start
    'README#3': { class: 'mermaid', fp: 'flowchart' },             // naive vs lite
    'README#4': { class: 'mermaid', fp: 'flowchart' },             // architecture LR
    'README#5': { class: 'signature', fp: 'taskCount' },           // clock-batching fragment
    'README#6': { class: 'signature', fp: 'setDefaultScheduler' }, // convenience import fragment
    'README#7': { class: 'run', fp: 'arena.spawn' },               // composability pipeline
    'README#8': { class: 'signature', fp: 'BitMapper' },           // consumer-side tier naming
    'README#9': { class: 'signature', fp: 'Measured on node' },    // zero-GC gate stamp text
    'README#10': { class: 'bash', fp: 'bench.js' },                // running the benches
    'README#11': { class: 'bash', fp: 'demo.html' },               // visual smoke
    'llms#0': { class: 'signature', fp: 'createScheduler' },       // Member 1 surface (ts)
    'llms#1': { class: 'signature', fp: 'FastBitScheduler' },      // Member 2 surface (ts)
};

// --- extraction -------------------------------------------------------------

function extractBlocks(text, source) {
    const re = /^```([a-zA-Z0-9]*)\n([\s\S]*?)^```/gm;
    const out = [];
    let m, i = 0;
    while ((m = re.exec(text)) !== null) {
        out.push({ id: source + '#' + i, source, index: i, lang: m[1] || 'none', code: m[2] });
        i++;
    }
    return out;
}

// --- runners ----------------------------------------------------------------

function runNode(code) {
    // Execute FROM the repo root so package self-reference + node_modules
    // resolve. The block is piped via stdin -- nothing is written to disk.
    return spawnSync(process.execPath, ['--input-type=module'], {
        cwd: ROOT,
        input: code,
        timeout: 20000,
        encoding: 'utf8',
    });
}

function nodeCheck(code) {
    // Syntax-only check, also via stdin -- no temp file, no os.tmpdir.
    return spawnSync(process.execPath, ['--check', '--input-type=module'], {
        input: code,
        encoding: 'utf8',
    });
}

// --- prerequisite: lite-arena present, package.json/lock untouched ----------

function ensureArena() {
    spawnSync('npm', ['install', '--no-save', '@zakkster/lite-arena'], { cwd: ROOT, encoding: 'utf8' });
    const st = spawnSync('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], {
        cwd: ROOT, encoding: 'utf8',
    });
    if (st.stdout.trim() !== '') {
        console.error('FAIL: lite-arena install mutated package.json/lockfile:\n' + st.stdout);
        process.exit(1);
    }
}

// --- main -------------------------------------------------------------------

ensureArena();

const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const LLMS = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
const blocks = [...extractBlocks(README, 'README'), ...extractBlocks(LLMS, 'llms')];

const tally = { run: 0, signature: 0, browser: 0, bash: 0, mermaid: 0 };
let failures = 0;

for (const b of blocks) {
    const entry = ALLOW[b.id];
    if (!entry) {
        console.error('UNCLASSIFIED ' + b.id + ' [' + b.lang + '] -- add it to the allowlist (fail closed)');
        failures++;
        continue;
    }
    if (!b.code.includes(entry.fp)) {
        console.error('FINGERPRINT MISMATCH ' + b.id + ' expected to contain ' + JSON.stringify(entry.fp));
        failures++;
        continue;
    }
    tally[entry.class]++;
    if (entry.class === 'run') {
        const r = runNode(b.code);
        if (r.status !== 0) {
            console.error('RUN FAIL ' + b.id + ' exit=' + r.status +
                (r.signal ? ' signal=' + r.signal : '') + '\n' +
                (r.stderr || '').trim().split('\n').slice(-6).join('\n'));
            failures++;
        } else {
            console.log('PASS run       ' + b.id);
        }
    } else if (entry.class === 'browser') {
        if (b.lang === 'js' || b.lang === 'mjs') {
            const c = nodeCheck(b.code);
            if (c.status !== 0) {
                console.error('CHECK FAIL ' + b.id + '\n' + (c.stderr || '').trim());
                failures++;
            } else {
                console.log('PASS browser   ' + b.id + ' (node --check)');
            }
        } else {
            console.log('PASS browser   ' + b.id + ' (balanced fences)');
        }
    } else {
        console.log('PASS ' + entry.class.padEnd(9) + b.id);
    }
}

console.log('\n-- tally --');
for (const k of Object.keys(tally)) console.log('  ' + k.padEnd(10) + tally[k]);
console.log('  ' + 'blocks'.padEnd(10) + blocks.length);

if (failures > 0) {
    console.error('\npaste-run: ' + failures + ' failure(s)');
    process.exit(1);
}
console.log('\npaste-run: all blocks green');
