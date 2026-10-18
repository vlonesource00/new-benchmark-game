import assert from 'node:assert/strict';
import { PaceLearning } from '../src/learning.js';

function fixture() {
  const line = { N: 32, ds: 3, idx: i => (i + 32) % 32,
    paceTrim: new Float64Array(32).fill(1), brakeTrim: new Float64Array(32).fill(1),
    vmax: new Float64Array(32).fill(40), v: new Float64Array(32).fill(40) };
  const course = { line }, learner = new PaceLearning(course, {});
  const car = { speed: 40, lateral: 0, damage: 0, aero: { wake: 0 }, race: { lap: 1, lastState: 'green' },
    wheels: Array.from({ length: 4 }, () => ({ tyre: { alpha: Math.atan(1.7 / 8.6), compound: 'soft' } })) };
  const observer = { track: { halfWidth: 7, curbWidth: 1 }, list: [] };
  const control = { e: 0, cur: { i: 10 }, trace: { reserve: 1 } };
  const sample = (time = 1, path = line) => learner.sample(car, path, observer, control, 1 / 30, { time, phase: 'racing' });
  return { line, course, learner, car, observer, control, sample };
}
{
  const f = fixture(); f.sample(); f.car.race.lap++; f.sample();
  f.car.race.lap++; f.sample(); f.car.race.lap++; f.sample();
  assert(f.line.paceTrim[10] > 1 && f.course.profileDirty, 'repeated clean corner observations adjust the pace profile');
}
for (const contaminate of [f => { f.car.aero.wake = 0.2; }, f => { f.observer.list.push({ physical: true, ds: 20 }); }]) {
  const f = fixture(); f.sample(); f.car.race.lap++; f.sample();
  contaminate(f); f.control.trace.reserve = 0.2; f.sample(3);
  assert(f.line.paceTrim.every(v => v === 1), 'traffic cannot teach a slower clean-air corner');
  assert(f.line.brakeTrim.every(v => v === 1), 'wake/traffic slides cannot contaminate brake trims');
}
{
  const f = fixture(); f.sample(); f.control.trace.reserve = 0.2; f.sample(3);
  assert(f.line.paceTrim[10] < 1 && f.line.brakeTrim[5] < 1, 'a genuine clean-air slide reduces corner demand and its braking approach');
}
console.log('VANGUARD clean-air pace learning checks passed.');
