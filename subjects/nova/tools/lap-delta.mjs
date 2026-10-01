// Lap delta: compares a driven lap against the plan's speed profile in the
// distance domain and reports where the time is going, section by section.

import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const args = process.argv.slice(2);
const seconds = Number(args[0] ?? 260);

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.laps = 4;
session.autopilot = true;
session.start();
const car = session.cars[0];
const line = session.lineFor(car);
const model = session.model;
const dt = 1 / 120;

const samples = [];
let nextSample = 0;
let lapStart = null;
let lapNumber = 0;
let previousLap = null;
for (let step = 0; step < 120 * seconds; step++) {
  session.step(dt, { throttle: 0, brake: 0, steer: 0 });
  const t = step * dt;
  if (car.s > 200 && lapStart === null && car.race.lap === 1) lapStart = { t, s: car.s };
  if (t >= nextSample && lapStart) {
    nextSample = t + 0.05;
    samples.push({ s: car.s, t: t - lapStart.t, v: car.speed, throttle: car.controls.throttle, brake: car.controls.brake, q: car.lateral, offtrack: car.race.offtrack });
  }
  if (previousLap === null && car.race.lap === 2 && t > 60) {
    previousLap = lapNumber;
    break;
  }
}

// Plan timeline in the same distance domain.
const plan = line.profile;
const d = model.ds;
const planAt = (s) => plan.v[model.index(s)];
let planTime = 0;
const planCum = new Map();
for (let s = 0; s < model.length; s += d) {
  planCum.set(s, planTime);
  planTime += d / Math.max(0.5, planAt(s));
}
const result = line.time;

// Walk the driven samples and accumulate dt vs plan dt over each 200 m block.
const blocks = new Map();
let prev = null;
for (const sample of samples) {
  if (prev) {
    const ds = ((sample.s - prev.s + model.length * 1.5) % model.length) - model.length * 0.5;
    if (Math.abs(ds) < 50 && ds > 0) {
      const block = Math.floor(prev.s / 200) * 200;
      const dtActual = sample.t - prev.t;
      const dtPlan = ds / Math.max(0.5, (planAt(prev.s) + planAt(sample.s)) / 2);
      const entry = blocks.get(block) ?? { actual: 0, plan: 0, n: 0, v: 0, vAvg: 0, minV: Infinity };
      entry.actual += dtActual; entry.plan += dtPlan; entry.n++;
      entry.v += sample.v; entry.vAvg = entry.v / entry.n;
      entry.minV = Math.min(entry.minV, sample.v);
      blocks.set(block, entry);
    }
  }
  prev = sample;
}
console.log(`plan lap ${result.toFixed(2)} s`);
let total = 0, totalPlan = 0;
console.log('  block   actual    plan   delta    avgV   minV');
for (const [block, e] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
  total += e.actual; totalPlan += e.plan;
  console.log(`  ${String(block).padStart(5)}  ${e.actual.toFixed(2).padStart(7)} ${e.plan.toFixed(2).padStart(7)} ${(e.actual - e.plan).toFixed(2).padStart(7)} ${e.vAvg.toFixed(1).padStart(7)} ${e.minV.toFixed(1).padStart(6)}`);
}
console.log(`  total   ${total.toFixed(2).padStart(7)} ${totalPlan.toFixed(2).padStart(7)} ${(total - totalPlan).toFixed(2).padStart(7)}`);
