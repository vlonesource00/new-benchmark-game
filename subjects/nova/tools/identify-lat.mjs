// Lateral envelope identification: holds constant-radius circles with the real
// tracker and finds the maximum sustainable speed per radius. Reports the
// measured lateral acceleration against the analytic envelope so the planning
// factor can be calibrated.

import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { createTracker } from '../src/ai/control/tracker.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { buildPath } from '../src/ai/global/path-geometry.js';
import { clamp } from '../src/sim/math.js';

const DT = 1 / 120;

function circleTrack(R, halfWidth = 120) {
  const points = [];
  const count = 64;
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2;
    points.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
  return new Track({
    id: 'lab', name: 'Lab', controlPoints: points, sampleDensity: 20,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 4,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}

function holdCircle(R, targetSpeed, seconds = 8) {
  const track = circleTrack(R);
  const model = buildTrackModel(track, { spacing: 2 });
  const q = new Float64Array(model.n);
  const path = buildPath(model, q);
  const car = new Vehicle(0, 'PROBE', '#fff', 'gt');
  car.place(track, 0, 0, targetSpeed);
  const tracker = createTracker();
  let ok = true;
  let aySum = 0, vSum = 0, samples = 0;
  for (let t = 0; t < seconds; t += DT) {
    const ego = {
      x: car.x, z: car.z, yaw: car.yaw, yawRate: car.yawRate, speed: car.speed,
      s: car.s, spec: car.spec,
    };
    const lat = tracker.command(ego, model, path, DT);
    // Speed hold with traction-aware pedals.
    const err = targetSpeed - car.speed;
    const throttle = clamp(err * 0.4, 0, 1);
    const brake = clamp(-err * 0.1, 0, 0.5);
    car.controls = { steer: lat.steer, throttle, brake };
    if (Math.abs(lat.elat) > 6) ok = false;
    car.step(DT, track);
    if (Math.abs(car.v) > 8) ok = false;
    if (t > seconds - 2) { aySum += car.speed * car.yawRate; vSum += car.speed; samples++; }
  }
  return { ok, ay: aySum / samples, speed: vSum / samples };
}

function maxSpeedForRadius(R, lo = 12, hi = 70) {
  let ok = null;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    const result = holdCircle(R, mid, 6);
    if (result.ok) { lo = mid; ok = result; } else hi = mid;
  }
  return ok;
}

const env = createEnvelope(CAR_CLASSES.gt, {});
console.log('R      max v    measured ay   envelope ay   ratio   speed in envelope');
const report = [];
for (const R of [400, 250, 150, 90, 60, 40]) {
  const result = maxSpeedForRadius(R);
  if (!result) { console.log(`${String(R).padStart(4)}   no stable speed`); continue; }
  const ay = result.speed * result.speed / R;
  const envelopeAy = env.latMax(result.speed);
  report.push({ R, speed: result.speed, ay, envelopeAy, ratio: ay / envelopeAy });
  console.log(
    `${String(R).padStart(4)}  ${result.speed.toFixed(1).padStart(7)}  ${ay.toFixed(2).padStart(12)}  ${envelopeAy.toFixed(2).padStart(12)}  ` +
    `${(ay / envelopeAy).toFixed(3).padStart(6)}`,
  );
}
const ratios = report.map((r) => r.ratio);
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
console.log('mean lateral ratio:', mean.toFixed(3));
