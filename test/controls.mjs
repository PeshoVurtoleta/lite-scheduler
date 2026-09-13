/**
 * @zakkster/lite-scheduler -- standalone control driver (the must-fail proof).
 *
 * Every gate must be provably able to fail. This entry drives the torture entry
 * out-of-process and asserts each invariant of the entry contract:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints exactly "ok" and
 *     exits 0;
 *   - the BREAK run (`LSCHED_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     injects a retained allocation into the t6 hot loop, so the alloc gate
 *     rejects the window, the run exits NON-zero and never prints "ok";
 *   - a run WITHOUT `--expose-gc` exits 1 with the remedy on stderr (the GC gate
 *     is meaningless without it);
 *   - a run with a peer faked missing (LSCHED_TORTURE_FAKE_MISSING_PEER, a
 *     test-only hook in torture.mjs's preflight -- see its header) exits 2 with
 *     the remedy on stderr (a fresh clone that skipped `npm install`).
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required. The in-process controls (t9) run every invocation, so a plain
 * `npm run torture` already proves those gates bite; this driver adds the
 * out-of-process proofs.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/**
 * Run the torture entry. exposeGc toggles --expose-gc; breakOn sets the control
 * env; fakeMissingPeer, when set, names a peer package for the preflight's
 * test-only hook to treat as unimportable (see torture.mjs's header).
 */
function runWith(exposeGc, breakOn, fakeMissingPeer) {
    const env = Object.assign({}, process.env);
    if (breakOn) env.LSCHED_TORTURE_BREAK = '1';
    else delete env.LSCHED_TORTURE_BREAK;
    if (fakeMissingPeer) env.LSCHED_TORTURE_FAKE_MISSING_PEER = fakeMissingPeer;
    else delete env.LSCHED_TORTURE_FAKE_MISSING_PEER;
    const args = exposeGc ? ['--expose-gc', ENTRY] : [ENTRY];
    const res = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// 1. The clean run must pass. If it does not, the BREAK arm is meaningless.
{
    const r = runWith(true, false);
    if (r.code !== 0) fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
    if (r.stdout.trim() !== 'ok') fail('clean run stdout was ' + JSON.stringify(r.stdout) + ', expected exactly "ok"');
}

// 2. The BREAK run must exit non-zero and must NOT print "ok".
{
    const r = runWith(true, true);
    if (r.code === 0) fail('LSCHED_TORTURE_BREAK=1 still exited 0 -- the t6 gate is decorative');
    if (r.stdout.trim() === 'ok') fail('LSCHED_TORTURE_BREAK=1 printed "ok" on a failing run');
}

// 3. The no---expose-gc run must exit 1 with the remedy on stderr.
{
    const r = runWith(false, false);
    if (r.code !== 1) fail('run without --expose-gc exited ' + r.code + ' (expected 1)');
    if (!/--expose-gc/.test(r.stderr)) fail('run without --expose-gc did not print the --expose-gc remedy on stderr');
    if (r.stdout.trim() === 'ok') fail('run without --expose-gc printed "ok"');
}

// 4. A missing peer must exit 2 with the remedy on stderr (fresh-clone path).
// Faked via the preflight's test-only hook so this control does not require
// actually uninstalling a devDependency.
{
    const r = runWith(true, false, '@zakkster/lite-gc-profiler');
    if (r.code !== 2) fail('missing-peer run exited ' + r.code + ' (expected 2)\n' + r.stderr);
    if (!/missing devDependency @zakkster\/lite-gc-profiler/.test(r.stderr)) {
        fail('missing-peer run did not print the missing-devDependency remedy on stderr: ' + JSON.stringify(r.stderr));
    }
    if (r.stdout.trim() === 'ok') fail('missing-peer run printed "ok"');
}
{
    const r = runWith(true, false, '@zakkster/lite-leak');
    if (r.code !== 2) fail('missing-peer run exited ' + r.code + ' (expected 2)\n' + r.stderr);
    if (!/missing devDependency @zakkster\/lite-leak/.test(r.stderr)) {
        fail('missing-peer run did not print the missing-devDependency remedy on stderr: ' + JSON.stringify(r.stderr));
    }
    if (r.stdout.trim() === 'ok') fail('missing-peer run printed "ok"');
}

process.stdout.write('ok\n');
