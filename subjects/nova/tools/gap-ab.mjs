// Stage 0 B-gap: can the quasi-steady plan actually be driven through the
// transient model?
//
// A is a quasi-steady optimum: it assumes the car reaches the cornering
// capability of the current station instantly. M_FAST contains the measured
// actuator lag, the yaw buildup and the combined-slip coupling, so driving A
// through M_FAST with ideal curvature feed-forward answers a precise question:
// how much of A is unrealisable, and where?
//
// This is a FEASIBILITY BOUND, not a full transient OCP (that is Stage 0.5).
// The path is pinned to A's line, so any deviation can only make it slower:
//   B_lb >= lap time of A's line driven through the transient model.
//
//   node tools/gap-ab.mjs [--variant measured|analytic]

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { RaceLine } from '../src/ai/race-line.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { loadFastModel } from '../src/ai/model/fast-model.js';
import { clamp } from '../src/sim/math.js';

const root = process.cwd();
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const variant = arg('variant', 'measured');
const DT = 1 / 120;
const spec = carSpecFor('gt');

const id = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const mass = spec.mass + 20;
const G = 9.81, RHO = 1.225;
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;
const dragAccel = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollAccel = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;
const curves = {
  latMax: id.tests.capability.map((c) => [c.v, c.latMax]),
  driveForce: id.tests.drive.bins.map((b) => [b.v, mass * (b.value + dragAccel(b.v) + rollAccel(b.v) + 0.33)]),
  brakeForce: id.tests.brake.bins.map((b) => [b.v, mass * b.value]),
};

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: 0.5 });
const envelope = variant === 'measured'
  ? createEnvelope(spec, { fuelKg: 20, wing: 6, curves })
  : createEnvelope(spec, { fuelKg: 20, wing: 6 });
const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', `harbor-ring-gt${variant === 'measured' ? '-measured' : ''}.json`), 'utf8'));
const line = new RaceLine(model, envelope, { widths: meta.widths, overlap: meta.overlap, coeffs: meta.coeffs, iterations: 14 });

const fast = await loadFastModel(spec, path.join(root, 'artifacts', 'plant-identification-v2.json'));

// Start on the line at the start/finish, at the profile's speed for that station.
const i0 = model.index(track.finishS ?? 0);
const s0 = line.path.s ?? 0;
void i0; void s0;
const start = 0;
const kappaAt = (s) => {
  const i = model.index(s);
  return line.path.kappa[i];
};
const vPlan = (s) => {
  const i = model.index(s);
  return line.profile.v[i];
};

const state = fast.init({ x: line.path.px[0], z: line.path.pz[0], yaw: line.path.heading[0], u: vPlan(0), r: vPlan(0) * kappaAt(0), steer: Math.atan(spec.wheelbase * kappaAt(0)) });

let t = 0;
let s = 0;
let prevX = state.x, prevZ = state.z;
const dev = [];
let maxDev = 0, devSum = 0, n = 0;
let throttleInt = 0;
const lock = spec.steeringLock;

while (s < model.length && t < 400) {
  const kappa = kappaAt(s);
  const vTarget = vPlan(s);
  const steerCmd = clamp(Math.atan(spec.wheelbase * kappa) / lock, -1, 1);
  // Longitudinal: track the planned speed with a PI on the *plan* error.
  const err = vTarget - state.u;
  throttleInt = clamp(throttleInt + err * DT * 0.25, -0.6, 0.9);
  const demand = clamp(err * 0.35 + throttleInt, -1, 1);
  const throttle = demand > 0 ? clamp(demand, 0, 1) : 0;
  const brake = demand < 0 ? clamp(-demand, 0, 1) : 0;
  void brake;

  fast.step(state, { steer: steerCmd, throttle, brake }, DT);
  t += DT;

  const ds = Math.hypot(state.x - prevX, state.z - prevZ);
  prevX = state.x; prevZ = state.z;
  s += ds;

  // Deviation from the planned line (lateral offset at the current station).
  const i = model.index(s);
  const dx = state.x - line.path.px[i], dz = state.z - line.path.pz[i];
  const q = dx * line.path.nx[i] + dz * line.path.nz[i];
  dev.push({ s, q, v: state.u, vTarget, kappa, ay: state.u * state.r });
  devSum += Math.abs(q); n++;
  maxDev = Math.max(maxDev, Math.abs(q));
}

const meanDev = devSum / Math.max(1, n);
const bins = [];
for (let b = 0; b < model.length; b += 200) {
  const w = dev.filter((d) => d.s >= b && d.s < b + 200);
  if (!w.length) continue;
  bins.push({
    from: b, to: b + 200,
    meanQ: +(w.reduce((a, d) => a + Math.abs(d.q), 0) / w.length).toFixed(2),
    maxQ: +Math.max(...w.map((d) => Math.abs(d.q))).toFixed(2),
    time: +(w.length * DT).toFixed(2),
    planTime: +(w.reduce((a, d) => a + 1 / Math.max(1, d.vTarget), 0) / 120).toFixed(2),
    meanV: +(w.reduce((a, d) => a + d.v, 0) / w.length).toFixed(1),
    meanVTarget: +(w.reduce((a, d) => a + d.vTarget, 0) / w.length).toFixed(1),
  });
}

console.log(`variant ${variant}: plan ${line.time.toFixed(3)} s, driven through M_FAST in ${t.toFixed(3)} s`);
console.log(`line deviation: mean ${meanDev.toFixed(2)} m, max ${maxDev.toFixed(2)} m`);
console.log('  from    to  time  planTime  meanV  vTarget  meanQ  maxQ');
for (const b of bins) {
  console.log(`${String(b.from).padStart(6)} ${String(b.to).padStart(5)} ${String(b.time).padStart(5)} ${String(b.planTime).padStart(9)} ${String(b.meanV).padStart(6)} ${String(b.meanVTarget).padStart(8)} ${String(b.meanQ).padStart(6)} ${String(b.maxQ).padStart(5)}`);
}

fs.writeFileSync(path.join(root, 'artifacts', `stage0-b-${variant}.json`), JSON.stringify({ variant, planTime: line.time, drivenTime: t, meanDev, maxDev, bins, trace: dev.filter((_, k) => k % 30 === 0).map((d) => [+d.s.toFixed(1), +d.q.toFixed(2), +d.v.toFixed(2), +d.vTarget.toFixed(2)]) }, null, 1));
console.log(`wrote artifacts/stage0-b-${variant}.json`);
