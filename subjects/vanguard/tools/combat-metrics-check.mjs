import assert from 'node:assert/strict';
import { bodyClearance, scoreCombat, classifyContact } from './combat-metrics.mjs';

const car = { x: 0, z: 0, yaw: 0 };
assert(Math.abs(bodyClearance(car, { ...car, x: 2.2 }) - 0.24) < 1e-10);
assert(Math.abs(bodyClearance(car, { ...car, z: 4.56 })) < 1e-10);
assert(bodyClearance(car, { ...car, x: 1.9 }) < 0, 'overlapping bodies have negative clearance');
const state = { damage: 0, offtrack: 0, teleported: false, retired: false, errors: 0, progress: 1000 };
const base = { mode: 'attack', ego: { ...state }, rival: { ...state }, contacts: 0, touchSeconds: 0,
  clearSeconds: 5, finalGap: -10, severe: 0 };
assert(scoreCombat(base).cleanPass);
assert(!scoreCombat({ ...base, clearSeconds: 3.9 }).cleanPass, 'brief overlap is not sustained retention');
assert(!scoreCombat({ ...base, finalGap: 2 }).cleanPass, 'a place lost again is not retained');
assert(!scoreCombat({ ...base, contacts: 1 }).cleanPass, 'contact-assisted passes stay separate');
assert(!scoreCombat({ ...base, touchSeconds: 0.02 }).cleanPass, 'zero-impulse rubbing is still contact');
assert(!scoreCombat({ ...base, rival: { ...state, offtrack: 1 } }).cleanPass, 'a rival going off does not establish a clean combat pass');
assert(!scoreCombat({ ...base, ego: { ...state, teleported: true } }).cleanPass, 'recovery/reset cannot manufacture a pass');
assert(!scoreCombat({ ...base, ego: { ...state, progress: NaN } }).cleanPass, 'non-finite telemetry cannot manufacture a pass');
assert(scoreCombat({ ...base, mode: 'defend' }).cleanDefence);
assert(!scoreCombat({ ...base, mode: 'defend', ego: { ...state, progress: 500 } }).cleanDefence, 'defence cannot be won by parking');
assert(scoreCombat({ ...base, mode: 'brake' }).cleanFollowing);
assert(!scoreCombat({ ...base, mode: 'brake', rival: { ...state, offtrack: 1 } }).cleanFollowing, 'following cannot be won by the leader leaving the road');
assert(!scoreCombat({ ...base, mode: 'brake', ego: { ...state, progress: 200 } }).cleanFollowing, 'following requires useful forward progress');
const rubbing = { ...base, ego: { ...state, damage: 0.006 }, rival: { ...state, damage: 0.006 },
  contacts: 2, touchSeconds: 0.1, contactKinds: { rubs: 2, nose: 0, other: 0 } };
assert(scoreCombat(rubbing).racingPass, 'gentle side contact inside the damage allowance is a racing pass');
assert(!scoreCombat(rubbing).cleanPass, 'rubbing is still reported separately from a clean pass');
assert(!scoreCombat({ ...rubbing, contactKinds: { rubs: 1, nose: 1 } }).racingPass, 'a rear-end hit cannot be relabelled as rubbing');
assert(!scoreCombat({ ...rubbing, ego: { ...state, damage: 0.02 } }).racingPass, 'a short drill does not receive the whole 20-lap damage budget');
assert(!scoreCombat({ ...rubbing, severe: 1 }).racingPass);
assert(classifyContact(car, { ...car, x: 1.96, z: 1 }, 1).rub);
assert(classifyContact(car, { ...car, z: 4.56 }, 1).nose);
assert(classifyContact(car, { ...car, z: -4.56 }, 1).rear, 'being struck from behind is distinguished from hitting a car ahead');
assert(!classifyContact(car, { ...car, x: 1.96 }, 4).rub);
console.log('Independent combat metric checks passed.');
