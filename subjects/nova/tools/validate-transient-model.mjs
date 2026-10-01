// tools/validate-transient-model.mjs
// Scientific Validation Harness for M_RT vs M_FAST vs Canonical M_ORACLE Plant
// Evaluates all 14 required manoeuvres across 5 horizons [0.25, 0.5, 1.0, 1.5, 2.0] s.
// Computes non-canceling error metrics (MAE, RMSE, p95, Max, Bias) for all physical signals.
// Literally enforces stated gates for straight and high-dynamic regimes.

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { clamp, angle } from '../src/sim/math.js';
import { createFastModel } from '../src/ai/model/fast-model.js';
import { loadTransientModel } from '../src/ai/model/transient-model.js';

const DT = 1 / 120;
const SPEC = CAR_CLASSES.gt;
const FUEL_L = 35;
const FUEL_KG = FUEL_L * 0.75; // 26.25 kg
const EFFECTIVE_MASS = SPEC.mass + FUEL_KG; // 1316.25 kg

const OUT = path.join(process.cwd(), 'artifacts', 'transient-model-validation.json');
const HORIZONS = [0.25, 0.50, 1.00, 1.50, 2.00];

console.log('================================================================================');
console.log('M_RT SCIENTIFIC VALIDATION CAMPAIGN (PHASE 2.1 HARDENING)');
console.log(`Class: GT | Effective Mass: ${EFFECTIVE_MASS.toFixed(2)} kg (dry: ${SPEC.mass} kg, fuel: ${FUEL_KG.toFixed(2)} kg)`);
console.log('Canonical Plant: Vehicle + Tyre @ 120/480 Hz | Baseline: M_FAST | Reduced: M_RT');
console.log('================================================================================\n');

// Load identification artifacts
const plantIdPath = path.join(process.cwd(), 'artifacts', 'plant-identification-v2.json');
const mrtIdPath = path.join(process.cwd(), 'artifacts', 'mrt-identification-v1.json');

const plantId = JSON.parse(fs.readFileSync(plantIdPath, 'utf8'));
const mrtId = JSON.parse(fs.readFileSync(mrtIdPath, 'utf8'));

// Instantiate models with EXACT mass parity (1316.25 kg)
const mFast = createFastModel({ spec: SPEC, identification: plantId, fuelKg: FUEL_KG });
const mRt = loadTransientModel(SPEC, mrtIdPath);

function circleLab(R) {
  const pts = [];
  const n = 256;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    pts.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
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

const straight = () => {
  const pts = [];
  for (let z = -1200; z <= 1200; z += 200) pts.push({ x: 0, y: 0, z });
  for (let i = 1; i < 12; i++) {
    const a = Math.PI - (i / 12) * Math.PI;
    pts.push({ x: 60 + 60 * Math.cos(a), y: 0, z: 1200 + 60 * Math.sin(a) });
  }
  for (let z = 1200; z >= -1200; z -= 200) pts.push({ x: 120, y: 0, z });
  for (let i = 1; i < 12; i++) {
    const a = (i / 12) * Math.PI;
    pts.push({ x: 60 + 60 * Math.cos(a), y: 0, z: -1200 + 60 * Math.sin(a) });
  }
  return new Track({
    id: 'lab-oval', name: 'Lab Oval', controlPoints: pts, sampleDensity: 40,
    roadHalfWidth: 400, curbWidth: 1, runoffWidth: 20,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
};
const STRAIGHT = straight();
const steerFor = (ayTarget, v) => Math.atan(SPEC.wheelbase / ((v * v) / ayTarget)) / SPEC.steeringLock;

const oracleState = (car) => ({
  x: car.x,
  z: car.z,
  yaw: car.yaw,
  u: car.u,
  v: car.v,
  r: car.yawRate,
  steer: car.steering,
  ax: car.ax,
  ay: car.speed * car.yawRate,
  beta: Math.atan2(car.v, Math.max(1, car.u))
});

// Non-canceling statistical metrics helper
function computeMetrics(errors) {
  if (!errors.length) return { bias: 0, mae: 0, rmse: 0, p95: 0, max: 0 };
  const n = errors.length;
  const sum = errors.reduce((acc, v) => acc + v, 0);
  const bias = sum / n;
  const absErrors = errors.map(Math.abs);
  const mae = absErrors.reduce((acc, v) => acc + v, 0) / n;
  const sqSum = errors.reduce((acc, v) => acc + v * v, 0);
  const rmse = Math.sqrt(sqSum / n);
  absErrors.sort((a, b) => a - b);
  const p95Idx = Math.min(n - 1, Math.floor(n * 0.95));
  const p95 = absErrors[p95Idx];
  const max = absErrors[n - 1];

  return {
    bias: +bias.toFixed(4),
    mae: +mae.toFixed(4),
    rmse: +rmse.toFixed(4),
    p95: +p95.toFixed(4),
    max: +max.toFixed(4)
  };
}

function runManoeuvre({ name, isHighDynamic, setup, spinUp, seconds, warm, main }) {
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

  // Initialize both models from identical starting oracle state
  const fast = mFast.init({ x: o0.x, z: o0.z, yaw: o0.yaw, u: o0.u, r: o0.r, steer: o0.steer, beta: o0.beta });
  const rt = mRt.init({ x: o0.x, z: o0.z, yaw: o0.yaw, u: o0.u, v: o0.v, r: o0.r, steer: o0.steer, beta: o0.beta });

  const samples = [];
  const n = Math.round(seconds / DT);

  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const cmd = main(t, { steadyThrottle, o0 });
    car.controls = { steer: 0, throttle: 0, brake: 0, ...cmd };
    car.step(DT, track, 0);

    mFast.step(fast, cmd, DT);
    mRt.step(rt, cmd, DT);

    const o = oracleState(car);

    samples.push({
      t,
      // Pose errors
      fastPosErr: Math.hypot(o.x - fast.x, o.z - fast.z),
      rtPosErr: Math.hypot(o.x - rt.x, o.z - rt.z),
      fastYawErr: Math.abs(angle(o.yaw - fast.yaw)),
      rtYawErr: Math.abs(angle(o.yaw - rt.yaw)),
      // Velocity & body slip errors
      fastSpeedErr: o.u - fast.u,
      rtSpeedErr: o.u - rt.u,
      fastBetaErr: o.beta - (fast.beta || 0),
      rtBetaErr: o.beta - rt.beta,
      // Dynamic states
      fastYawRateErr: o.r - fast.r,
      rtYawRateErr: o.r - rt.r,
      fastAxErr: o.ax - fast.ax,
      rtAxErr: o.ax - rt.ax,
      fastAyErr: o.ay - fast.ay,
      rtAyErr: o.ay - rt.ay,
    });
  }

  // Evaluate across discrete horizons
  const horizonMetrics = HORIZONS.map((h) => {
    const w = samples.filter((r) => r.t >= h - 0.05 && r.t <= h + 0.05);

    return {
      h,
      fastPos: computeMetrics(w.map(s => s.fastPosErr)),
      rtPos: computeMetrics(w.map(s => s.rtPosErr)),
      fastYaw: computeMetrics(w.map(s => s.fastYawErr)),
      rtYaw: computeMetrics(w.map(s => s.rtYawErr)),
      fastSpeed: computeMetrics(w.map(s => s.fastSpeedErr)),
      rtSpeed: computeMetrics(w.map(s => s.rtSpeedErr)),
      fastBeta: computeMetrics(w.map(s => s.fastBetaErr)),
      rtBeta: computeMetrics(w.map(s => s.rtBetaErr)),
      fastYawRate: computeMetrics(w.map(s => s.fastYawRateErr)),
      rtYawRate: computeMetrics(w.map(s => s.rtYawRateErr)),
      fastAx: computeMetrics(w.map(s => s.fastAxErr)),
      rtAx: computeMetrics(w.map(s => s.rtAxErr)),
      fastAy: computeMetrics(w.map(s => s.fastAyErr)),
      rtAy: computeMetrics(w.map(s => s.rtAyErr)),
    };
  });

  return {
    name,
    isHighDynamic,
    steadyThrottle: +steadyThrottle.toFixed(3),
    horizons: horizonMetrics,
    rawSamplesCount: samples.length
  };
}

const scenarios = [
  // Straight / Low-Dynamic (Gate: 0.5s <= 0.50m, 1.0s <= 1.00m)
  { name: '1. straight launch (full throttle)', isHighDynamic: false, setup: { track: STRAIGHT, v: 8, s: 200 }, spinUp: 0.5, seconds: 2, main: () => ({ throttle: 1, brake: 0, steer: 0 }) },
  { name: '2. partial throttle', isHighDynamic: false, setup: { track: STRAIGHT, v: 30, s: 200 }, spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0.5, brake: 0, steer: 0 }) },
  { name: '3. straight max braking (60 m/s)', isHighDynamic: false, setup: { track: STRAIGHT, v: 60, s: 200 }, spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0, brake: 1, steer: 0 }) },
  { name: '4. partial braking', isHighDynamic: false, setup: { track: STRAIGHT, v: 60, s: 200 }, spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0, brake: 0.5, steer: 0 }) },
  { name: '5. coast (60 m/s)', isHighDynamic: false, setup: { track: STRAIGHT, v: 60, s: 200 }, spinUp: 0.5, seconds: 2, main: () => ({ throttle: 0, brake: 0, steer: 0 }) },

  // High-Dynamic / Cornering / Transitions (Gate: 0.5s <= 0.50m, 1.0s <= 1.50m, M_RT <= 0.65 * M_FAST)
  { name: '6. steady corner ay=6 @32', isHighDynamic: true, setup: (() => { const v=32, ay=6, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(6, 32), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '7. steady corner ay=9 @44', isHighDynamic: true, setup: (() => { const v=44, ay=9, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(9, 44), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '8. steady corner ay=12 @32', isHighDynamic: true, setup: (() => { const v=32, ay=12, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(12, 32), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '9. turn-in step ay=6 @32', isHighDynamic: true, setup: { track: STRAIGHT, v: 32, s: 200 }, spinUp: 1, seconds: 2, main: (t, ctx) => ({ steer: steerFor(6, 32), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '10. turn-in step ay=12 @32', isHighDynamic: true, setup: { track: STRAIGHT, v: 32, s: 200 }, spinUp: 1, seconds: 2, main: (t, ctx) => ({ steer: steerFor(12, 32), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '11. steering sine sweep', isHighDynamic: true, setup: { track: STRAIGHT, v: 40, s: 200 }, spinUp: 1, seconds: 2, main: (t, ctx) => ({ steer: 0.5 * Math.sin(t * 2 * Math.PI), throttle: ctx.steadyThrottle, brake: 0 }) },
  { name: '12. trail brake: ay=9 @32 then brake ramp', isHighDynamic: true, setup: (() => { const v=32, ay=9, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: clamp(ctx.steadyThrottle * (1 - t / 0.3), 0, 1), brake: clamp(t / 1.0, 0, 0.7) }) },
  { name: '13. exit: ay=9 @32 then full throttle', isHighDynamic: true, setup: (() => { const v=32, ay=9, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: t < 0.3 ? ctx.steadyThrottle : 1, brake: 0 }) },
  { name: '14. combined: ay=9 @32 then brake step 0.8', isHighDynamic: true, setup: (() => { const v=32, ay=9, R=v*v/ay, s=steerFor(ay, v); return { track: circleFor(R), v, s: 0, yawRate: v/R, steer: s*SPEC.steeringLock, steerCmd: s}; })(), spinUp: 4, seconds: 2, main: (t, ctx) => ({ steer: steerFor(9, 32), throttle: 0, brake: t > 0.2 ? 0.8 : ctx.steadyThrottle * 0.2 }) },
];

const results = [];
console.log('--- Transient Model Validation Matrix ---');
console.log('Manoeuvre'.padEnd(42) + ' | ' + HORIZONS.map(h => `h=${h.toFixed(2)}s (F / R)`.padEnd(20)).join(' | '));
console.log('-'.repeat(150));

let allGatesPass = true;
let sumFastHigh10 = 0;
let sumRtHigh10 = 0;

for (const sc of scenarios) {
  const r = runManoeuvre(sc);
  results.push(r);

  const cols = r.horizons.map(h => {
    const fMae = h.fastPos.mae.toFixed(2);
    const rMae = h.rtPos.mae.toFixed(2);
    return `F:${fMae} R:${rMae}`.padEnd(20);
  }).join(' | ');

  console.log(`${r.name.padEnd(42)} | ${cols}`);

  // Check certification gates
  const h05 = r.horizons.find(h => h.h === 0.50);
  const h10 = r.horizons.find(h => h.h === 1.00);

  const max05Allowed = 0.50;
  const max10Allowed = r.isHighDynamic ? 1.50 : 1.00;

  if (h05 && h05.rtPos.mae > max05Allowed) {
    console.warn(`  [!] FAILED 0.5s Gate: ${h05.rtPos.mae.toFixed(3)} m > ${max05Allowed} m`);
    allGatesPass = false;
  }
  if (h10 && h10.rtPos.mae > max10Allowed) {
    console.warn(`  [!] FAILED 1.0s Gate: ${h10.rtPos.mae.toFixed(3)} m > ${max10Allowed} m`);
    allGatesPass = false;
  }

  if (r.isHighDynamic && h10) {
    sumFastHigh10 += h10.fastPos.mae;
    sumRtHigh10 += h10.rtPos.mae;
  }
}

console.log('-'.repeat(150));
const highDynamicRatio = sumRtHigh10 / Math.max(0.001, sumFastHigh10);
const improvementPct = (1 - highDynamicRatio) * 100;
console.log(`\nAggregate High-Dynamic Score at 1.0s:`);
console.log(`  M_FAST Total MAE: ${sumFastHigh10.toFixed(3)} m`);
console.log(`  M_RT Total MAE:   ${sumRtHigh10.toFixed(3)} m`);
console.log(`  M_RT / M_FAST:    ${highDynamicRatio.toFixed(3)} (${improvementPct.toFixed(1)}% error reduction)`);

const comparisonGatePass = highDynamicRatio <= 0.65;
if (!comparisonGatePass) {
  console.warn(`  [!] FAILED High-Dynamic Comparison Gate: ratio ${highDynamicRatio.toFixed(3)} > 0.65 target`);
  allGatesPass = false;
} else {
  console.log(`  [✓] PASSED High-Dynamic Comparison Gate: ${highDynamicRatio.toFixed(3)} <= 0.65`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  effectiveMassKg: EFFECTIVE_MASS,
  horizons: HORIZONS,
  aggregateHighDynamicRatio: +highDynamicRatio.toFixed(4),
  improvementPct: +improvementPct.toFixed(2),
  allGatesPass,
  results
}, null, 2));
console.log(`\nWrote full certified results JSON to:\n  ${OUT}`);

if (!allGatesPass) {
  console.error('\n>>> CERTIFICATION FAILED: One or more gates were not met. <<<');
  process.exit(1);
} else {
  console.log('\n>>> CERTIFICATION PASSED: All 14 scenarios and comparison gates satisfied. <<<');
}
