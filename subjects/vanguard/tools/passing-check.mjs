// Matched real-race regression: conversion from following into a retained
// same-class pass, rather than just starting ahead or declaring an attack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = fileURLToPath(new URL('../../../', import.meta.url));
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
function run(scene, options, solo = false) {
  const data = { driver: solo ? scene.rival : 'vanguard', scene, seed: 7, options, trace: false, solo };
  const r = spawnSync(process.execPath, ['--import', './scripts/json-loader.mjs',
    'subjects/vanguard/tools/combat-bench.mjs', '--run', JSON.stringify(data)], {
    cwd: root, encoding: 'utf8', timeout: 90000
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const scene = { id: 'solenne-momentum', track: 'solenne', s: 2300,
  kind: 'momentum', rival: 'intercept', duration: 40 };
assert(run(scene, {}, true).score.unassisted, 'the matched rival alone must remain healthy');
const control = run(scene, { adaptiveAttacks: false }), candidate = run(scene, {});
assert(control.score.clean, 'the unsuccessful control must still be a healthy clean encounter');
assert(!control.score.racingPass, 'the control reproduces the lost passing opportunity');
assert(candidate.score.racingPass, 'adaptive attacks retain the pass for four seconds fully ahead');
assert(candidate.ego.damage <= 0.01 && candidate.rival.damage <= 0.01);
assert.equal(candidate.ego.offtrack, 0);
assert.equal(candidate.rival.offtrack, 0);
assert.equal(candidate.contactKinds.rubs, candidate.contacts, 'only gentle side rubbing is accepted');
assert.equal(candidate.contactKinds.nose, 0);
assert.equal(candidate.severe, 0);
assert.equal(candidate.ego.errors, 0);
for (const [track, s, rival] of [['harbor-ring', 250, 'intercept'], ['solenne', 2300, 'razor']]) {
  const braking = run({ id: track + '-brake', track, s,
    kind: 'brake', rival, duration: 40 }, {});
  assert(braking.score.racingFollowing, `${track}: the stronger attack must not break following a braking leader`);
}
const closeStart = { id: 'harbor-close-start', track: 'harbor-ring', s: 250,
  kind: 'equal', rival: 'intercept', attackGap: 6, duration: 40 };
const sliding = run(closeStart, { trackingRecovery: false }), recovered = run(closeStart, {});
assert(sliding.ego.damage > 0.05 && sliding.ego.offtrack > 1,
  'the control reproduces the close-start slide and barrier damage');
assert.equal(recovered.contacts, 0, 'recovery must not depend on a collision to turn the car');
assert.equal(recovered.ego.damage, 0);
assert.equal(recovered.ego.offtrack, 0);
assert(!recovered.ego.retired && !recovered.ego.teleported && !recovered.ego.errors);
assert(recovered.ego.progress > sliding.ego.progress && recovered.score.progressRatio > 0.97,
  'recovery must keep driving rather than merely stop before the wall');
console.log('VANGUARD retained-pass, braking and close-start recovery regressions passed.');
