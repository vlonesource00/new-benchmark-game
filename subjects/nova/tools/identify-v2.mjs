// Stage 0 plant identification (v2).
//
// The first probe measured what the *racing tracker* could sustain on a closed
// loop, folding tracker error, path geometry and tyre capability into one
// number, and then collapsed that number into a single `tyreFactor`. It was also
// invalid by construction: at racing speeds a 15% steering input already demands
// more lateral acceleration than the tyres can produce, so the "steady state"
// being averaged was a saturating, rotating car.
//
// This probe separates the two things that were mixed:
//
//   1. TYRE LAW      exact tables from src/sim/tyre.js, driven with prescribed
//                    slip inputs (no vehicle, no controller, no transients).
//   2. VEHICLE LEVEL validated separately: load transfer, drag, drive and brake
//                    from straight-line tests, plus a circle-hold speed search
//                    to confirm the derived lateral capability.
//
// Capability curves (latMax, driveAx, brakeDecel) are then DERIVED from the
// tyre tables plus the plant's own load model, with no free scaling parameter.
//
// Output: artifacts/plant-identification-v2.json

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { createTyre, tyreForce } from '../src/sim/tyre.js';
import { clamp } from '../src/sim/math.js';

const DT = 1 / 120;
const G = 9.81;
const RHO = 1.225;
const OUT = path.join(process.cwd(), 'artifacts', 'plant-identification-v2.json');
const QUICK = process.argv.includes('--quick');
const SPEC = CAR_CLASSES.gt;
const FUEL = 35;
const AMBIENT = 24;

// --- 1. TYRE LAW ------------------------------------------------------------

// Drive a single tyre to its steady state at a prescribed slip state, holding
// temperature and pressure where the probe wants them.
function steadyTyre({ alpha = 0, kappa = 0, load, core = 85, coldPressure = 1.65, vx = 30 }) {
  const t = createTyre(coldPressure);
  t.core = core; t.surface = core;
  const radius = SPEC.radius;
  const vy = vx * Math.tan(alpha);
  const omega = (vx * (1 + kappa)) / radius;
  for (let i = 0; i < 300; i++) {
    tyreForce(t, { vx, vy, omega, radius, load, grip: 1, camber: -0.035, ambient: AMBIENT }, 1 / 480);
    t.core = core; t.surface = core; // freeze the thermal state
  }
  return { fx: t.fx, fy: t.fy, alpha: t.alpha, kappa: t.kappa, utilisation: t.utilisation, pressure: t.pressure };
}

function tyreLaw() {
  const loads_ = QUICK ? [1600, 4000] : [1200, 2000, 3000, 4000, 5500, 7000, 8500];
  const alphas = [];
  for (let a = -0.35; a <= 0.3501; a += 0.025) alphas.push(+a.toFixed(4));
  const kappas = [];
  for (let k = -0.25; k <= 0.2501; k += 0.02) kappas.push(+k.toFixed(4));

  const lateral = [];
  for (const load of loads_) {
    const row = alphas.map((alpha) => ({ alpha, ...steadyTyre({ alpha, load }) }));
    const peak = row.reduce((a, b) => (Math.abs(b.fy) > Math.abs(a.fy) ? b : a));
    lateral.push({
      load,
      peakFy: Math.abs(peak.fy),
      muPeak: Math.abs(peak.fy) / load,
      alphaAtPeak: peak.alpha,
      alphaAtPeakDeg: +(peak.alpha * 180 / Math.PI).toFixed(2),
      curve: row.map((r) => [+r.alpha.toFixed(3), +r.fy.toFixed(1), +r.utilisation.toFixed(3)]),
    });
  }

  const longitudinal = [];
  for (const load of loads_) {
    const row = kappas.map((kappa) => ({ kappa, ...steadyTyre({ kappa, load }) }));
    const peak = row.reduce((a, b) => (Math.abs(b.fx) > Math.abs(a.fx) ? b : a));
    longitudinal.push({
      load,
      peakFx: Math.abs(peak.fx),
      muPeak: Math.abs(peak.fx) / load,
      kappaAtPeak: peak.kappa,
      curve: row.map((r) => [+r.kappa.toFixed(3), +r.fx.toFixed(1), +r.utilisation.toFixed(3)]),
    });
  }

  // Combined slip: how much lateral force survives longitudinal demand.
  const combined = [];
  const load = 4000;
  for (const alpha of [-0.12, -0.08, -0.04, 0.04, 0.08, 0.12]) {
    const row = [];
    for (const kappa of [-0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15]) {
      const r = steadyTyre({ alpha, kappa, load });
      row.push({ kappa, fy: +r.fy.toFixed(1), fx: +r.fx.toFixed(1), util: +r.utilisation.toFixed(3) });
    }
    combined.push({ alpha, row });
  }

  // Temperature and pressure dependence of the peak.
  const thermal = [];
  for (const core of [25, 35, 45, 55, 65, 75, 85, 95, 105]) {
    const r = steadyTyre({ alpha: 0.12, load: 3500, core });
    thermal.push({ core, pressure: +r.pressure.toFixed(3), fyPeak: +Math.abs(r.fy).toFixed(1), mu: +Math.abs(r.fy / 3500).toFixed(4) });
  }
  const pressureSweep = [];
  for (const coldPressure of [1.4, 1.5, 1.65, 1.8, 2.0, 2.2]) {
    const r = steadyTyre({ alpha: 0.12, load: 3500, core: 85, coldPressure });
    pressureSweep.push({ coldPressure, pressure: +r.pressure.toFixed(3), fyPeak: +Math.abs(r.fy).toFixed(1), mu: +Math.abs(r.fy / 3500).toFixed(4) });
  }

  // Lateral relaxation: step alpha and watch the force rise.
  const relaxation = [];
  for (const vx of [10, 20, 40, 60]) {
    const t = createTyre(1.65);
    t.core = 85; t.surface = 85;
    const load = 3500, alpha = 0.1, radius = SPEC.radius;
    const vy = vx * Math.tan(alpha);
    const series = [];
    for (let i = 0; i < 200; i++) {
      tyreForce(t, { vx, vy, omega: vx / radius, radius, load, grip: 1, ambient: AMBIENT }, 1 / 480);
      t.core = 85; t.surface = 85;
      series.push(t.fy);
    }
    const final = series[series.length - 1];
    let t63 = null;
    for (let i = 0; i < series.length; i++) if (Math.abs(series[i]) >= 0.632 * Math.abs(final)) { t63 = i / 480; break; }
    relaxation.push({ vx, t63, tau: t63 === null ? null : +t63.toFixed(4), relaxationLengthM: t63 === null ? null : +(t63 * vx).toFixed(3) });
  }

  return { lateral, longitudinal, combined, thermal, pressureSweep, relaxation };
}

// --- 2. VEHICLE-LEVEL CAPABILITY DERIVED FROM THE TYRE LAW ------------------

const loadSensitivity = (load) => clamp(1 - 0.13 * Math.log(Math.max(0.1, load / 3300)), 0.68, 1.18);

// Interpolate the measured peak lateral force at an arbitrary load.
function peakFyAt(table, load) {
  const pts = table.map((r) => [r.load, r.peakFy]);
  if (load <= pts[0][0]) return load * (pts[0][1] / pts[0][0]);
  for (let i = 1; i < pts.length; i++) {
    if (load <= pts[i][0]) {
      const [l0, f0] = pts[i - 1], [l1, f1] = pts[i];
      const t = (load - l0) / (l1 - l0);
      return f0 + (f1 - f0) * t;
    }
  }
  const [l0, f0] = pts[pts.length - 2], [l1, f1] = pts[pts.length - 1];
  return f0 + (f1 - f0) * ((load - l0) / (l1 - l0));
}

// Downforce split as the plant computes it.
const downforceAt = (v) => 0.5 * RHO * v * v * SPEC.area * SPEC.cl;
const dragAt = (v) => 0.5 * RHO * v * v * SPEC.area * SPEC.cd;

// Maximum steady lateral acceleration: for a candidate ay, split the demand
// between axles as a steady turn requires (front carries b/L of it), split the
// load left/right with the plant's transfer, and check both axles against their
// measured peak force. Bisection on ay. No free parameters.
function latCapability(table, v) {
  const mass = SPEC.mass + FUEL;
  const L = SPEC.wheelbase;
  const a = SPEC.frontWeight * L;      // cg -> front axle
  const b = (1 - SPEC.frontWeight) * L; // cg -> rear axle
  const df = downforceAt(v);
  const Fzf = mass * G * SPEC.frontWeight + df * SPEC.frontAero;
  const Fzr = mass * G * (1 - SPEC.frontWeight) + df * (SPEC.key === 'gt' ? 0.57 : 1 - SPEC.frontAero);
  const cap = (ay) => {
    const transfer = (ay * mass * SPEC.cg) / SPEC.track;
    const fyfNeed = (mass * ay * b) / L;
    const fyrNeed = (mass * ay * a) / L;
    const axleCap = (Fz, share) =>
      peakFyAt(table, Math.max(50, Fz / 2 + transfer * share)) +
      peakFyAt(table, Math.max(50, Fz / 2 - transfer * share));
    return { fyfNeed, fyrNeed, fyfCap: axleCap(Fzf, 0.52), fyrCap: axleCap(Fzr, 0.48) };
  };
  let lo = 0, hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const c = cap(mid);
    if (c.fyfNeed <= c.fyfCap && c.fyrNeed <= c.fyrCap) lo = mid; else hi = mid;
  }
  const c = cap(lo);
  return { v, latMax: lo, downforce: df, Fzf, Fzr, ...c };
}

// --- 3. VEHICLE-LEVEL VALIDATION --------------------------------------------

function ovalLab() {
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
}
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
const OVAL = ovalLab();
const CIRCLES = new Map();
const circleFor = (R) => {
  const key = Math.max(20, Math.round(R / 10) * 10);
  if (!CIRCLES.has(key)) CIRCLES.set(key, circleLab(key));
  return CIRCLES.get(key);
};

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const newCar = (track, s, q, speed) => { const c = new Vehicle(0, 'PROBE', '#fff', 'gt'); c.place(track, s, q, speed); c.steering = 0; return c; };

function stepCar(car, track, controls, dt = DT) {
  car.controls = { steer: 0, throttle: 0, brake: 0, ...controls };
  car.step(dt, track, 0);
  return {
    t: 0, s: car.s, q: car.lateral, speed: car.speed,
    ay: car.speed * car.yawRate, ax: car.ax, yawRate: car.yawRate,
    steerActual: car.steering, alphaFront: (car.wheels[0].tyre.alpha + car.wheels[1].tyre.alpha) / 2,
    utilisation: mean(car.wheels.map((w) => w.tyre.utilisation)),
    core: mean(car.wheels.map((w) => w.tyre.core)),
    gear: car.gear,
  };
}

// Circle hold: feed-forward steering for radius R plus a yaw-rate PI and a
// lateral-error term. Used only to validate the derived capability, never to
// identify it.
function holdCircle(R, v, { seconds = 14, settle = 9 } = {}) {
  const track = circleFor(R);
  const car = newCar(track, 0, 0, v);
  // Seed the steady state instead of letting the controller discover it: the
  // car is placed on the tangent with zero yaw rate, which at 40 m/s is a
  // several-second transient that runs wide and is then mistaken for a limit.
  car.yawRate = v / R;
  car.yaw -= SPEC.wheelbase / R;
  const yawRateTarget = v / R;
  let i = 0;
  const out = [];
  let ok = true;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    const t = k * DT;
    const ff = Math.atan(SPEC.wheelbase / R);
    const err = yawRateTarget - car.yawRate;
    i = clamp(i + err * DT * 0.35, -0.3, 0.3);
    const steer = clamp((ff + err * 0.35 + i - car.lateral * 0.01) / SPEC.steeringLock, -1, 1);
    const speedErr = v - car.speed;
    const throttle = clamp(speedErr * 0.08, 0, 1);
    const brake = clamp(-speedErr * 0.15, 0, 1);
    const s = stepCar(car, track, { steer, throttle, brake });
    if (Math.abs(car.lateral) > 30) ok = false;
    if (t >= settle) out.push(s);
  }
  const n = out.length;
  if (n < 60) ok = false;
  return {
    ok, R, v, samples: n,
    ay: mean(out.map((s) => s.ay)), speed: mean(out.map((s) => s.speed)),
    alphaFront: mean(out.map((s) => s.alphaFront)), utilisation: mean(out.map((s) => s.utilisation)),
    steerActual: mean(out.map((s) => s.steerActual)), q: mean(out.map((s) => s.q)),
  };
}

// Binary search on speed for the highest steady circle at radius R.
function maxCircleSpeed(R, lo = 10, hi = 75) {
  let best = null;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    const r = holdCircle(R, mid, { seconds: QUICK ? 9 : 13, settle: QUICK ? 6 : 9 });
    if (r.ok) { best = r; lo = mid; } else hi = mid;
  }
  return best;
}

// Straight-line longitudinal validation.
function longitudinal(mode, { from = 6, pedal = 1, seconds = 40 } = {}) {
  const car = newCar(OVAL, 200, 0, from);
  const out = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    const t = k * DT;
    const s = stepCar(car, OVAL, { steer: 0, throttle: mode === 'drive' ? pedal : 0, brake: mode === 'brake' ? pedal : 0 });
    s.t = t;
    out.push(s);
    if (mode === 'brake' && car.speed < 2.5) break;
  }
  return out;
}
const binBy = (samples, step, lo, hi, value) => {
  const bins = [];
  // ax is a first-order filtered signal (tau ~62 ms), so the first instants read
  // low; skip the warm-up or the top speed bin lies.
  const warm = samples.filter((s) => s.t > 0.35);
  for (let v0 = lo; v0 <= hi; v0 += step) {
    const w = warm.filter((s) => s.speed >= v0 && s.speed < v0 + step);
    if (w.length < 8) continue;
    bins.push({ v: +(v0 + step / 2).toFixed(1), value: +mean(w.map(value)).toFixed(3), n: w.length });
  }
  return bins;
};

// Load transfer + drag validation.
function loadTransfer() {
  const cases = [];
  const corner = (v, ayTarget) => {
    const R = (v * v) / ayTarget;
    const track = circleFor(R);
    const car = newCar(track, 0, 0, v);
    car.yawRate = v / R;
    const steer = Math.atan(SPEC.wheelbase / R) / SPEC.steeringLock;
    const out = [];
    for (let k = 0; k < Math.round(6 / DT); k++) {
      const t = k * DT;
      const err = v - car.speed;
      const s = stepCar(car, track, { steer, throttle: clamp(err * 0.08, 0, 1), brake: clamp(-err * 0.15, 0, 1) });
      if (t > 4) out.push({ ...s, t });
    }
    return out;
  };
  for (const [v, ayTarget] of [[24, 6], [40, 12]]) {
    const o = corner(v, ayTarget);
    cases.push({
      kind: 'corner', v, ayTarget, ax: mean(o.map((s) => s.ax)), ay: mean(o.map((s) => s.ay)),
      utilisation: mean(o.map((s) => s.utilisation)), q: mean(o.map((s) => s.q)),
      alphaFront: mean(o.map((s) => s.alphaFront)),
    });
  }
  for (const kind of ['brake', 'drive']) {
    const s = longitudinal(kind, { from: kind === 'brake' ? 60 : 14, pedal: 1, seconds: 3 });
    const w = s.filter((x) => x.t > 1);
    cases.push({ kind, v: mean(w.map((x) => x.speed)), ax: mean(w.map((x) => x.ax)), ay: mean(w.map((x) => x.ay)) });
  }
  return cases;
}

// Steady-state understeer from a matched step (kinematically correct steering,
// so the demand stays inside the tyre budget).
function steerTransient() {
  const out = [];
  for (const v of [20, 32, 44]) {
    for (const ayTarget of [3, 6, 9]) {
      const R = (v * v) / ayTarget;
      const track = circleFor(Math.max(40, R));
      const car = newCar(track, 0, 0, v);
      const target = Math.atan(SPEC.wheelbase / R);
      let i = 0;
      const series = [];
      for (let k = 0; k < Math.round(3 / DT); k++) {
        const t = k * DT;
        const cmd = t >= 0.5 ? target / SPEC.steeringLock : 0;
        const yawRateTarget = v / R;
        const err = yawRateTarget - car.yawRate;
        i = clamp(i + err * DT * 0.3, -0.25, 0.25);
        const speedErr = v - car.speed;
        const s = stepCar(car, track, {
          steer: clamp(cmd + (t >= 0.5 ? (err * 0.25 + i) / SPEC.steeringLock : 0), -1, 1),
          throttle: clamp(speedErr * 0.08, 0, 1), brake: clamp(-speedErr * 0.15, 0, 1),
        });
        series.push({ ...s, t });
      }
      const after = series.filter((s) => s.t >= 2.2);
      const aySteady = mean(after.map((s) => s.ay));
      let t63 = null;
      for (const s of series) if (s.t >= 0.5 && Math.abs(s.ay) >= 0.632 * Math.abs(aySteady)) { t63 = s.t - 0.5; break; }
      const kappa = mean(after.map((s) => s.yawRate)) / Math.max(2, v);
      out.push({
        v, ayTarget, radius: R, aySteady, alphaFront: mean(after.map((s) => s.alphaFront)),
        utilisation: mean(after.map((s) => s.utilisation)),
        steerActual: mean(after.map((s) => s.steerActual)),
        riseT63Ay: t63, tauAy: t63 === null ? null : +(t63 / 0.9997).toFixed(4),
        distanceToSteady: t63 === null ? null : +(t63 * v).toFixed(2),
        understeerGrad: aySteady > 0.5 ? +((target - SPEC.wheelbase * kappa) / aySteady).toFixed(6) : null,
        yawRate: mean(after.map((s) => s.yawRate)),
      });
    }
  }
  return out;
}

// --- run --------------------------------------------------------------------

const report = {
  generated: new Date().toISOString(),
  method: {
    tyre: 'prescribed-slip steady-state probe of src/sim/tyre.js (300 substeps at 480 Hz, thermal state frozen)',
    capability: 'derived from the measured tyre tables plus the plant load model (quasi-static transfer, downforce split), bisection on ay, no free scaling parameter',
    validation: 'circle-hold speed search with a feed-forward + yaw-rate PI controller, and straight-line drive/brake/coast sweeps on a 2400 m straight',
    oracle: 'src/sim/vehicle.js + src/sim/tyre.js @120 Hz',
    setup: 'gt defaults: wing 6, tc 3, abs 4, cold pressure 1.65 bar, fuel 35 kg, ambient 24 C',
  },
  tests: {},
};

console.log('tyre law tables...');
report.tests.tyre = tyreLaw();

console.log('derived lateral capability...');
report.tests.capability = [];
for (const v of [10, 20, 30, 40, 50, 60, 66]) {
  const c = latCapability(report.tests.tyre.lateral, v);
  report.tests.capability.push({
    v, latMax: +c.latMax.toFixed(2), downforceN: +c.downforce.toFixed(0),
    frontNeedN: +c.fyfNeed.toFixed(0), frontCapN: +c.fyfCap.toFixed(0),
    rearNeedN: +c.fyrNeed.toFixed(0), rearCapN: +c.fyrCap.toFixed(0),
  });
}

console.log('circle validation...');
report.tests.circle = [];
for (const R of [400, 200, 120, 80, 60, 45]) {
  const r = maxCircleSpeed(R);
  if (!r) { report.tests.circle.push({ R, ok: false }); continue; }
  const derived = latCapability(report.tests.tyre.lateral, r.speed);
  report.tests.circle.push({
    R, ok: true, v: +r.speed.toFixed(2), ayMeasured: +r.ay.toFixed(2),
    ayImpliedByRadius: +(r.speed * r.speed / R).toFixed(2),
    latMaxDerived: +derived.latMax.toFixed(2),
    ratio: +(r.ay / derived.latMax).toFixed(3),
    utilisation: +r.utilisation.toFixed(3), alphaFront: +r.alphaFront.toFixed(4),
    steerActual: +r.steerActual.toFixed(4), q: +r.q.toFixed(2), samples: r.samples,
  });
}

console.log('straight-line sweeps...');
const drive = longitudinal('drive', { from: 6, pedal: 1, seconds: 38 });
report.tests.drive = { bins: binBy(drive, 4, 6, 70, (x) => x.ax), topSpeed: +Math.max(...drive.map((x) => x.speed)).toFixed(2) };
const brake = longitudinal('brake', { from: 66, pedal: 1, seconds: 20 });
const brakeHalf = longitudinal('brake', { from: 66, pedal: 0.5, seconds: 20 });
const coast = longitudinal('coast', { from: 66, pedal: 0, seconds: 30 });
report.tests.brake = { bins: binBy(brake, 4, 4, 68, (x) => -x.ax), stopTime: +brake[brake.length - 1].t.toFixed(2), stopDistance: +(brake[brake.length - 1].s - 200).toFixed(1) };
report.tests.brakeHalf = { bins: binBy(brakeHalf, 4, 4, 68, (x) => -x.ax) };
report.tests.coast = { bins: binBy(coast, 4, 4, 68, (x) => -x.ax) };
report.tests.loadTransfer = loadTransfer();

console.log('steer transients...');
report.tests.steerTransient = steerTransient();

// Derived capability compared with the analytic envelope currently in use.
const { createEnvelope } = await import('../src/ai/global/envelope.js');
const env = createEnvelope(SPEC, { fuelKg: FUEL });
report.comparison = report.tests.capability.map((c) => {
  const analytic = env.latMax(c.v);
  return {
    v: c.v, latMaxDerived: c.latMax, latMaxAnalytic080: +analytic.toFixed(2),
    ratioDerivedOverAnalytic: +(c.latMax / analytic).toFixed(3),
  };
});
report.brakeComparison = report.tests.brake.bins.map((b) => ({
  v: b.v, decelMeasured: b.value, decelAnalytic: +env.brakeMax(b.v).toFixed(2),
  ratio: +(b.value / env.brakeMax(b.v)).toFixed(3),
}));
report.driveComparison = report.tests.drive.bins.map((b) => ({
  v: b.v, axMeasured: b.value, driveAnalytic: +env.driveMax(b.v).toFixed(2),
  ratio: b.value / Math.max(1e-6, env.driveMax(b.v)),
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

const T = report.tests;
console.log('\n== TYRE: peak |Fy| vs load (core 85 C, p cold 1.65) ==');
for (const r of T.tyre.lateral) console.log(`load=${String(r.load).padStart(4)}  FyPeak=${r.peakFy.toFixed(0).padStart(5)}  mu=${r.muPeak.toFixed(3)}  alphaAtPeak=${r.alphaAtPeakDeg}deg`);
console.log('\n== TYRE: peak |Fx| vs load ==');
for (const r of T.tyre.longitudinal) console.log(`load=${String(r.load).padStart(4)}  FxPeak=${r.peakFx.toFixed(0).padStart(5)}  mu=${r.muPeak.toFixed(3)}  kappaAtPeak=${r.kappaAtPeak}`);
console.log('\n== TYRE: temperature ==');
console.log(T.tyre.thermal.map((r) => `T=${r.core} p=${r.pressure} mu=${r.mu}`).join('\n'));
console.log('\n== TYRE: pressure ==');
console.log(T.tyre.pressureSweep.map((r) => `cold=${r.coldPressure} p=${r.pressure} mu=${r.mu}`).join('\n'));
console.log('\n== TYRE: relaxation ==');
console.log(T.tyre.relaxation.map((r) => `v=${r.vx} t63=${r.tau}s length=${r.relaxationLengthM} m`).join('\n'));
console.log('\n== DERIVED LATERAL CAPABILITY vs ANALYTIC(0.80) ==');
for (const c of report.comparison) console.log(`v=${String(c.v).padStart(2)}  derived=${String(c.latMaxDerived).padStart(5)}  analytic080=${String(c.latMaxAnalytic080).padStart(5)}  ratio=${c.ratioDerivedOverAnalytic}`);
console.log('\n== CIRCLE VALIDATION (measured / derived) ==');
for (const c of T.circle) console.log(c.ok ? `R=${String(c.R).padStart(3)}  v=${String(c.v).padStart(5)}  ay=${String(c.ayMeasured).padStart(5)}  derived=${String(c.latMaxDerived).padStart(5)}  ratio=${c.ratio}  util=${c.utilisation}  q=${c.q}` : `R=${c.R} FAILED`);
console.log('\n== BRAKE measured vs analytic ==');
for (const b of report.brakeComparison) console.log(`v=${String(b.v).padStart(2)}  measured=${b.decelMeasured}  analytic=${b.decelAnalytic}  ratio=${b.ratio}`);
console.log('\n== DRIVE measured vs analytic ==');
for (const b of report.driveComparison) console.log(`v=${String(b.v).padStart(2)}  measured=${b.axMeasured}  analytic=${b.driveAnalytic}  ratio=${b.ratio.toFixed(2)}`);
console.log(`top speed ${T.drive.topSpeed} m/s`);
console.log('\n== LOAD TRANSFER / VALIDATION ==');
console.log(JSON.stringify(T.loadTransfer, null, 1));
console.log('\n== STEER TRANSIENT ==');
for (const s of T.steerTransient) console.log(`v=${String(s.v).padStart(2)} ayTgt=${s.ayTarget} aySteady=${s.aySteady.toFixed(2)} t63=${s.riseT63Ay} dist=${s.distanceToSteady} aF=${(s.alphaFront * 180 / Math.PI).toFixed(2)}deg util=${s.utilisation.toFixed(2)} K=${s.understeerGrad}`);
console.log(`\nwrote ${OUT}`);
