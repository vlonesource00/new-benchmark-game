import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Course } from '../src/course.js';
import { Observer } from '../src/observer.js';
import { RivalMotion } from '../src/motion.js';
import { evaluate } from '../src/battle.js';
import { settingsFor } from '../src/settings.js';
import { noseConstraint } from '../src/controller.js';

const track = new Track('harbor-ring'), car = new Vehicle(1, 'ego', '#fff', 'gt');
car.place(track, 1300, 0, 40); car.gear = 6;
const settings = settingsFor(track.id), course = new Course(track, { ...settings, ...settings.perClass.gt, combatHorizon: 5.5 });
course.prepare(car);
const gears = [], original = course.model.gearAt;
course.model.gearAt = (_v, gear) => { gears.push(gear); return 2; };
evaluate(course.line, car, course, { me: { s: car.s }, list: [] }, null, 0.5);
course.model.gearAt = original;
assert(gears.length >= 4, 'the test spans multiple rollout steps');
assert.equal(gears[0], 6);
assert(gears.slice(1).every(g => g === 2), 'a simulated shift persists into the next simulated step');
assert.equal(car.gear, 6, 'planning does not change the real gearbox');

const rival = new Vehicle(0, 'rival', '#f60', 'gt');
rival.place(track, 1320, 0, 40);
const observer = new Observer(track); observer.reference = course.line;
observer.motion = new RivalMotion(course, observer);
observer.update(car, [car, rival], {}, 10);
const r = observer.list[0], a = observer.at(r, 3.4), b = observer.at(r, 5.4);
assert(b.valid, 'rival prediction covers the configured tactical horizon');
assert(b.s > a.s + 20, 'a moving rival cannot freeze at the old 3.5-second horizon');
// A car can still follow the route in course coordinates while being a
// sideways/off-road hazard in road coordinates. The inertial fallback must
// not dispatch straight back into RivalMotion.
r.hazard = true; r.moving = true; r.psi = 0.60;
const hazard = observer.at(r, 1), inertial = observer.inertialAt(r, 1);
assert.deepEqual(hazard, inertial, 'moving hazards use the inertial fallback without recursion');
assert(Object.values(hazard).every(v => typeof v !== 'number' || Number.isFinite(v)));
rival.race = { boxThisLap: true };
rival.controls.brake = 0.8;
observer.update(car, [car, rival], {}, 11);
const boxing = observer.list[0];
assert(boxing.approaching && boxing.physical && !boxing.eligible);
assert(!boxing.hazard, 'a normal moving pit approach does not trigger a sudden evasive manoeuvre');
assert(Number.isFinite(noseConstraint(car, observer, course.model).cap),
  'a braking car approaching the pits still activates nose protection');
rival.place(track, 1320, track.halfWidth + 1, 12);
rival.vx -= Math.cos(rival.yaw) * 2;
rival.vz += Math.sin(rival.yaw) * 2;
observer.update(car, [car, rival], {}, 12);
assert(observer.list[0].hazard, 'a boxing car rejoining from off track remains a hazard');
rival.place(track, 1320, 0, 0);
observer.update(car, [car, rival], {}, 13);
assert(observer.list[0].hazard, 'a stopped boxing car remains a hazard');
console.log('VANGUARD tactical rollout checks passed.');
