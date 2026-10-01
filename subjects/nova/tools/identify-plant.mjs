// Plant identification: measures the real Vehicle's steady-state limits and
// compares them with the analytic envelope. Outputs calibration factors that
// `createEnvelope` can consume, so the global optimiser reasons in the plant's
// real units rather than its nominal ones.
//
// Method: a very large, very wide flat surface (a 5 km circle) so steering and
// throttle probes are effectively straight-line / constant-steering tests with
// no path-following controller in the loop.

import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { clamp } from '../src/sim/math.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DT = 1 / 120;

function hugeTrack(R = 5000, halfWidth = 300) {
  const points = [];
  const count = 64;
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2;
    points.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
  return new Track({
    id: 'lab', name: 'Lab', controlPoints: points, sampleDensity: 24,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 4,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}

function speedHold(car, target, dt) {
  const err = target - car.speed;
  let throttle = 0, brake = 0;
  if (err > 0.4) throttle = clamp(err * 0.35, 0, 1);
  if (err < -0.4) brake = clamp(-err * 0.08, 0, 0.6);
  return { throttle, brake };
}

// Constant-steering sweep at a held speed: returns the peak lateral
// acceleration the plant can sustain before grip saturation or spin.
function cornerSweep(targetSpeed, seconds = 14) {
  const track = hugeTrack();
  const car = new Vehicle(0, 'PROBE', '#fff', 'gt');
  car.place(track, 0, 0, targetSpeed);
  const samples = [];
  let previousYawRate = 0;
  for (let t = 0; t < seconds; t += DT) {
    const ramp = clamp((t - 1.5) / 9, 0, 1);
    const steer = ramp;
    const pedals = speedHold(car, targetSpeed, DT);
    car.controls = { steer, brake: pedals.brake, throttle: pedals.throttle, reverse: false };
    car.step(DT, track);
    const ay = Math.abs(car.speed * car.yawRate);
    samples.push({ speed: car.speed, ay, slip: Math.abs(car.v), steer: Math.abs(car.steering) });
    const spun = Math.abs(car.v) > 9 || Math.abs(car.yawRate - previousYawRate) > 1.2;
    previousYawRate = car.yawRate;
    if (spun) break;
    if (Math.abs(car.lateral) > track.halfWidth - 5) break;
  }
  // Peak lateral acceleration at the target speed (+-8%).
  let peak = 0;
  for (const s of samples) {
    if (Math.abs(s.speed - targetSpeed) / targetSpeed < 0.08) peak = Math.max(peak, s.ay);
  }
  return { peak, slipAtPeak: samples.filter((s) => Math.abs(s.speed - targetSpeed) / targetSpeed < 0.08).reduce((m, s) => (s.ay > m.ay ? s : m), { ay: -1 }).slip ?? 0, samples };
}

function brakeProbe(from = 88) {
  const track = hugeTrack();
  const car = new Vehicle(0, 'PROBE', '#fff', 'gt');
  car.place(track, 0, 0, from);
  const samples = [];
  for (let t = 0; t < 25; t += DT) {
    car.controls = { steer: 0, throttle: 0, brake: 1, reverse: false };
    car.step(DT, track);
    samples.push({ v: car.speed, decel: -car.ax });
    if (car.speed < 8) break;
  }
  return samples;
}

function driveProbe() {
  const track = hugeTrack();
  const car = new Vehicle(0, 'PROBE', '#fff', 'gt');
  car.place(track, 0, 0, 3);
  const samples = [];
  for (let t = 0; t < 40; t += DT) {
    car.controls = { steer: 0, throttle: 1, brake: 0, reverse: false };
    car.step(DT, track);
    samples.push({ v: car.speed, accel: car.ax });
    if (car.speed > 92) break;
  }
  return samples;
}

const env = createEnvelope(CAR_CLASSES.gt, {});
console.log('Analytic envelope vs measured plant (GT, tc=3 abs=4)');
console.log(' speed | measured ay | envelope ay | ratio');
const speeds = [10, 18, 28, 40, 55, 70];
const report = { corners: [], brake: null, drive: null, factors: {} };
for (const v of speeds) {
  const { peak } = cornerSweep(v);
  const envelopeAy = env.latMax(v);
  report.corners.push({ v, ay: peak, envelopeAy, ratio: peak / envelopeAy });
  console.log(`${String(v).padStart(6)} | ${peak.toFixed(2).padStart(11)} | ${envelopeAy.toFixed(2).padStart(11)} | ${(peak / envelopeAy).toFixed(3)}`);
}

const brake = brakeProbe();
console.log('\nbraking decel (m/s^2) vs speed:');
for (const p of brake.filter((_, i) => i % 24 === 0)) console.log(`  v=${p.v.toFixed(1).padStart(5)}  decel=${p.decel.toFixed(2)}`);
const drive = driveProbe();
console.log('\ndrive accel (m/s^2) vs speed:');
for (const p of drive.filter((_, i) => i % 60 === 0)) console.log(`  v=${p.v.toFixed(1).padStart(5)}  accel=${p.accel.toFixed(2)}`);
report.brake = brake;
report.drive = drive;

const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const brakeRatios = brake.filter((p) => p.v > 15 && p.decel > 5).map((p) => p.decel / env.brakeMax(p.v, 0));
const driveRatios = drive.filter((p) => p.v > 12 && p.v < 80 && p.accel > 0.5).map((p) => p.accel / Math.max(0.2, env.driveForce(p.v) / env.mass));
report.factors = {
  lat: mean(report.corners.map((c) => c.ratio)),
  brake: mean(brakeRatios),
  drive: mean(driveRatios),
};
console.log('\nSuggested calibration:', JSON.stringify(report.factors, (k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)));

mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts', 'plant-identification.json'), JSON.stringify(report, null, 1));
console.log('wrote artifacts/plant-identification.json');
