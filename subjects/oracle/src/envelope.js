// ORACLE's car envelope, measured on the game's own Vehicle rather than guessed.
//
// Before racing, each class is driven on a flat, endless test pad with exactly the physics every car uses:
// a full-throttle run gives drive acceleration against speed, a full-brake run (ABS on) gives braking,
// and steady-speed steering ramps give the peak lateral acceleration at each speed. The tables are
// per-metre-per-second bins, cached per class for the whole session.
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { clamp } from '../../../game/engine/sim/math.js';

export const VMAX = 100;
const DT = 1 / 120, cache = new Map(), STEER_BINS = 24;

/** Flat asphalt with no edges: the same surface record `Track.surface` returns on a clean dry road. */
const PAD = {
  ambient: 24, barrierOffset: 1e9, pitWall: null,
  surface: (x, z) => ({ s: z, lateral: x, index: 0, zone: 'asphalt', pit: false, rubber: 0, water: 0, wet: 0, wetLoss: 0, grip: 1, bump: 0, resistance: 0.013 }),
  deposit: () => 0
};

function testCar(classId, fuel) {
  const car = new Vehicle(0, 'PAD', '#fff', classId);
  car.setup.fuel = fuel; car.resetState();
  for (const w of car.wheels) { w.tyre.core = 92; w.tyre.surface = 96; w.tyre.optimum = 90; }
  return car;
}
// Launched in the gear a driver would hold at that speed: the gearbox refuses an upshift past 8100 rpm, so a car
// started in first at 40 m/s would sit on the limiter, engine-braking the rear through the whole test.
const launch = (car, v) => {
  car.vz = v; car.u = v; car.speed = v; car.vx = 0; car.yaw = 0; car.yawRate = 0; for (const w of car.wheels) w.omega = v / car.spec.radius;
  const S = car.spec, rpm = (g) => v / S.radius * S.gears[g] * S.finalDrive * 9.5493;
  let g = 1; while (g < S.gears.length - 1 && rpm(g) > 7000) g++;
  car.gear = g; car.rpm = clamp(rpm(g), 1100, 8300);
};
/** GTP deploys its rear motor on full throttle; the pad gives it the race-mode figure. */
const hybrid = (car, throttle) => { car.hybridForce = car.spec.key === 'lmdh' && throttle > 0.8 && car.speed > 14 ? 85000 / Math.max(14, car.speed) : 0; };

function longitudinal(classId, fuel) {
  // Bin averages, not peaks: a gear change or an ABS pulse must not set the figure the profile plans on.
  const acc = new Float64Array(VMAX + 1), accN = new Float64Array(VMAX + 1), brk = new Float64Array(VMAX + 1), brkN = new Float64Array(VMAX + 1);
  let car = testCar(classId, fuel); launch(car, 6);
  let top = 0;
  for (let t = 0; t < 140; t += DT) {
    const v0 = car.u; car.controls = { throttle: 1, brake: 0, steer: 0 }; hybrid(car, 1); car.step(DT, PAD);
    const b = Math.round(v0); if (b <= VMAX) { acc[b] += (car.u - v0) / DT; accN[b]++; }
    top = Math.max(top, car.u); car.fuel = fuel;
  }
  for (let start = 30; start <= Math.floor(top); start += 10) {
    car = testCar(classId, fuel); launch(car, start);
    for (let t = 0; t < 2.5 && car.u > 5; t += DT) {
      const v0 = car.u; car.controls = { throttle: 0, brake: 1, steer: 0 }; car.hybridForce = 0; car.step(DT, PAD);
      if (t > 0.35) { const b = Math.round(v0); if (b <= VMAX) { brk[b] += (v0 - car.u) / DT; brkN[b]++; } }
    }
  }
  const accel = acc.map((x, i) => (accN[i] ? Math.max(0, x / accN[i]) : 0)), brake = brk.map((x, i) => (brkN[i] ? x / brkN[i] : 0));
  fill(accel); fill(brake);
  return { accel, brake, top };
}

/**
 * Peak steady lateral acceleration at speed v. The pad is a treadmill: speed is held exactly (so drag and
 * cornering drag cannot end the test early) while the steering winds on slowly; the reading is the chassis's
 * own lateral force over mass, taken before the body slip passes 0.2 rad (these cars run 0.15–0.2 rad at the limit).
 */
function lateralAt(classId, fuel, v) {
  const car = testCar(classId, fuel); launch(car, v);
  let best = 0, steer = 0;
  for (let t = 0; t < 70; t += DT) {
    steer = Math.min(1, steer + 0.006 * DT);
    car.controls = { throttle: 0, brake: 0, steer }; car.hybridForce = 0; car.step(DT, PAD);
    const speed = Math.hypot(car.vx, car.vz); car.vx *= v / speed; car.vz *= v / speed; car.fuel = fuel;
    if (Math.abs(Math.atan2(car.v, Math.max(2, car.u))) > 0.2) break;
    best = Math.max(best, Math.abs(car.ay));
  }
  return best;
}

/**
 * The car's steady cornering response at speed v: wheel angle and body slip at each share of the peak lateral
 * acceleration. Same treadmill ramp, but the throttle holds the speed the way a steady corner does (against drag and
 * the tyres' cornering drag), so the rear carries the drive it carries in a real corner; the treadmill only takes
 * out what the throttle could not (a coasting pad engine-brakes the rear and reads as oversteer).
 */
function responseAt(classId, fuel, v) {
  const car = testCar(classId, fuel); launch(car, v);
  const rec = [];
  let best = 0, steer = 0, thr = 0.2, ia = 0;
  for (let t = 0; t < 70; t += DT) {
    steer = Math.min(1, steer + 0.006 * DT);
    const u0 = Math.hypot(car.vx, car.vz);
    car.controls = { throttle: thr, brake: 0, steer }; hybrid(car, thr); car.step(DT, PAD);
    const acc = (Math.hypot(car.vx, car.vz) - u0) / DT; ia += acc * DT; thr = clamp(thr - (acc * 0.02 + ia * 0.05) * DT * 10, 0, 1);
    const speed = Math.hypot(car.vx, car.vz); car.vx *= v / speed; car.vz *= v / speed; car.fuel = fuel;
    const beta = Math.abs(Math.atan2(car.v, Math.max(2, car.u)));
    if (beta > 0.2 || steer >= 1) break;
    best = Math.max(best, Math.abs(car.ay)); rec.push([Math.abs(car.ay), Math.abs(car.steering), beta]);
  }
  // Monotone in lateral acceleration: the first time each share of the peak is reached.
  const d = new Float64Array(STEER_BINS + 1), b = new Float64Array(STEER_BINS + 1);
  for (let k = 1, j = 0; k <= STEER_BINS; k++) {
    const want = best * k / STEER_BINS;
    while (j < rec.length - 1 && rec[j][0] < want) j++;
    const [a1, d1, b1] = rec[j], [a0, d0, b0] = rec[Math.max(0, j - 1)], u = a1 > a0 ? clamp((want - a0) / (a1 - a0), 0, 1) : 1;
    d[k] = d0 + (d1 - d0) * u; b[k] = b0 + (b1 - b0) * u;
  }
  return { v, peak: best, d, b };
}

function fill(table) {
  let last = 0;
  for (let i = 0; i < table.length; i++) if (table[i] > 0) last = table[i]; else table[i] = last;
  for (let i = table.length - 1, next = last; i >= 0; i--) if (table[i] > 0) next = table[i]; else table[i] = next;
}

/** Envelope of one class: accel(v), brake(v), lat(v) in m/s², plus top speed and the reference tyre grip. */
export function envelope(classId, fuel = 50) {
  const key = `${classId}:${fuel}`;
  if (cache.has(key)) return cache.get(key);
  const lon = longitudinal(classId, fuel), lat = new Float64Array(VMAX + 1), probes = [];
  const steer = [];
  for (let v = 10; v <= Math.min(VMAX, lon.top + 2); v += 6) { probes.push([v, lateralAt(classId, fuel, v)]); steer.push(responseAt(classId, fuel, v)); }
  // Between probes the grip grows with downforce (∝ v²): interpolate a + b·v² piecewise.
  for (let i = 0; i <= VMAX; i++) {
    // Below the second probe the steering lock, not grip, ends the test: hold the low-speed reading.
    if (i <= probes[1][0]) { lat[i] = probes[1][1]; continue; }
    const k = probes.findIndex(([v]) => v >= i);
    if (k <= 0) { lat[i] = probes[k < 0 ? probes.length - 1 : 0][1]; continue; }
    const [v0, a0] = probes[k - 1], [v1, a1] = probes[k], u = (i * i - v0 * v0) / (v1 * v1 - v0 * v0);
    lat[i] = a0 + (a1 - a0) * u;
  }
  const ref = testCar(classId, fuel), refGrip = tyreGrip(ref.wheels[0].tyre, ref.spec.mass * 9.81 / 4);
  const env = { classId, fuel, accel: lon.accel, brake: lon.brake, lat, top: lon.top, refGrip, probes, steer, wheelbase: ref.spec.wheelbase };
  cache.set(key, env);
  return env;
}

export const at = (table, v) => { const x = clamp(v, 0, VMAX), i = Math.min(VMAX - 1, Math.floor(x)), f = x - i; return table[i] * (1 - f) + table[i + 1] * f; };

/**
 * Steady wheel angle (rad, signed like ay) that holds lateral acceleration ay at speed v, and the body slip that
 * goes with it, from the pad's ramps. Between probe speeds both are blended; asked past the peak, the peak's angle.
 * Below the first probe the turn is kinematic (the wheel points along the arc). Body slip comes back with the sign
 * of the lateral velocity, opposite to ay.
 */
export function steadySteer(env, ay, v) {
  const t = env.steer, s = Math.sign(ay), a = Math.abs(ay);
  const read = (p, x) => { const u = clamp(x / Math.max(1e-6, p.peak), 0, 1) * STEER_BINS, k = Math.min(STEER_BINS - 1, Math.floor(u)), f = u - k; return [p.d[k] * (1 - f) + p.d[k + 1] * f, p.b[k] * (1 - f) + p.b[k + 1] * f]; };
  if (v <= t[0].v) { const vv = Math.max(1, v); return { delta: s * Math.atan(env.wheelbase * a / (vv * vv)), beta: 0 }; }
  let j = t.findIndex((p) => p.v >= v); if (j < 0) j = t.length - 1;
  const p0 = t[Math.max(0, j - 1)], p1 = t[j], u = p1.v > p0.v ? clamp((v - p0.v) / (p1.v - p0.v), 0, 1) : 1;
  // Shares of each probe's own peak, so the blend never reads one probe past its limit.
  const peak = p0.peak + (p1.peak - p0.peak) * u, x = a / Math.max(1e-6, peak);
  const [d0, b0] = read(p0, x * p0.peak), [d1, b1] = read(p1, x * p1.peak);
  // The kinematic part (L·ay/v²) changes with speed inside the bin: scale each probe's angle to this speed's share.
  const L = env.wheelbase, k0 = L * x * p0.peak / (p0.v * p0.v), k1 = L * x * p1.peak / (p1.v * p1.v), kv = L * a / (v * v);
  const e0 = d0 - k0, e1 = d1 - k1;
  return { delta: s * (kv + e0 + (e1 - e0) * u), beta: -s * (b0 + (b1 - b0) * u) };
}
