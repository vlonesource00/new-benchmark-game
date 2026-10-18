import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { WaterField } from '../../../game/engine/sim/water.js';
import { HeldPredictor } from '../src/predict.js';
import { Course } from '../src/course.js';
import { settingsFor } from '../src/settings.js';

for (const wet of [false, true]) {
  const track = new Track('harbor-ring'), car = new Vehicle(0, 'prediction', '#fff', 'lmdh');
  car.place(track, 200, 1, 55);
  car.gear = 4; car.controls = { steer: 0.04, throttle: 0.5, brake: 0 };
  if (wet) {
    track.water = new WaterField(track); track.water.live = true;
    track.water.depth.fill(1.2); track.wetness = track.water.meanWet();
  }
  const before = structuredClone(car), rubber = track.rubber.slice(), water = track.water?.depth.slice();
  const reference = Object.assign(new Vehicle(), structuredClone(car));
  const sandbox = Object.create(track); sandbox.rubber = track.rubber.slice();
  if (wet) { sandbox.water = Object.create(track.water); sandbox.water.depth = track.water.depth.slice(); }
  for (let i = 0; i < 6; i++) reference.step(1 / 120, sandbox, car.aero.wake);
  const predictor = new HeldPredictor(track), predicted = predictor.predict(car, 0.05);
  for (const k of ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate', 'fuel']) assert.equal(predicted[k], reference[k], `${wet ? 'wet' : 'dry'} exact plant ${k}`);
  assert.deepEqual(car, Object.assign(new Vehicle(), before), 'forecast does not mutate the source car');
  assert.deepEqual(track.rubber, rubber, 'forecast does not deposit live rubber');
  if (wet) assert.deepEqual(track.water.depth, water, 'forecast does not clear live water');
  car.hybridForce = 1200; predictor.predict(car, 0.01); delete car.hybridForce;
  assert.equal(predictor.predict(car, 0).hybridForce, undefined, 'reset removes obsolete optional forces');
}
{
  const track = new Track('harbor-ring'), car = new Vehicle(0, 'join', '#fff', 'gt');
  car.place(track, 250, 0, 50);
  const course = new Course(track, settingsFor(track.id)); course.prepare(car);
  course.setDelay(car, 1e-10, 1 / 120, course.line);
  const anchor = course.arrivalPose(car);
  assert(Math.hypot(anchor.x - car.x, anchor.z - car.z) < 1e-6, 'zero-delay limit preserves live tracking error');
  course.setDelay(car, 0.05, 1 / 120);
  const future = course.arrivalPose(car);
  assert(Math.hypot(future.x - car.x, future.z - car.z) > 2, 'arrival anchor advances under measured delay');
}
console.log('VANGUARD held-control prediction checks passed.');
