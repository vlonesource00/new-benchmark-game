import assert from 'node:assert/strict';
import { bodyClearance, scoreCombat } from './combat-metrics.mjs';

const car = { x: 0, z: 0, yaw: 0 };
assert(Math.abs(bodyClearance(car, { ...car, x: 2.2 }) - 0.24) < 1e-10);
assert(Math.abs(bodyClearance(car, { ...car, z: 4.56 })) < 1e-10);
assert(bodyClearance(car, { ...car, x: 1.9 }) < 0, 'overlapping bodies have negative clearance');
const state = { damage: 0, offtrack: 0, teleported: false, retired: false, errors: 0, progress: 1000 };
const base = { mode: 'attack', ego: { ...state }, rival: { ...state }, contacts: 0, touchSeconds: 0,
  clearSeconds: 5, finalGap: -10 };
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
console.log('Independent combat metric checks passed.');
