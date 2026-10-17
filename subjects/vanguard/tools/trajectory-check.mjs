import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { WaterField } from '../../../game/engine/sim/water.js';
import { Course } from '../src/course.js';
import { Controller, controlMemory, noseConstraint } from '../src/controller.js';
import { Observer } from '../src/observer.js';
import { Racecraft } from '../src/racecraft.js';
import { settingsFor } from '../src/settings.js';
import { TrajectoryRollout, tacticalHorizon } from '../src/trajectory.js';
import { evaluate, selectCandidate } from '../src/battle.js';

for (const wet of [false, true]) {
  const track = new Track('harbor-ring'), car = new Vehicle(1, 'preview', '#fff', 'gt');
  car.place(track, 250, 0, 40); car.gear = 4;
  if (wet) {
    track.water = new WaterField(track); track.water.live = true;
    track.water.depth.fill(1.2); track.wetness = track.water.meanWet();
  }
  const settings = settingsFor(track.id), course = new Course(track, { ...settings, ...settings.perClass.gt });
  course.prepare(car);
  course.controller = new Controller(course.options);
  course.controlMemory = { kc: -0.0003, acceleration: 1.7, sideYield: null };
  course.racecraft = new Racecraft(course.options); course.racecraft.observe(car, { time: 0, totalLaps: 20 });
  const source = new Observer(track); source.reference = course.line; source.update(car, [car], {}, 0);
  const before = structuredClone(car), rubber = track.rubber.slice(), water = track.water?.depth.slice(),
    budget = structuredClone(course.racecraft.trace);
  const rollout = new TrajectoryRollout(course), result = rollout.evaluate(course.line, car, source, null, 0.25),
    preview = structuredClone(rollout.plant.car);
  const reference = Object.assign(new Vehicle(), structuredClone(car)), surface = Object.create(track), control = new Controller(course.options);
  surface.rubber = track.rubber.slice();
  if (wet) { surface.water = Object.create(track.water); surface.water.depth = track.water.depth.slice(); surface.water.track = surface; }
  Object.assign(control, course.controlMemory);
  for (let i = 0; i < 30; i++) {
    const q = track.nearest(reference.x, reference.z);
    control.step(reference, course.line, course, { list: [], me: { s: q.s, d: q.lateral, h: track.at(q.s).heading } }, 1 / 120, { time: i / 120 });
    reference.step(1 / 120, surface, 0);
  }
  for (const key of ['x', 'z', 'vx', 'vz', 'yaw', 'yawRate', 'fuel', 'steering'])
    assert(Math.abs(preview[key] - reference[key]) < 1e-10, `${wet ? 'wet' : 'dry'}: closed-loop plant matches actual steps for ${key}`);
  assert.deepEqual(car, Object.assign(new Vehicle(), before), 'preview leaves the live vehicle untouched');
  assert.deepEqual(track.rubber, rubber, 'preview leaves live rubber untouched');
  if (wet) assert.deepEqual(track.water.depth, water, 'preview leaves live water untouched');
  assert.deepEqual(course.racecraft.trace, budget, 'preview cannot spend the live damage budget');
  assert(Number.isNaN(course.controller.kc), 'preview cannot overwrite the live controller memory');
  assert(Number.isFinite(result.score));
  assert(tacticalHorizon(course.line, car) >= 4.5 && tacticalHorizon(course.line, car) <= 6.5);
  rollout.evaluate(course.line, car, source, null, 0.1);
  rollout.evaluate(course.line, car, source, null, 0.25);
  assert.deepEqual(structuredClone(rollout.plant.car), preview, 'A/B/A previews have no state leakage');
  assert(controlMemory(reference)); control.reset();
  assert.equal(controlMemory(reference), null, 'a reset cannot transmit stale controller state');
  const invalid = rollout.evaluate(course.line, car, { ...source, me: { s: NaN } }, null, 0.1);
  assert.equal(invalid.trackable, false, 'non-finite forecasts are inadmissible');
  assert.equal(selectCandidate(null, { ...invalid, fits: true }, 100), null,
    'non-finite progress cannot become the winning corridor');
}

{
  const track = new Track('harbor-ring'), car = new Vehicle(1, 'recovery', '#fff', 'gt');
  const settings = settingsFor(track.id), course = new Course(track, { ...settings, ...settings.perClass.gt });
  car.place(track, 250, 0, 45); course.prepare(car);
  const c = course.line.closest(car.x, car.z), h = course.line.heading(c.i, c.f),
    x = course.line.sample(course.line.px, c.i, c.f) + Math.cos(h) * 6,
    z = course.line.sample(course.line.pz, c.i, c.f) - Math.sin(h) * 6;
  const controller = new Controller(course.options), source = new Observer(track);
  const drive = speed => {
    Object.assign(car, { x, z, yaw: h, vx: Math.sin(h) * speed, vz: Math.cos(h) * speed, speed, yawRate: 0 });
    source.reference = course.line; source.update(car, [car], {}, 0);
    controller.reset(); controller.step(car, course.line, course, source, 1 / 120);
  };
  drive(45);
  assert.equal(controller.trace.source, 'tracking-recovery', 'large tracking error reduces speed before a barrier hit');
  assert.equal(car.controls.throttle, 0);
  drive(5);
  assert.notEqual(controller.trace.source, 'tracking-recovery', 'low-speed recovery must not hold the car stopped off line');
  assert(car.controls.throttle > 0, 'the low-speed car can drive back to its line');
}

const follower = { x: 0, z: 0, yaw: 0, vx: 0, vz: 45, speed: 45 },
  leader = { physical: true, pit: false, eligible: true, hazard: false, v: 45, ax: 0,
    car: { x: 0, z: 6, yaw: 0, vx: 0, vz: 45, controls: { brake: 0 } } }, model = { brake: () => 20 };
assert(noseConstraint(follower, { list: [leader] }, model, { brakingHeadway: 0.12 }).cap < 45,
  'zero closing speed does not make a bumper gap safe');
leader.car.z = 25; leader.v = leader.car.vz = 43;
assert(noseConstraint(follower, { list: [leader] }, model, { brakingHeadway: 0.12 }).cap > 45,
  'the braking reserve must still allow closing from a comfortable gap');
leader.car.x = 3; leader.car.z = 6;
assert.equal(noseConstraint(follower, { list: [leader] }, model, { brakingHeadway: 0.12 }).cap, Infinity,
  'a clear adjacent lane does not receive a following penalty');

{
  const track = new Track('harbor-ring'), car = new Vehicle(1, 'scoring', '#fff', 'gt');
  car.place(track, 250, 0, 40); car.gear = 4;
  const settings = settingsFor(track.id), course = new Course(track, { ...settings, ...settings.perClass.gt, physicalRollouts: false });
  course.prepare(car);
  const target = { id: 2, physical: true, pit: false, ds: -10, along: 2.28, across: 0.98 };
  const observer = { me: { s: car.s }, list: [target], at: (_r, time) => ({
    s: car.s + 40 * time + (time < 1 ? -10 : 30), d: 12, v: 40, h: 0, x: 10000, z: 10000, vx: 0, vz: 40
  }) };
  const result = evaluate(course.line, car, course, observer, target);
  assert(result.everCleared, 'the fixture includes an early crossing of the target');
  assert(!result.retained && result.finalGap > 0, 'a transient pass is not a retained terminal advantage');
}
console.log('VANGUARD trajectory, memory, retention and following-reserve checks passed.');
