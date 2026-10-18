import assert from 'node:assert/strict';
import { Track } from '../../../game/engine/sim/track.js';
import { WaterField } from '../../../game/engine/sim/water.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Course } from '../src/course.js';
import { settingsFor } from '../src/settings.js';
import { surfaceProfile, wetLineGen } from '../src/surface.js';

const track = new Track('harbor-ring'), car = new Vehicle(0, 'surface', '#fff', 'gt');
car.place(track, 200, 0, 45);
for (const w of car.wheels) Object.assign(w.tyre, { aqV: 72, wetHold: 0.74 });
const course = new Course(track, { ...settingsFor(track.id), reducedGripBrakeExp: 1.4 });
course.prepare(car);
assert.equal(course.brakeExponent(car), course.options.brakeExp, 'fresh dry tyres keep the existing braking model');
assert(course.line.surfaceCaps.every(v => v === Infinity), 'dry surface adds no speed ceiling');
const drySpeeds = course.line.vbrk.slice();
track.water = new WaterField(track);
track.water.live = true;
track.water.depth.fill(4);
track.wetness = track.water.meanWet();
course.refresh(car, true);
assert.equal(course.brakeExponent(car), 1.4, 'wet conditions reserve more combined lateral/braking force');
const freshCap = course.line.surfaceCaps[0];
assert(freshCap > 35 && freshCap < 37, '4 mm on fresh wets uses the game aquaplaning onset');
assert(course.line.vmax.every(v => v <= freshCap + 1e-10), 'water ceiling precedes the speed-envelope solver');
assert(course.line.vbrk.some((v, i) => v < drySpeeds[i] - 10), 'braking envelope anticipates the puddle');
for (const w of car.wheels) w.tyre.wear = 0.6;
assert.equal(course.brakeExponent(car), 1.4, 'heavily worn tyres use the same conservative combined-force forecast');
surfaceProfile(course.line, track, car);
assert(course.line.surfaceCaps[0] < freshCap - 5, 'worn tread lowers the safe puddle speed');
track.water.depth.fill(0);
track.wetness = 0;
for (const w of car.wheels) w.tyre.wear = 0;
course.refresh(car, true);
assert.equal(course.brakeExponent(car), course.options.brakeExp, 'fresh dry conditions restore the nominal forecast');
assert(course.line.surfaceCaps.every(v => v === Infinity), 'drying removes obsolete puddle ceilings');
assert(course.line.trim.every(v => v === 1), 'drying restores the dry surface multiplier');

// Sliced wet-line work must not leak half-built geometry to the active driver.
track.water.depth.fill(4);
track.wetness = track.water.meanWet();
course.cleanAir = true;
course.refresh(car, true);
const live = course.line, before = live.px.slice(), shadow = Object.create(live);
for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'st', 'surfaceNodes', 'wetOffsets']) {
  shadow[key] = live[key].slice();
}
// A previous offset must return gradually when the track dries, preserving
// the normals of the baked line even around a centreline kink.
shadow.wetOffsets.fill(0.6);
track.water.depth.fill(0); track.wetness = 0;
const gen = wetLineGen(shadow, track, car, course.model, 1);
let state = gen.next(), slices = 0;
while (!state.done) {
  assert.deepEqual(live.px, before, 'active line remains unchanged between slices');
  slices++; state = gen.next();
}
assert(slices > 0, 'geometry calculation yields work to the planner');
assert(shadow.wetOffsets.every(v => Math.abs(v - 0.35) < 1e-10), 'drying obeys the 0.25 m/s morph limit');
assert(shadow.h.every(Number.isFinite) && shadow.ks.every(Number.isFinite), 'staged geometry is finite');
for (let i = 0; i < shadow.N; i += 101) {
  const road = track.nearest(shadow.px[i], shadow.pz[i]);
  assert(Math.abs(road.lateral - shadow.lat[i]) < 1e-9, 'surface offset matches actual road projection');
  assert.equal(road.index, shadow.surfaceNodes[i], 'surface sample follows the staged geometry');
}
assert.deepEqual(live.px, before, 'completed staging still requires an explicit swap');
console.log('VANGUARD surface checks passed.');
