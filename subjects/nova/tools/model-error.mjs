// Stage 0 model error map: M_FAST vs M_ORACLE.
//
// Both models are driven with the SAME control time series from the SAME initial
// condition. M_ORACLE is the Astra-derived plant (Vehicle+Tyre @120 Hz); M_FAST
// is the reduced model the planner optimises through. The manoeuvre list covers
// the regimes the planner actually plans in, and the error is reported at
// 0.25 / 0.5 / 1.0 / 2.0 s because that is the horizon over which a receding
// horizon controller must trust it.
//
// Output: artifacts/model-error-map.json

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { clamp } from '../src/sim/math.js';
import { loadFastModel } from '../src/ai/model/fast-model.js';

const DT = 1 / 120;
const SPEC = CAR_CLASSES.gt;
const OUT = path.join(process.cwd(), 'artifacts', 'model-error-map.json');
const HORIZONS = [0.25, 0.5, 1, 2];

function circleLab(R) {
  const pts = [];
  const n = 256;
  for (let i = 0; i < n; i++) { const th = (i / n) * Math.PI * 2; pts.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) }); }
  return new Track({
    id: 'lab-circle', name: 'Lab Circle', controlPoints: pts, sampleDensity: 4,
    roadHalfWidth: 400, curbWidth: 1, runoffWidth: 20,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}
const CIRCLES = new Map();
const circleFor = (R) => {
  const key = Math.max(20, Math.round(R / 5) * 5);
  if (!CIRCLES.has(key)) CIRCLES.set(key, circleLab(key));
  return CIRCLES.get(key);
};

const oracleState = (car) => ({
  x: car.x, z: car.z, yaw: car.yaw, u: car.speed, r: car.yawRate, steer: car.steering,
  ax: car.ax, ay: car.speed * car.yawRate,
});

const model = await loadFastModel(SPEC, path.join(process.cwd(), 'artifacts', 'plant-identification-v2.json'));

// Run a warm-up on the oracle so the manoeuvre starts from a genuine steady
// state, then hand the same state and controls to M_FAST. The steady-state
// throttle is measured during the warm-up, so a "steady corner" manoeuvre holds
// its speed instead of accelerating out of the comparison.
function runManoeuvre({ name, setup, spinUp, seconds, warm, main }) {
  const track = setup.track;
  const car = new Vehicle(0, 'PROBE', '#fff', 'gt');
  car.place(track, setup.s ?? 0, 0, setup.v);
  if (setup.yawRate) car.yawRate = setup.yawRate;
  if (setup.steer) car.steering = setup.steer;

  const spin = Math.round((spinUp ?? 0) / DT);
  let thrSum = 0, thrN = 0;
  for (let i = 0; i < spin; i++) {
    const t = i * DT;
    const err = setup.v - car.speed;
    car.controls = {
      steer: setup.steerCmd ?? 0,
      throttle: clamp(err * 0.12, 0, 1),
      brake: clamp(-err * 0.2, 0, 1),
      ...(warm ? warm(t) : {}),
    };
    car.step(DT, track, 0);
    if (i > spin - 90) { thrSum += car.controls.throttle; thrN++; }
  }
  const steadyThrottle = thrN ? thrSum / thrN : 0;
  const o0 = oracleState(car);
  const fast = model.init({ x: o0.x, z: o0.z, yaw: o0.yaw, u: o0.u, r: o0.r, steer: o0.steer });

  const samples = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const cmd = main(t, { steadyThrottle, o0 });
    car.controls = { steer: 0, throttle: 0, brake: 0, ...cmd };
    car.step(DT, track, 0);
    model.step(fast, cmd, DT);
    const o = oracleState(car);
    samples.push({
      t,
      posErr: Math.hypot(o.x - fast.x, o.z - fast.z),
      speedErr: o.u - fast.u,
      yawErr: Math.atan2(Math.sin(o.yaw - fast.yaw), Math.cos(o.yaw - fast.yaw)),
      yawRateErr: o.r - fast.r,
      ayErr: o.ay - fast.ay,
      axErr: o.ax - fast.ax,
      oracleAy: o.ay, oracleAx: o.ax, oracleU: o.u, fastAy: fast.ay, fastU: fast.u,
    });
  }
  const absMean = (arr, k) => arr.reduce((s, r) => s + Math.abs(r[k]), 0) / Math.max(1, arr.length);
  const meanSgn = (arr, k) => arr.reduce((s, r) => s + r[k], 0) / Math.max(1, arr.length);
  const at = HORIZONS.map((h) => {
    const w = samples.filter((r) => r.t >= h - 0.05 && r.t <= h + 0.05);
    return {
      h,
      posErr: +absMean(w, 'posErr').toFixed(3), speedErr: +meanSgn(w, 'speedErr').toFixed(3),
      yawErr: +absMean(w, 'yawErr').toFixed(4), yawRateErr: +meanSgn(w, 'yawRateErr').toFixed(4),
      ayErr: +meanSgn(w, 'ayErr').toFixed(3), axErr: +meanSgn(w, 'axErr').toFixed(3),
      oracleAy: +absMean(w, 'oracleAy').toFixed(2), fastAy: +absMean(w, 'fastAy').toFixed(2),
    };
  });
  const mk = (k) => samples.reduce((s, r) => Math.max(s, Math.abs(r[k])), 0);
  const last = samples[samples.length - 1];
  return {
    name, steadyThrottle: +steadyThrottle.toFixed(3), horizons: at,
    max: { posErr: +mk('posErr').toFixed(2), yawErr: +mk('yawErr').toFixed(4), ayErr: +mk('ayErr').toFixed(2), speedErr: +mk('speedErr').toFixed(2) },
    finalPosErr: +last.posErr.toFixed(2),
    finalSpeedErr: +last.speedErr.toFixed(2),
    // trajectory snippet for inspection at 0.25 s resolution
    trace: samples.filter((_, i) => i % 30 === 0).map((r) => [+r.t.toFixed(2), +r.posErr.toFixed(2), +r.speedErr.toFixed(2), +r.oracleAy.toFixed(2), +r.fastAy.toFixed(2)]),
  };
}

// --- manoeuvres -------------------------------------------------------------

const straight = () => {
  const pts = [];
  for (let z = -1200; z <= 1200; z += 200) pts.push({ x: 0, y: 0, z });
  for (let i = 1; i < 12; i++) { const a = Math.PI - (i / 12) * Math.PI; pts.push({ x: 60 + 60 * Math.cos(a), y: 0, z: 1200 + 60 * Math.sin(a) }); }
  for (let z = 1200; z >= -1200; z -= 200) pts.push({ x: 120, y: 0, z });
  for (let i = 1; i < 12; i++) { const a = (i / 12) * Math.PI; pts.push({ x: 60 + 60 * Math.cos(a), y: 0, z: -1200 + 60 * Math.sin(a) }); }
  return new Track({
    id: 'lab-oval', name: 'Lab Oval', controlPoints: pts, sampleDensity: 40,
    roadHalfWidth: 400, curbWidth: 1, runoffWidth: 20,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
};
const STRAIGHT = straight();
const steerFor = (ayTarget, v) => Math.atan(SPEC.wheelbase / ((v * v) / ayTarget)) / SPEC.steeringLock;

const scenarios = [
  { name: 'straight launch (full throttle)', setup: { track: STRAIGHT, v: 8, s: 200 },
    spinUp: 0.5, seconds: 2, main: () => ({ throttle: 1, brake: 0, steer: 0 }) },
  { name: 'straight max braking (60 m/s)', setup: { track: STRAIGHT, v: 60, s: 200 },
    spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0, brake: 1, steer: 0 }) },
  { name: 'coast (60 m/s)', setup: { track: STRAIGHT, v: 60, s: 200 },
    spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0, brake: 0, steer: 0 }) },
  ...[
    ['steady corner ay=6 @32', 32, 6],
    ['steady corner ay=12 @32', 32, 12],
    ['steady corner ay=9 @44', 44, 9],
  ].map(([name, v, ayTarget]) => {
    const R = (v * v) / ayTarget;
    const steer = steerFor(ayTarget, v);
    return {
      name, setup: { track: circleFor(R), v, s: 0, yawRate: v / R, steer: steer * SPEC.steeringLock, steerCmd: steer },
      spinUp: 4, seconds: 2,
      main: (t, ctx) => ({ steer, throttle: ctx.steadyThrottle, brake: 0 }),
    };
  }),
  ...[
    ['turn-in step to ay=6 @32', 32, 6],
    ['turn-in step to ay=12 @32', 32, 12],
  ].map(([name, v, ayTarget]) => {
    const steer = steerFor(ayTarget, v);
    return {
      name, setup: { track: STRAIGHT, v, s: 200 },
      spinUp: 1, seconds: 2,
      main: (t, ctx) => ({ steer, throttle: ctx.steadyThrottle, brake: 0 }),
    };
  }),
  {
    name: 'trail brake: ay=9 @32 then brake ramp',
    setup: (() => { const v = 32, ay = 9, R = (v * v) / ay; return { track: circleFor(R), v, s: 0, yawRate: v / R, steer: steerFor(ay, v) * SPEC.steeringLock, steerCmd: steerFor(ay, v) }; })(),
    spinUp: 4, seconds: 2,
    main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: clamp(ctx.steadyThrottle * (1 - t / 0.3), 0, 1), brake: clamp(t / 1.0, 0, 0.7) }),
  },
  {
    name: 'exit: ay=9 @32 then full throttle',
    setup: (() => { const v = 32, ay = 9, R = (v * v) / ay; return { track: circleFor(R), v, s: 0, yawRate: v / R, steer: steerFor(ay, v) * SPEC.steeringLock, steerCmd: steerFor(ay, v) }; })(),
    spinUp: 4, seconds: 2,
    main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: t < 0.3 ? ctx.steadyThrottle : 1, brake: 0 }),
  },
  {
    name: 'combined: ay=9 @32 then brake step 0.8',
    setup: (() => { const v = 32, ay = 9, R = (v * v) / ay; return { track: circleFor(R), v, s: 0, yawRate: v / R, steer: steerFor(ay, v) * SPEC.steeringLock, steerCmd: steerFor(ay, v) }; })(),
    spinUp: 4, seconds: 2,
    main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: 0, brake: t > 0.2 ? 0.8 : ctx.steadyThrottle * 0.2 }),
  },
];

const results = [];
for (const sc of scenarios) {
  const r = runManoeuvre(sc);
  results.push(r);
  const cols = r.horizons.map((h) => `h${h.h}: pos ${h.posErr.toFixed(2)} v ${h.speedErr.toFixed(2)} yaw ${h.yawErr.toFixed(3)} ay ${h.ayErr.toFixed(2)}`).join(' | ');
  console.log(`${r.name.padEnd(34)} ${cols}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), dt: DT, horizons: HORIZONS, results }, null, 1));
console.log(`\nwrote ${OUT}`);
