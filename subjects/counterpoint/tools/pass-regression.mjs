import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// These exercise real delayed seats and retained passes, not predicted wins.
// The worn-tyre fixture reproduced the early wrong-side setup: the old setup
// gate ended about 10 m behind; the measured-momentum gate completes the pass.
const root = fileURLToPath(new URL('../../../', import.meta.url)), tag = 'counterpoint-pass-regression';
const child = spawn(process.execPath, ['--import', './scripts/json-loader.mjs',
  'subjects/vanguard/tools/combat-bench.mjs', '--drivers', 'counterpoint', '--class', 'gt',
  '--seeds', '101', '--only', 'harbor-worn-traffic,harbor-doors-attack', '--tag', tag],
{ cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
let errors = '';
child.stdout.resume();
child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
const timeout = setTimeout(() => child.kill(), 180000);
const exit = await new Promise(resolve => child.once('close', resolve));
clearTimeout(timeout);
assert.equal(exit, 0, errors || 'combat regression process failed');
const report = JSON.parse(readFileSync(new URL(`../../vanguard/results/${tag}.json`, import.meta.url)));
assert.deepEqual(report.changesDuringRun, [], 'the replay must use one unchanged source state');
assert.equal(report.controls.length, 2);
assert.equal(report.cases.length, 2);
for (const c of report.cases) {
  assert(!c.error, `${c.scene}: seat error`);
  assert(c.clearSeconds >= 4 && c.finalGap < -5.6, `${c.scene}: pass must be completed and retained`);
  for (const who of ['ego', 'rival']) {
    assert.equal(c[who].offtrack, 0, `${c.scene}: ${who} stays legal`);
    assert.equal(c[who].errors, 0, `${c.scene}: ${who} control remains finite`);
    assert(!c[who].retired && !c[who].teleported, `${c.scene}: ${who} stays in the encounter`);
    assert(c[who].damage <= .025, `${c.scene}: ${who} stays inside the per-move allowance`);
  }
  assert.equal(c.severe, 0, `${c.scene}: contact tolerance cannot substitute a severe hit for a pass`);
}
console.log('COUNTERPOINT real-seat pass regressions passed: slower car and door contest.');
