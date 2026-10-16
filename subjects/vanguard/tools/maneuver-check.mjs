import assert from 'node:assert/strict';
import { switchbackPlan } from '../src/battle.js';

const options = { separation: 2.65, steerJerk: 65 };
const road = { ks: 'curvature', vbrk: 'speed', closest: () => ({ i: 0, f: 0 }),
  sample: (kind, i, f, ahead) => kind === 'curvature' ? (ahead > 90 && ahead < 150 ? 0.014 : 0) : 30 };
const car = { x: 0, z: 0, speed: 55 }, rival = { hazard: false, eligible: true, kind: 'race', ds: 18, offset: 1.2 };
const p = switchbackPlan(road, car, rival, options);
assert(p && p.side === -1 && p.inside === 1, 'defended right-hand apex offers an outside-to-inside switchback');
assert(p.switchStart > 90 && p.hold > p.switchLength, 'the crossover follows the apex and has a retained exit lane');
assert(120 * options.separation * 36 ** 3 / p.switchLength ** 3 <= options.steerJerk, 'crossover respects lateral jerk at the planned exit speed');
assert.equal(switchbackPlan(road, car, { ...rival, offset: -1.2 }, options), null, 'an undefended apex does not trigger the switchback');
assert.equal(switchbackPlan(road, car, { ...rival, hazard: true }, options), null, 'hazard evasion is not scored as a combat manoeuvre');
assert.equal(switchbackPlan(road, { ...car, speed: 32 }, rival, options), null, 'no artificial braking-zone move at steady corner speed');
console.log('VANGUARD switchback geometry checks passed.');
