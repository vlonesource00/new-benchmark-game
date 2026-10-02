import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { carSpecFor } from '../../../game/engine/sim/car-specs.js';
import baked from '../data/lines.json' with { type: 'json' };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrap = (x, n) => ((x % n) + n) % n;
const angle = x => Math.atan2(Math.sin(x), Math.cos(x));
// Only immutable geometry is shared. Every driver owns its live tyre envelope.
const geometryCache = new Map();

function geometry(base, q, curvatureSpan = 1) {
  const n = q.length, x = new Float64Array(n), z = new Float64Array(n);
  const ds = new Float64Array(n), heading = new Float64Array(n);
  const raw = new Float64Array(n), curvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = base[i].x + base[i].nx * q[i];
    z[i] = base[i].z + base[i].nz * q[i];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = wrap(i - curvatureSpan, n), b = (i + curvatureSpan) % n;
    ds[i] = Math.hypot(x[j] - x[i], z[j] - z[i]);
    const ax = x[i] - x[a], az = z[i] - z[a], bx = x[b] - x[i], bz = z[b] - z[i];
    const den = Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz);
    // heading = atan2(dx,dz); a right turn therefore has positive curvature.
    raw[i] = den > 1e-7 ? 2 * (az * bx - ax * bz) / den : 0;
    heading[i] = Math.atan2(x[b] - x[a], z[b] - z[a]);
  }
  for (let i = 0; i < n; i++) {
    curvature[i] = .25 * raw[wrap(i - 1, n)] + .5 * raw[i] + .25 * raw[(i + 1) % n];
  }
  return { x, z, ds, heading, curvature, raw };
}

function projectFootprint(base, q, halfWidth, spec, margin) {
  const bound = Math.max(0, halfWidth - margin);
  for (let i = 0; i < q.length; i++) q[i] = clamp(q[i], -bound, bound);
  // In a rapid lane transition the long body projects farther laterally than
  // its half-width. Keep that projection inside asphalt as well.
  for (let pass = 0; pass < 3; pass++) {
    const g = geometry(base, q);
    for (let i = 0; i < q.length; i++) {
      const delta = angle(g.heading[i] - base[i].heading);
      const body = spec.halfWidth * Math.abs(Math.cos(delta)) + spec.halfLength * Math.abs(Math.sin(delta));
      const allowed = Math.max(0, Math.min(bound, halfWidth - body - .15));
      q[i] = clamp(q[i], -allowed, allowed);
    }
  }
}

function softMin(a, b, distance) {
  if (distance <= 0) return Math.min(a, b);
  const h = Math.max(0, 1 - Math.abs(a - b) / distance);
  // This compact polynomial joins the linear and constant branches with
  // continuous first and second derivatives, and never crosses the bound.
  return Math.min(a, b) - distance * h ** 3 / 6;
}

function softClamp(x, min, max, distance = .35) {
  distance = Math.min(distance, (max - min) * .5);
  const lower = -softMin(-x, -min, distance);
  return softMin(lower, max, distance);
}

function minimumCurvature(base, step, halfWidth, spec, options) {
  const n = base.length, q = new Float32Array(n), next = new Float32Array(n);
  const bound = Math.max(0, halfWidth - options.margin);
  const iterations = options.smoothingIterations;
  // Projected descent of integral(k^2 ds), including the k*k0^2 term.
  // The latter matters on constant-radius bends: Laplacian/elastic shortening
  // alone would choose their shortest inside edge instead of their widest arc.
  for (let it = 0; it < iterations; it++) {
    const span = it < iterations * .55 ? Math.max(1, Math.round(20 / step)) : Math.max(1, Math.round(12 / step));
    const g = geometry(base, q, span), h = span * step, gain = .13 * h ** 4;
    for (let i = 0; i < n; i++) {
      const a = wrap(i - span, n), b = (i + span) % n;
      const gradient = (g.curvature[a] - 2 * g.curvature[i] + g.curvature[b]) / (h * h)
        + g.curvature[i] * base[i].curvature ** 2;
      const move = clamp(-gain * gradient, -.16, .16);
      const smooth = .04 * (q[wrap(i - 1, n)] + q[(i + 1) % n] - 2 * q[i]);
      next[i] = clamp(q[i] + move + smooth, -bound, bound);
    }
    q.set(next);
    if (options.projectDuringSmoothing && it % 20 === 19) projectFootprint(base, q, halfWidth, spec, options.margin);
  }
  projectFootprint(base, q, halfWidth, spec, options.margin);
  return q;
}

function tyreState(car, index) {
  return car.wheels?.[index]?.tyre ?? { core: 85, pressure: 2.15, wear: 0, gripScale: 1 };
}

function modelFor(track, car, driveSlip = .18) {
  const spec = car.spec ?? carSpecFor(car.classId);
  const setup = car.setup ?? {};
  return {
    spec, mass: spec.mass + Math.max(0, car.fuel ?? 35) * .75,
    tyres: [0, 1, 2, 3].map(i => tyreState(car, i)),
    wing: setup.wing ?? 6, bias: setup.brakeBias ?? spec.brakeBias,
    damage: clamp(car.damage ?? 0, 0, 1), wake: clamp(car.aero?.wake ?? 0, 0, .95),
    surface: (track.tempGrip ?? 1) * (1 - (track.wetness ?? 0) * .36),
    wetness: track.wetness ?? 0, driveSlip
  };
}

function forces(model, v, ay, ax) {
  const { spec: s, mass: m } = model;
  const q = .6125 * v * v;
  const pitch = Math.abs(clamp(-ax * .0028, -.06, .07));
  const nominal = q * s.area * (s.cl + (model.wing - 6) * .11) * (1 - model.wake * .16);
  let df = nominal;
  // The game compresses its aero platform by df/310000; solve that steady
  // feedback instead of assuming full nominal downforce at every speed.
  for (let i = 0; i < 7; i++) {
    const ride = .066 - df / 310000;
    const platform = clamp(1 - pitch * 1.4 - Math.max(0, .03 - ride) * 14, .55, 1);
    df = .5 * df + .5 * nominal * platform;
  }
  const transfer = clamp(ax, -22, 18) * m * s.cg / s.wheelbase;
  const lateral = clamp(ay, -25, 25) * m * s.cg / s.track;
  const front = m * 9.81 * s.frontWeight - transfer + df * s.frontAero;
  const rear = m * 9.81 * (1 - s.frontWeight) + transfer + df * (s.key === 'gt' ? .57 : 1 - s.frontAero);
  let cf = 0, cr = 0, totalLoad = 0;
  for (let i = 0; i < 4; i++) {
    const f = i < 2, side = i % 2 ? 1 : -1;
    const target = Math.max(0, (f ? front : rear) * .5 - side * lateral * (f ? .52 : .48));
    // The suspension's transient (targetCompression-compression)*16000 load
    // term vanishes at equilibrium. Do not count it as sustained tyre grip.
    const load = target;
    const cap = load * tyreGrip(model.tyres[i], load) * model.surface * s.tyreGrip;
    if (f) cf += cap; else cr += cap;
    totalLoad += load;
  }
  const drag = q * s.area * (s.cd + (model.wing - 6) * .013) * (1 - model.wake * .42) * (1 + model.damage * .2);
  return { cf, cr, resistance: drag + .013 * totalLoad };
}

function engineForce(model, speed) {
  const s = model.spec;
  let gear = 1;
  // The game's automatic gearbox shifts at 7450 rpm. Including its 0.11s
  // torque interruption as an average loss keeps long straights realistic.
  while (gear < 6 && speed / s.radius * s.gears[gear] * s.finalDrive * 9.5493 > 7450) gear++;
  const ratio = s.gears[gear] * s.finalDrive;
  const rpm = clamp(speed / s.radius * ratio * 9.5493, 2600, 8300);
  const curve = clamp(1 - ((rpm - 5500) / 6700) ** 2, .45, 1);
  return rpm > 8100 ? 0 : s.maxTorque * curve * ratio * .91 * (1 - model.damage * .28) / s.radius * .975;
}

function combinedShape(sx, sy) {
  const slip = Math.hypot(sx, sy);
  return Math.tanh(slip) * (1 - .16 * clamp((slip - 1.4) / 5, 0, 1)) / Math.max(1e-8, slip);
}

function driveCurveFor(kappa) {
  if (kappa == null) return null;
  const sx = kappa * 10.5;
  let syPeak = 0, maxLateral = 0;
  // Locate the ascending branch once per table, using the same radial tanh
  // and sliding roll-off as the game's tyreForce.
  for (let i = 1; i <= 160; i++) {
    const sy = i * .04, lateral = combinedShape(sx, sy) * sy;
    if (lateral > maxLateral) { maxLateral = lateral; syPeak = sy; }
  }
  return { sx, syPeak, maxLateral };
}

function driveForce(capacity, lateral, curve) {
  if (!curve) return Math.sqrt(Math.max(0, capacity ** 2 - lateral ** 2)) * .96;
  const ratio = Math.abs(lateral) / Math.max(1, capacity);
  // At this longitudinal slip the requested lateral force may be beyond its
  // attainable peak. Lift instead of counting an impossible ellipse reserve.
  if (ratio >= curve.maxLateral) return 0;
  let lo = 0, hi = curve.syPeak;
  for (let i = 0; i < 11; i++) {
    const sy = (lo + hi) * .5;
    if (combinedShape(curve.sx, sy) * sy < ratio) lo = sy; else hi = sy;
  }
  return capacity * combinedShape(curve.sx, (lo + hi) * .5) * curve.sx;
}

function dynamicsTable(track, car, driveSlip = .18) {
  const model = modelFor(track, car, driveSlip), s = model.spec, m = model.mass;
  const driveCurve = driveCurveFor(driveSlip);
  const maxSpeed = Math.min(100, 8080 * s.radius / (s.gears[6] * s.finalDrive * 9.5493));
  const nv = 65, na = 13, step = maxSpeed / (nv - 1);
  const lateral = new Float64Array(nv), accel = new Float64Array(nv * na), brake = new Float64Array(nv * na);
  for (let i = 0; i < nv; i++) {
    const v = i * step;
    let lo = 0, hi = 80;
    for (let j = 0; j < 13; j++) {
      const ay = (lo + hi) * .5;
      const f = forces(model, v, ay, 0), r = forces(model, v, -ay, 0);
      const capacity = Math.min(f.cf / (m * s.frontWeight), f.cr / (m * (1 - s.frontWeight)),
        r.cf / (m * s.frontWeight), r.cr / (m * (1 - s.frontWeight)));
      if (ay < capacity) lo = ay; else hi = ay;
    }
    lateral[i] = lo;
    for (let j = 0; j < na; j++) {
      const ay = lo * j / (na - 1), fyf = m * ay * s.frontWeight, fyr = m * ay * (1 - s.frontWeight);
      let a = 3, b = 10;
      for (let k = 0; k < 5; k++) {
        const f = forces(model, v, ay, a), r = forces(model, v, ay, -b);
        const oppositeDrive = ay ? forces(model, v, -ay, a) : f;
        const oppositeBrake = ay ? forces(model, v, -ay, -b) : r;
        const frontDrive = s.drive === 'front';
        // Heat and wear become asymmetric over a stint. A table built only
        // for positive ay would put a hot right tyre on the unloaded inside
        // during the left bends where it is actually the loaded outer tyre.
        const driveCapacity = frontDrive ? Math.min(f.cf, oppositeDrive.cf) : Math.min(f.cr, oppositeDrive.cr);
        const driveGrip = driveForce(driveCapacity, frontDrive ? fyf : fyr, driveCurve);
        const nextA = (Math.min(engineForce(model, v), driveGrip) - Math.max(f.resistance, oppositeDrive.resistance)) / m;
        const frontCapacity = Math.min(r.cf, oppositeBrake.cf), rearCapacity = Math.min(r.cr, oppositeBrake.cr);
        const bf = Math.sqrt(Math.max(0, frontCapacity * frontCapacity - fyf * fyf));
        const br = Math.sqrt(Math.max(0, rearCapacity * rearCapacity - fyr * fyr));
        const bfLimit = Math.min(2 * s.brakeTorque * model.bias / s.radius, bf * .96);
        const brLimit = Math.min(2 * s.brakeTorque * (1 - model.bias) / s.radius, br * .96);
        // Independent wheel ABS can reduce pressure on one axle while the
        // other still brakes. Both axle limits nevertheless remain explicit.
        const nextB = (bfLimit + brLimit + Math.max(r.resistance, oppositeBrake.resistance)) / m;
        a = .5 * a + .5 * nextA; b = .5 * b + .5 * nextB;
      }
      accel[i * na + j] = a;
      brake[i * na + j] = b;
    }
  }
  return { model, nv, na, step, maxSpeed, lateral, accel, brake };
}

function curveSample(array, speed, table) {
  const f = clamp(speed / table.step, 0, table.nv - 1), i = Math.min(table.nv - 2, Math.floor(f));
  return array[i] + (array[i + 1] - array[i]) * (f - i);
}

function longitudinal(table, speed, lateral, braking) {
  const f = clamp(speed / table.step, 0, table.nv - 1), i = Math.min(table.nv - 2, Math.floor(f));
  const lat = Math.max(.1, curveSample(table.lateral, speed, table));
  const g = clamp(lateral / lat, 0, 1) * (table.na - 1), j = Math.min(table.na - 2, Math.floor(g));
  const a = braking ? table.brake : table.accel, p = i * table.na + j, t = g - j;
  const low = a[p] + (a[p + 1] - a[p]) * t;
  const high = a[p + table.na] + (a[p + table.na + 1] - a[p + table.na]) * t;
  return low + (high - low) * (f - i);
}

function speedEnvelope(g, table, gripUse, gripRatio = null, brakeReserve = 1) {
  const n = g.ds.length, speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(g.curvature[i]), ratio = gripRatio?.[i] ?? 1;
    let lo = 3, hi = table.maxSpeed;
    for (let j = 0; j < 12; j++) {
      const v = (lo + hi) * .5;
      if (v * v * k <= curveSample(table.lateral, v, table) * gripUse * ratio) lo = v; else hi = v;
    }
    speed[i] = lo;
  }
  // Periodic passes propagate constraints across the finish line. Work with
  // actual Cartesian segment lengths, rather than the centreline s interval.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, v = speed[i], ratio = gripRatio?.[i] ?? 1;
      const ay = v * v * Math.abs(g.curvature[i]) / ratio;
      const a = longitudinal(table, v, ay, false) * ratio;
      speed[j] = Math.min(speed[j], Math.sqrt(Math.max(9, v * v + 2 * a * g.ds[i])));
    }
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n, v = speed[j], ratio = gripRatio?.[j] ?? 1;
      // Evaluate the ellipse where braking finishes, when corner demand is
      // greatest. The preceding sample is solved by the cyclic backward pass.
      const ay = v * v * Math.max(Math.abs(g.curvature[i]), Math.abs(g.curvature[j])) / ratio;
      const b = Math.max(.2, longitudinal(table, v, ay, true) * ratio) * brakeReserve;
      speed[i] = Math.min(speed[i], Math.sqrt(v * v + 2 * b * g.ds[i]));
    }
  }
  let time = 0;
  for (let i = 0; i < n; i++) time += 2 * g.ds[i] / Math.max(1, speed[i] + speed[(i + 1) % n]);
  return { speed, time };
}

function kerbRatios(base, q, g, track, spec) {
  const ratios = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) {
    const delta = angle(g.heading[i] - base[i].heading);
    let grip = 1;
    for (const side of [-1, 1]) for (const axle of [0, 1]) {
      const wheelZ = spec.wheelbase * (axle === 0 ? 1 - spec.frontWeight : -spec.frontWeight);
      const lateral = Math.abs(q[i] + side * spec.track * .5 * Math.cos(delta) + wheelZ * Math.sin(delta));
      grip = Math.min(grip, lateral < track.halfWidth ? 1
        : lateral < track.halfWidth + track.curbWidth ? .88 : .42);
    }
    ratios[i] = grip;
  }
  return ratios;
}

function optimize(base, step, track, spec, options) {
  const nominal = { spec, classId: spec.key, setup: { wing: options.wing, brakeBias: spec.brakeBias }, fuel: 35 };
  const table = dynamicsTable({ wetness: 0, tempGrip: 1 }, nominal, options.driveSlip);
  const width = track.halfWidth + (options.kerbUse ?? 0);
  const seed = minimumCurvature(base, step, width, spec, options);
  let best = new Float32Array(base.length), bestGeometry = geometry(base, best, options.curvatureSpan);
  const ratios = (q, g) => options.kerbUse > 0 ? kerbRatios(base, q, g, track, spec) : null;
  let bestTime = speedEnvelope(bestGeometry, table, .94, ratios(best, bestGeometry)).time;
  const evaluate = q => {
    projectFootprint(base, q, width, spec, options.margin);
    const g = geometry(base, q, options.curvatureSpan), result = speedEnvelope(g, table, .94, ratios(q, g));
    if (result.time < bestTime - .00001) {
      best = q; bestGeometry = g; bestTime = result.time; return true;
    }
    return false;
  };
  // Entry and exit phase are judged by total lap time, which rewards exit
  // speed before a long straight rather than merely minimum local curvature.
  for (const scale of [.7, 1, 1.2]) for (const shift of [-12, 0, 12]) {
    const q = new Float32Array(base.length), offset = shift / step;
    for (let i = 0; i < q.length; i++) {
      const t = wrap(i + offset, q.length), a = Math.floor(t), b = (a + 1) % q.length;
      q[i] = scale * (seed[a] + (seed[b] - seed[a]) * (t - a));
    }
    evaluate(q);
  }
  for (let pass = 0; pass < options.optimizerIterations; pass++) {
    for (const width of options.optimizerWidths) {
      const sigma = width / step, reach = Math.ceil(2.5 * sigma), amplitude = width >= 60 ? .8 : width >= 30 ? .5 : width >= 15 ? .3 : .18;
      for (let bin = 0; bin < options.optimizerBins; bin++) {
        const center = Math.floor((bin + .5 * (pass % 2)) * base.length / options.optimizerBins);
        for (const direction of [-1, 1]) {
          const q = new Float32Array(best);
          for (let j = -reach; j <= reach; j++) q[wrap(center + j, q.length)] += direction * amplitude * Math.exp(-.5 * (j / sigma) ** 2);
          evaluate(q);
        }
      }
    }
  }
  return { q: best, geometry: bestGeometry, estimatedLapTime: bestTime };
}

export class RacingPath {
  constructor(track, options = {}) {
    this.track = track;
    this.length = track.length;
    // Reserve affects live braking feasibility only; canonical geometric
    // optimization and its cache remain the same for every driver.
    this.brakeReserve = clamp(options.brakeReserve ?? 1, .5, 1);
    this.brakeWearReserve = clamp(options.brakeWearReserve ?? 0, 0, .35);
    this.liveBrakeReserve = this.brakeReserve;
    this.n = Math.max(64, Math.ceil(track.length / (options.spacing ?? 4)));
    this.step = this.length / this.n;
    const spec = options.spec ?? options.car?.spec ?? carSpecFor(options.classId);
    const settings = {
      modelVersion: 2,
      margin: Math.max(1.15, options.margin ?? 1.2), wing: options.wing ?? options.car?.setup?.wing ?? 6,
      // false reproduces the former peak-ellipse model for bounded ablations.
      // .18 lies near peak drive force in the upgraded game tyre model.
      driveSlip: options.driveSlip === false ? null : clamp(options.driveSlip ?? .18, .02, .25),
      smoothingIterations: clamp(Math.floor(options.smoothingIterations ?? 600), 0, 2400),
      projectDuringSmoothing: Boolean(options.projectDuringSmoothing),
      curvatureSpan: clamp(Math.round(options.curvatureSpan ?? 1), 1, 8),
      optimizerIterations: clamp(Math.floor(options.optimizerIterations ?? 4), 0, 20),
      optimizerWidths: (options.optimizerWidths ?? [60, 30, 15]).filter(w => Number.isFinite(w) && w >= 4 && w <= 200).slice(0, 8),
      optimizerBins: clamp(Math.floor(options.optimizerBins ?? 64), 1, 160)
    };
    this.driveSlip = settings.driveSlip;
    this.curvatureSpan = settings.curvatureSpan;
    this.variantSpan = clamp(Math.round(options.variantSpan ?? this.curvatureSpan), 1, 8);
    this.spec = spec;
    this.margin = settings.margin;
    this.kerbUse = clamp(options.kerbUse ?? 0, 0, Math.max(0, (track.curbWidth ?? 0) - .2));
    this.drivableHalfWidth = track.halfWidth + this.kerbUse;
    if (this.kerbUse > 0) settings.kerbUse = this.kerbUse;
    // Include public geometry, not just the circuit label, to avoid collisions
    // between different tracks with the same display ID.
    const p0 = track.at(0), pm = track.at(track.length * .37);
    const key = `${track.id}:${track.length.toFixed(5)}:${track.halfWidth}:${p0.x}:${p0.z}:${pm.x}:${pm.z}:${spec.key}:${this.n}:${JSON.stringify(settings)}`;
    this.geometryKey = key;
    let cached = options.unbaked ? null : geometryCache.get(key);
    this.geometrySource = cached ? 'memory' : 'computed';
    if (!cached) {
      const base = Array.from({ length: this.n }, (_, i) => track.at(i * this.step));
      const record = !options.unbaked && baked.version === 1
        ? baked.lines.find(line => line.key === key && line.offsets.length === this.n && line.offsets.every(Number.isFinite)) : null;
      let result;
      if (record) {
        this.geometrySource = 'baked';
        const q = new Float32Array(record.offsets);
        result = { q, geometry: geometry(base, q, this.curvatureSpan), estimatedLapTime: record.estimatedLapTime };
      } else result = optimize(base, this.step, track, spec, settings);
      cached = { ...result, base };
      geometryCache.set(key, cached);
    }
    // Positive phase advances the line's offsets: q(s) becomes q(s + phase).
    // Keep canonical optimization cached independently of this bounded ablation.
    this.phaseShift = Number.isFinite(options.phaseShift) ? clamp(options.phaseShift, -30, 30) : 0;
    if (this.phaseShift !== 0) {
      const phaseKey = `${key}:phase:${this.phaseShift}`;
      let shifted = geometryCache.get(phaseKey);
      if (!shifted) {
        const q = new Float32Array(this.n), offset = this.phaseShift / this.step;
        for (let i = 0; i < this.n; i++) {
          const p = wrap(i + offset, this.n), a = Math.floor(p), b = (a + 1) % this.n;
          q[i] = cached.q[a] + (cached.q[b] - cached.q[a]) * (p - a);
        }
        projectFootprint(cached.base, q, this.drivableHalfWidth, spec, settings.margin);
        const g = geometry(cached.base, q, this.curvatureSpan);
        const nominal = { spec, classId: spec.key, setup: { wing: settings.wing, brakeBias: spec.brakeBias }, fuel: 35 };
        const table = dynamicsTable({ wetness: 0, tempGrip: 1 }, nominal, settings.driveSlip);
        shifted = { base: cached.base, q, geometry: g, estimatedLapTime: speedEnvelope(g, table, .94,
          this.kerbUse > 0 ? kerbRatios(cached.base, q, g, track, spec) : null).time };
        geometryCache.set(phaseKey, shifted);
      }
      cached = shifted;
    }
    this.q = new Float32Array(cached.q);
    this.base = cached.base;
    this.geometry = cached.geometry;
    this.estimatedLapTime = cached.estimatedLapTime;
    this.points = Array.from({ length: this.n }, (_, i) => Object.freeze({
      x: this.geometry.x[i], z: this.geometry.z[i], s: i * this.step, offset: this.q[i],
      heading: this.geometry.heading[i], curvature: this.geometry.curvature[i], index: i
    }));
    this.speed = null;
    this.laneEnvelopes = new Map();
    this.variantGeometries = new Map();
    this.variantEnvelopes = new Map();
  }

  sample(array, s) {
    const p = wrap(s, this.length) / this.step, i = Math.floor(p), j = (i + 1) % this.n;
    return array[i] + (array[j] - array[i]) * (p - i);
  }

  variant(extra = 0, bounds = null, span = this.variantSpan) {
    const edge = Math.max(0, this.drivableHalfWidth - this.margin);
    extra = Number.isFinite(extra) ? Math.round(clamp(extra, -2 * edge, 2 * edge) * 4) / 4 : 0;
    if (extra === 0 && bounds == null) {
      return Object.freeze({ q: this.q, geometry: this.geometry, speed: this.speed,
        extra: 0, bounds: null, key: 'base', estimatedLapTime: this.estimatedLapTime });
    }
    let min = -edge, max = edge;
    if (bounds != null) {
      const lo = clamp(Number.isFinite(bounds.min) ? bounds.min : -edge, -edge, edge);
      const hi = clamp(Number.isFinite(bounds.max) ? bounds.max : edge, -edge, edge);
      // Quantize inward so a cached corridor cannot extend outside the request.
      min = Math.ceil(lo * 4 - 1e-9) / 4;
      max = Math.floor(hi * 4 + 1e-9) / 4;
      if (min > max) min = max = clamp((lo + hi) * .5, -edge, edge);
    }
    const key = `${extra}:${bounds == null ? '*' : `${min}:${max}`}:${span}`;
    let entry = this.variantGeometries.get(key);
    if (entry) {
      this.variantGeometries.delete(key);
      this.variantGeometries.set(key, entry);
    } else {
      const q = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) q[i] = softClamp(this.q[i] + extra, min, max);
      // Road/body safety takes precedence if a proposed edge corridor cannot
      // fit the projected body. Geometry, never a parallel-line approximation,
      // describes the final clamped line.
      projectFootprint(this.base, q, this.drivableHalfWidth, this.spec, this.margin);
      entry = Object.freeze({ q, geometry: Object.freeze(geometry(this.base, q, span)), extra,
        bounds: bounds == null ? null : Object.freeze({ min, max }), key });
      this.variantGeometries.set(key, entry);
      if (this.variantGeometries.size > 64) {
        const oldest = this.variantGeometries.keys().next().value;
        this.variantGeometries.delete(oldest);
        this.variantEnvelopes.delete(oldest);
      }
    }
    let envelope = this.variantEnvelopes.get(key);
    if (!envelope && this.table) {
      envelope = speedEnvelope(entry.geometry, this.table, this.gripUse,
        this.gripRatios(entry.q, entry.geometry), this.liveBrakeReserve);
      this.variantEnvelopes.set(key, envelope);
    }
    return Object.freeze({ ...entry, speed: envelope?.speed ?? null,
      estimatedLapTime: envelope?.time ?? null });
  }

  variantEnvelope(extra = 0, bounds = null, span = this.variantSpan) {
    return this.variant(extra, bounds, span).speed;
  }

  at(s, extra = 0, bounds = null, span = this.variantSpan) {
    s = wrap(s, this.length);
    const variant = this.variant(extra, bounds, span), g = variant.geometry;
    const p = s / this.step, i = Math.floor(p), j = (i + 1) % this.n, t = p - i;
    const a = this.base[i], b = this.base[j];
    let nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t;
    const norm = Math.hypot(nx, nz); nx /= norm; nz /= norm;
    const heading = g.heading[i] + angle(g.heading[j] - g.heading[i]) * t;
    const result = {
      x: this.sample(g.x, s), z: this.sample(g.z, s),
      s, offset: this.sample(variant.q, s), heading: angle(heading),
      curvature: this.sample(g.curvature, s), index: i,
      tx: Math.sin(heading), tz: Math.cos(heading), nx, nz
    };
    if (variant.speed) result.speed = this.sample(variant.speed, s);
    return result;
  }

  rebuildEnvelope(car, gripUse = .90) {
    const table = dynamicsTable(this.track, car, this.driveSlip);
    this.table = table;
    this.gripUse = clamp(gripUse, .4, .99);
    const wear = Math.max(...car.wheels.map(w => w.tyre.wear));
    this.liveBrakeReserve = this.brakeReserve * (1 - this.brakeWearReserve * clamp((wear - .12) / .6, 0, 1));
    this.laneEnvelopes.clear();
    this.variantEnvelopes.clear();
    const result = speedEnvelope(this.geometry, table, this.gripUse, this.gripRatios(this.q, this.geometry), this.liveBrakeReserve);
    this.speed = result.speed;
    this.estimatedLapTime = result.time;
    return this.speed;
  }

  gripRatios(offsets, g) {
    const ratios = new Float32Array(this.n), table = this.table;
    const track = this.track, baseline = Math.max(.05, table.model.surface), halfTrack = table.model.spec.track * .5;
    for (let i = 0; i < this.n; i++) {
      let rubber = 0;
      if (track.rubber && track.laneAt) {
        const index = this.base[i].index, laneA = track.laneAt(offsets[i] - halfTrack), laneB = track.laneAt(offsets[i] + halfTrack);
        rubber = .5 * ((track.rubber[index * 13 + laneA] ?? 0) + (track.rubber[index * 13 + laneB] ?? 0));
      }
      // Track.surface's lane grip, without expensive nearest-point searches.
      const surface = (track.tempGrip ?? 1) * (1 + rubber * .10) * (1 - table.model.wetness * (.36 + rubber * .2));
      ratios[i] = Math.max(.25, surface / baseline);
    }
    if (this.kerbUse > 0) {
      const kerbs = kerbRatios(this.base, offsets, g, track, this.spec);
      for (let i = 0; i < this.n; i++) ratios[i] *= kerbs[i];
    }
    return ratios;
  }

  laneEnvelope(offset, span = this.variantSpan) {
    if (offset == null || !this.table) return this.speed;
    // Quantized caching avoids rebuilding a dynamics table while a lane
    // changes. The braking pass uses this lane's actual arc and curvature.
    const q = Math.round(offset * 4) / 4;
    const key = `${q}:${span}`;
    if (!this.laneEnvelopes.has(key)) {
      const offsets = new Float32Array(this.n).fill(q);
      const g = geometry(this.base, offsets, span);
      this.laneEnvelopes.set(key, speedEnvelope(g, this.table, this.gripUse,
        this.gripRatios(offsets, g), this.liveBrakeReserve).speed);
    }
    return this.laneEnvelopes.get(key);
  }
}
