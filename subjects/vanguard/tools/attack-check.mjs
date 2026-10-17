import assert from 'node:assert/strict';
import { selectCandidate, ownsRacingLane } from '../src/battle.js';
import { noseConstraint } from '../src/controller.js';

const clean = { fits: true, risk: 0, score: 105, exit: 52, finalGap: 8 };
const risky = { ...clean, risk: 2, score: 120 };
let chosen = selectCandidate(null, risky, 0.8);
chosen = selectCandidate(chosen, clean, 0.8);
assert.equal(chosen, clean, 'an unsafe high-score lane cannot mask an admissible passing lane');
assert.equal(selectCandidate(clean, risky, 0.8), clean, 'candidate order does not bypass the collision budget');
assert.equal(selectCandidate(null, { ...clean, fits: false }, 0.8), null, 'road width still constrains commitment');
assert.equal(selectCandidate(null, { ...clean, hardImpact: true }, 20), null, 'a permissive current-route risk cannot authorise a predicted heavy impact');

const better = { ...clean, score: 108 };
assert.equal(selectCandidate(clean, better, 0.8), better, 'admissible alternatives still compete on progress and exit speed');
assert.equal(selectCandidate(better, clean, 0.8), better, 'the safer ranking preserves the best admissible lane');
assert.equal(selectCandidate(null, { ...clean, risk: 0.8 }, 0.8), null, 'the original strict collision limit is preserved');
const ego = { x: 0, z: 0, yaw: 0 }, rival = {
  eligible: true, hazard: false, car: { x: 2.1, z: 2, yaw: 0 }
};
assert(ownsRacingLane(ego, rival, -1), 'a parallel car partly ahead does not erase our established lane');
assert(!ownsRacingLane(ego, rival, 1), 'ownership cannot switch us across the rival');
assert(!ownsRacingLane(ego, { ...rival, car: { ...rival.car, z: 8 } }, -1), 'following is not alongside ownership');
assert(!ownsRacingLane(ego, { ...rival, car: { ...rival.car, x: 1.2 } }, -1), 'deep lateral overlap is not a valid owned lane');
assert(!ownsRacingLane(ego, { ...rival, car: { ...rival.car, yaw: 0.3 } }, -1), 'a crossing car retains its hazard clearance');
assert(!ownsRacingLane(ego, { ...rival, car: { ...rival.car, vx: -4 } }, -1), 'parallel headings do not make a fast lateral squeeze gentle');
assert(!ownsRacingLane(ego, { ...rival, eligible: false }, -1));
assert(!ownsRacingLane(ego, { ...rival, hazard: true }, -1));
assert(ownsRacingLane({ ...ego, yaw: Math.PI }, { ...rival,
  car: { x: -2.1, z: -2, yaw: -Math.PI } }, -1), 'body-space ownership is invariant to the heading wrap');
const follower = { x: 0, z: 0, yaw: 0, speed: 45, vx: 0, vz: 45 }, merging = {
  id: 2, physical: true, eligible: true, hazard: false, pit: false, kind: 'race',
  ds: 12, v: 35, ax: 0, along: 2.28,
  car: { x: 3.5, z: 12, yaw: 0, vx: 0, vz: 35, controls: { brake: 0 } }
};
const path = { N: 2, ds: 100, len: [100, 100], px: [0, 0], pz: [0, 100],
  idx: i => Math.max(0, Math.min(1, i)), heading: () => 0,
  sample: (a, i, f) => a[i] + ((a[i + 1] ?? a[i]) - a[i]) * f },
  observer = { list: [merging], at: (_r, t) => ({ x: 0, z: 12 + 35 * t, h: 0, v: 35 }) },
  model = { brake: () => 12 }, cursor = { i: 0, f: 0 };
const blocked = noseConstraint(follower, observer, model, { path, cursor, adaptiveAttacks: true });
assert(blocked.cap < 45 && blocked.details.predictedBlock,
  'a slower same-class car merging onto our route receives the same protection as a backmarker');
observer.at = (_r, t) => ({ x: 3.5, z: 12 + 35 * t, h: 0, v: 35 });
assert.equal(noseConstraint(follower, observer, model, { path, cursor, adaptiveAttacks: true }).cap, Infinity,
  'a slower car remaining in a clear adjacent lane does not cause braking');
merging.car.vx = -4;
assert(noseConstraint(follower, observer, model, { path, cursor, adaptiveAttacks: true }).cap < 45,
  'a fast physical lateral merge is protected even if the road forecast misses it');
merging.car.vx = 0;
merging.ds = 3; merging.car.z = 3;
observer.at = (_r, t) => ({ x: 0, z: 3 + 35 * t, h: 0, v: 35 });
assert(noseConstraint(follower, observer, model, { path, cursor, adaptiveAttacks: true }).cap < 45,
  'crossing protection stays active inside a car length instead of disappearing at 5 m');
console.log('VANGUARD attack commitment checks passed.');
