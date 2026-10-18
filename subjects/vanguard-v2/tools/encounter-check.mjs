import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function run(args) {
  const out = execFileSync(process.execPath, ['--import', './scripts/json-loader.mjs', 'subjects/vanguard/tools/encounter.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000
  });
  return JSON.parse(out.trim().split('\n').at(-1));
}
function clean(s) {
  assert.equal(s.contacts, 0, 'zero contacts');
  assert.equal(s.severe, 0, 'zero severe contacts');
  assert.equal(s.damage, 0, 'zero own damage');
  assert.equal(s.otherDamage, 0, 'zero rival damage');
  assert.equal(s.incidents, 0, 'zero incidents');
  assert.deepEqual(s.errors, [0], 'zero bridge errors');
}

for (const [name, extra] of [['new-pass', []], ['new-pass-lag', ['--lagFrames', '1']]]) {
  const r = run(['--path', 'worker', '--cls', 'lmdh', '--rival', 'razor', '--s', '250', '--gap', '20', '--v', '60', '--rv', '50', '--time', '30', ...extra]);
  clean(r);
  assert.equal(r.stats.retained, 1);
  assert.equal(r.stats.maneuvers, 1);
  assert.equal(r.stats.contactAssisted, 0);
  assert.ok(r.finalGap < -10);
  assert.ok(r.stats.started > 0 && r.stats.overlap > 0);
  console.log(`ok ${name}: real worker maneuver clears RAZOR, retains the pass and remains clean through the following corner`);
}

const follow = run(['--path', 'worker', '--cls', 'lmdh', '--rival', 'razor', '--s', '250', '--gap', '20', '--v', '60', '--rv', '50', '--time', '30', '--follow']);
clean(follow);
assert.equal(follow.stats.retained, 0);
assert.equal(follow.stats.declared, 0);
assert.ok(follow.finalGap > 0);
console.log('ok follow: matched following-only control stays behind; the passing result requires the move');

const traffic = run(['--path', 'worker', '--cls', 'lmdh', '--rival', 'razor', '--rivalClass', 'gt', '--s', '250', '--gap', '65', '--v', '62', '--rv', '43', '--time', '14']);
clean(traffic);
assert.equal(traffic.stats.retained, 1);
assert.equal(traffic.stats.traffic, 1);
console.log('ok slower-class traffic: LMDh cleanly passes and retains against GT3 traffic');

const stopped = run(['--path', 'worker', '--cls', 'lmdh', '--rival', 'razor', '--s', '250', '--gap', '85', '--v', '58', '--rv', '0', '--hazard', 'stopped', '--time', '10']);
clean(stopped);
assert.equal(stopped.stats.declared, 0);
assert.equal(stopped.stats.retained, 0);
assert.ok(stopped.finalGap < -40);
console.log('ok stopped hazard: evaded cleanly with zero overtake declaration');

const spun = run(['--path', 'worker', '--cls', 'lmdh', '--rival', 'razor', '--s', '250', '--gap', '85', '--v', '58', '--rv', '0', '--hazard', 'spun', '--time', '10']);
clean(spun);
assert.equal(spun.stats.declared, 0);
assert.equal(spun.stats.retained, 0);
assert.ok(spun.finalGap < -40);
console.log('ok spun hazard: evaded cleanly with zero overtake declaration');

console.log('All VANGUARD encounter checks passed.');
