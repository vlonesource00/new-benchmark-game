import { PaceLine, surfaceProfile, wetLineGen } from './surface.js';
import { liveGrip } from '../../apex/src/model.js';
import { VanguardModel as CarModel } from './model.js';
import lines from '../../apex/data/lines.json' with { type: 'json' };
import ownCourses from '../../intercept/data/courses.json' with { type: 'json' };
import { tyreWet } from '../../../game/engine/sim/water.js';
import { clamp, angle, join, ease, gap } from './math.js';
import { HeldPredictor } from './predict.js';
import { tacticalHorizon } from './trajectory.js';

/** Three bounded box passes approximate a Gaussian smoothing kernel in O(n) time. */
function softenOffsets(values, radius) {
  radius = Math.max(1, Math.min(12, Math.round(radius)));
  const scratch = new Float64Array(values.length), last = values.length - 1;
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += values[clamp(k, 0, last)];
    for (let j = 0; j <= last; j++) {
      scratch[j] = sum / (radius * 2 + 1);
      sum += values[Math.min(last, j + radius + 1)] - values[Math.max(0, j - radius)];
    }
    values.set(scratch);
  }
}

export class Course {
  constructor(track, options) {
    this.track = track;
    this.options = options;
    this.clock = 99;
    this.pool = [];
  }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId;
    const baked = this.options.courses?.[this.track.id]?.[car.classId] ??
      ownCourses[this.track.id]?.[car.classId] ??
      lines[this.track.id]?.[car.classId];
    this.model = new CarModel(car.classId);
    this.model.margin = this.options.margin;
    this.model.jerk = this.options.jerk;
    this.line = new PaceLine(this.track, { ds: baked?.ds ?? 3, edge: -0.55 });
    if (!this.line.load(baked ? { ds: baked.ds, px: baked.px, pz: baked.pz } : null)) {
      this.line.seed(500);
      this.line.optimise(this.model, { iterations: 2000, seed: 7 });
    }
    this.line.dryGeometry = {};
    for (const k of ['px', 'pz', 'lat', 'st', 'h', 'ks']) this.line.dryGeometry[k] = this.line[k].slice();
    this.refresh(car, true);
    this.pool = Array.from({ length: this.options.maxCandidates ?? 8 }, () => {
      const path = this.line.blankLane();
      path.st = this.line.st.slice();
      return { path, window: null };
    });
  }
  grip(car) {
    return liveGrip(car).grip * (1 - 0.36 * tyreWet(this.track, car)) * (this.track.tempGrip ?? 1);
  }
  brakeExponent(car) {
    const nominal = this.options.brakeExp ?? 2;
    const reduced = (this.track.water?.live && this.track.wetness > 0.03) ||
      car.wheels.some(w => w.tyre.wear >= 0.4);
    // Dry reference GGV tables overestimate simultaneous braking and turning
    // on GT wet/worn tyres. Reserve more lateral force in the forecast, so the
    // live axle allocator is not forced to rescue a late braking profile.
    return reduced ? Math.min(nominal, this.options.reducedGripBrakeExp ?? nominal) : nominal;
  }
  refresh(car, force = false, allowance = 1) {
    const g = this.grip(car), m = this.options.margin * allowance;
    const damage = car.damage ?? 0, damageChanged = Math.abs(damage - (this.profileDamage ?? 0)) > 0.002;
    this.model.setDamage(damage);
    const brakeExp = this.brakeExponent(car);
    const wet = this.track.water?.live ? this.track.wetness : 0;
    const wetChanged = Math.abs(wet - (this.surfaceWetness ?? 0)) > 0.004 ||
      (wet > 0.015) !== Boolean(this.surface?.active) || ((wet > 0.015 || this.wetMorphing) && this.surfaceAge >= 1);
    if (!force && !this.profileDirty && !damageChanged && !wetChanged && brakeExp === this.profileBrakeExp && Math.abs(g - this.model.grip) < 0.007 && Math.abs(m - this.model.margin) < 0.004) return;
    this.model.grip = g;
    this.model.margin = m;
    const o = { mass: car.spec.mass + car.fuel * 0.75, brakeExp };
    if (force) {
      this.profileDamage = damage;
      this.profileBrakeExp = brakeExp;
      this.profileDirty = false;
      this.surface = surfaceProfile(this.line, this.track, car, this.options);
      this.surfaceWetness = this.track.wetness;
      this.surfaceAge = 0;
      this.estimate = this.line.speeds(this.model, o); return;
    }
    if (this.rebuild) return;
    this.profileDamage = damage;
    this.profileBrakeExp = brakeExp;
    this.profileDirty = false;
    const shadow = Object.create(this.line);
    for (const k of ['v', 'vmax', 'vbrk', 'vfree', 'cap']) shadow[k] = this.line[k].slice();
    for (const k of ['trim', 'btrim', 'surfaceCaps']) shadow[k] = this.line[k].slice();
    const morph = !this.options.executor && this.options.wetLine !== false && this.cleanAir &&
      (wet > 0.03 || this.line.wetOffsets.some(v => Math.abs(v) > 1e-4));
    const geometryKeys = morph ? ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'st', 'surfaceNodes', 'wetOffsets'] : [];
    for (const k of geometryKeys) shadow[k] = this.line[k].slice();
    const elapsed = this.surfaceAge ?? 1;
    this.surfaceWetness = this.track.wetness;
    this.surfaceAge = 0;
    shadow.kept = [...this.line.kept];
    this.rebuild = { shadow, geometryKeys, gen: this.profileGen(shadow, car, o, morph, elapsed) };
  }
  *profileGen(shadow, car, options, morph, elapsed) {
    const model = Object.assign(Object.create(Object.getPrototypeOf(this.model)), this.model);
    if (!morph) {
      this.surface = surfaceProfile(shadow, this.track, car, this.options);
      return yield* shadow.speedsGen(model, options);
    }
    const track = Object.create(this.track);
    track.wetness = this.track.wetness; track.rubber = this.track.rubber.slice();
    if (this.track.water) {
      track.water = Object.create(this.track.water); track.water.depth = this.track.water.depth.slice();
    }
    const state = { spec: car.spec, wheels: car.wheels.map(w => ({ tyre: { ...w.tyre } })) };
    const baseline = Object.create(this.line);
    for (const k of ['v', 'vmax', 'vbrk', 'vfree', 'cap', 'trim', 'btrim', 'surfaceCaps']) baseline[k] = this.line[k].slice();
    baseline.kept = [...this.line.kept];
    const baseSurface = surfaceProfile(baseline, track, state, this.options);
    const baseTime = yield* baseline.speedsGen(model, options);
    const choice = yield* wetLineGen(shadow, track, state, model, elapsed);
    const candidateSurface = surfaceProfile(shadow, track, state, this.options);
    const candidateTime = yield* shadow.speedsGen(model, options);
    const accepted = choice.changed && candidateTime < baseTime - 0.001;
    this.surfaceChoice = { accepted, baselineSeconds: baseTime, candidateSeconds: candidateTime };
    this.wetMorphing = choice.moving;
    if (accepted) { this.surface = candidateSurface; return candidateTime; }
    // A drier geometric line can still be slower because of extra curvature and
    // jerk. Keep the paired baseline when the full pace oracle rejects it.
    for (const k of this.rebuild.geometryKeys) shadow[k].set(this.line[k]);
    for (const k of ['v', 'vmax', 'vbrk', 'vfree', 'cap', 'trim', 'btrim', 'surfaceCaps']) shadow[k].set(baseline[k]);
    shadow.kept = baseline.kept; this.surface = baseSurface;
    return baseTime;
  }
  tick(car, dt, allowance = 1) {
    this.clock += dt;
    this.surfaceAge = (this.surfaceAge ?? 0) + dt;
    if (this.clock > 0.25) { this.clock = 0; this.refresh(car, false, allowance); }
    if (!this.rebuild) return;
    for (let n = 0; n < 2; n++) {
      const r = this.rebuild.gen.next();
      if (!r.done) continue;
      const { shadow, geometryKeys = [] } = this.rebuild;
      for (const k of geometryKeys) this.line[k].set(shadow[k]);
      for (const k of ['v', 'vmax', 'vbrk', 'vfree', 'cap', 'trim', 'btrim', 'surfaceCaps']) this.line[k].set(shadow[k]);
      this.line.kept = shadow.kept;
      this.estimate = r.value;
      this.rebuild = null;
      break;
    }
  }
  beginRoutes(...paths) { this.reserved = new Set(paths.filter(Boolean)); }
  setDelay(car, delay = 0, step = 1 / 120, activePath = null) {
    this.anchorSource = car;
    this.anchorDelay = this.options.executor || this.options.rttAnchor === false ? 0 : Math.max(0, Math.min(0.15, delay || 0));
    this.anchorStep = step;
    this.anchorPath = activePath;
    this.anchor = null;
  }
  arrivalPose(car) {
    if (this.anchorSource !== car || !this.anchorDelay) return car;
    if (this.anchor) return this.anchor;
    this.predictor ??= new HeldPredictor(this.track);
    const predicted = this.predictor.predict(car, this.anchorDelay, this.anchorStep), path = this.anchorPath;
    if (path) {
      const c = path.closest(predicted.x, predicted.z);
      if (c.d2 < 0.65 ** 2) {
        const next = { ...c }, current = path.closest(car.x, car.z);
        const turn = angle(path.heading(next.i, next.f) - path.heading(current.i, current.f));
        // Advance along the active contract without erasing the live tracking
        // error. Snapping to its centre even at delay~=0 changes the manoeuvre.
        return this.anchor = {
          x: car.x + path.sample(path.px, next.i, next.f) - path.sample(path.px, current.i, current.f),
          z: car.z + path.sample(path.pz, next.i, next.f) - path.sample(path.pz, current.i, current.f),
          yaw: car.yaw + turn, u: predicted.u, v: predicted.v,
          yawRate: car.yawRate + path.sample(path.ks, next.i, next.f) * predicted.speed -
            path.sample(path.ks, current.i, current.f) * car.speed,
          speed: predicted.speed
        };
      }
    }
    return this.anchor = predicted;
  }
  /** Connected C2 offset corridor with optional two-stage S-thread/switchback transition and multi-width spare tracking. */
  corridor(car, target, side, slot = 0, {
    entry = 48, hold = 120, returnLength = 80,
    clearance = this.options.separation, jerk = this.options.steerJerk, joinSpeed = null,
    anchorOffset = null,
    secondTarget = null, secondSide = 0, secondClearance = null, switchStart = 0, switchLength = 32
  } = {}) {
    const origin = this.arrivalPose(car);
    joinSpeed ??= origin.speed;
    const base = this.line, cur = base.closest(origin.x, origin.z), i0 = cur.i, d0 = cur.e;
    const beta = Math.atan2(origin.v, Math.max(2, origin.u)),
      slope = clamp(Math.tan(angle(origin.yaw + beta - base.heading(cur.i, cur.f))), -0.35, 0.35);
    const second = clamp((origin.yawRate / Math.max(8, origin.speed) - base.ks[i0]), -0.004, 0.004);
    const rivalIndex = target ? (target.reference?.i ?? base.closest(target.car.x, target.car.z).i) : i0;
    const baseTargetOff = anchorOffset ?? (target ? (target.offset ?? target.d - base.lat[rivalIndex]) : 0);
    const offset = target || anchorOffset !== null ? baseTargetOff + side * clearance : side * clearance;
    let offset2 = null;
    if (secondTarget || secondSide !== 0) {
      const idx2 = secondTarget ? (secondTarget.reference?.i ?? base.closest(secondTarget.car.x, secondTarget.car.z).i) : rivalIndex;
      const cl2 = secondClearance ?? clearance;
      offset2 = secondTarget ? (secondTarget.offset ?? secondTarget.d - base.lat[idx2]) + secondSide * cl2 : secondSide * cl2;
    }
    entry = Math.max(entry, joinSpeed * Math.cbrt(60 * Math.max(0.1, Math.abs(offset - d0)) / Math.max(20, jerk)) * 1.08);
    // Passing and merging are separate decisions. A tactical preview must not
    // assume an automatic return to the base line while the rival is still
    // alongside; Battle explicitly plans that return after clearance is safe.
    if (this.options.physicalRollouts && target?.eligible && side && secondSide === 0) {
      hold = Math.max(hold, joinSpeed * (tacticalHorizon(base, car) + 0.5));
    }
    const reach = entry + hold + returnLength, n = Math.min(base.N - 22, Math.ceil(reach / base.ds));
    const shift = new Float64Array(n + 1), bound = this.track.halfWidth + (this.options.routeEdge ?? -1.12);
    const offsets = new Float64Array(n + 1);
    const sStart = offset2 !== null ? Math.max(entry + 4, switchStart) : Infinity;
    const sEnd = sStart + Math.max(12, switchLength);
    let spareRoom = Infinity;
    const spareEnd = Math.min(n, Math.ceil((entry + Math.min(hold, 75)) / base.ds));
    for (let j = 0; j <= n; j++) {
      const x = j * base.ds;
      const rawOff = offset2 !== null && x > sStart
        ? (x >= sEnd ? offset2 : offset + (offset2 - offset) * ease((x - sStart) / Math.max(12, sEnd - sStart)))
        : offset;
      const i = base.idx(i0 + j), h = base.h[i],
        q = this.track.nearest(base.px[i] + Math.cos(h) * rawOff, base.pz[i] - Math.sin(h) * rawOff);
      if (j >= Math.floor(entry / base.ds) && j <= spareEnd) {
        spareRoom = Math.min(spareRoom, bound - Math.abs(q.lateral));
      }
      const projection = Math.max(0.3, Math.cos(angle(h - this.track.at(q.s).heading)));
      offsets[j] = rawOff - (q.lateral - clamp(q.lateral, -bound, bound)) / projection;
    }
    softenOffsets(offsets, this.options.routeFilterRadius ?? 1);
    for (let j = 0; j <= n; j++) {
      const x = j * base.ds;
      shift[j] = x < entry
        ? join(d0, slope, second, offsets[j], entry, x)
        : x < entry + hold
          ? offsets[j]
          : offsets[j] * (1 - ease((x - entry - hold) / returnLength));
    }
    let pool;
    for (let k = 0; k < this.pool.length; k++) {
      const candidate = this.pool[(slot + k) % this.pool.length];
      if (!this.reserved?.has(candidate.path)) { pool = candidate; break; }
    }
    if (!pool) throw Error('VANGUARD v2 corridor budget exhausted');
    this.reserved?.add(pool.path);
    if (pool.window) {
      for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'vmax', 'v', 'vbrk', 'st']) {
        for (let j = -14; j <= pool.window.n + 16; j++) {
          const i = base.idx(pool.window.i0 + j);
          pool.path[key][i] = base[key][i];
        }
      }
    }
    const path = base.laneWindow(shift, i0, n, pool.path);
    pool.window = { i0, n };
    path.entryLength = entry;
    path.targetOffset = baseTargetOff;
    path.corridorOffset = offset;
    path.spareRoom = Number.isFinite(spareRoom) ? clamp(spareRoom, -1.5, 2.5) : 0;
    path.steerJerk = jerk;
    path.clearance = clearance;
    path.attackSide = side;
    path.contactMargin = 0.08;
    path.anchorDelay = this.anchorDelay ?? 0;
    path.anchorS = this.track.nearest(origin.x, origin.z).s;
    for (let j = -8; j <= n; j++) {
      const i = base.idx(i0 + j), q = this.track.nearest(path.px[i], path.pz[i]);
      path.st[i] = q.s;
      path.lat[i] = q.lateral;
    }
    path.holdEndS = path.st[base.idx(i0 + Math.min(n, Math.ceil((entry + hold) / base.ds)))];
    const routeModel = Object.create(this.model);
    routeModel.margin *= this.racecraft?.routeMargin(this.options.routeMargin ?? 1, car,
      this.model.grip, Boolean(this.surface?.active)) ?? (this.options.routeMargin ?? 1);
    path.speedsWindow(routeModel, i0, n, 95, base.vbrk[base.idx(i0 + n)], {
      mass: car.spec.mass + car.fuel * 0.75,
      brakeExp: this.brakeExponent(car),
      jerk,
      notch: false,
      vbrkEnd: base.vbrk[base.idx(i0 + n)]
    });
    path.timeTax = 0;
    path.profileFloor = null;
    for (let j = 0; j < n; j++) {
      const i = base.idx(i0 + j);
      path.timeTax += path.len[i] / Math.max(8, path.vbrk[i]) - base.len[i] / Math.max(8, base.vbrk[i]);
      if (!path.profileFloor || path.vmax[i] < path.profileFloor.speed) {
        path.profileFloor = { s: path.st[i], speed: path.vmax[i], k: path.ks[i], dk: path.dk[i], lateral: path.lat[i], distance: j * base.ds };
      }
    }
    path.key = `${target?.id ?? 'space'}:${side}${secondSide ? `->${secondSide}` : ''}`;
    return path;
  }
  contract(path, car, battle, now, epoch = 0, sequence = 0) {
    const c = path.closest(car.x, car.z), count = Math.min(path.N - 1, Math.ceil(Math.max(360, car.speed * 5) / path.ds)), arrays = {};
    for (const key of ['px', 'pz', 'h', 'ks', 'lat', 'vbrk', 'vmax', 'len', 'st']) {
      arrays[key] = Array.from({ length: count + 1 }, (_, j) => path[key][path.idx(c.i - 3 + j)]);
    }
    return {
      version: 1, epoch, sequence, time: now, track: this.track.id, classId: car.classId,
      ds: path.ds, sourceS: path.st[path.idx(c.i - 3)], endS: path.st[path.idx(c.i - 3 + count)],
      arrays, battle: { ...battle }, attackSide: path.attackSide ?? 0,
      steerJerk: path.steerJerk ?? this.options.steerJerk,
      model: { grip: this.model.grip, margin: this.model.margin },
      anchorDelay: path.anchorDelay ?? 0, anchorS: path.anchorS ?? null,
      key: path.key ?? 'course'
    };
  }
}

export class Route {
  constructor(contract) {
    Object.assign(this, contract.arrays);
    this.N = this.px.length;
    this.ds = contract.ds;
    this.key = contract.key;
    this.contract = contract;
    this.steerJerk = contract.steerJerk;
    this.attackSide = contract.attackSide ?? 0;
    this.v = this.vbrk;
  }
  idx(i) { return Math.max(0, Math.min(this.N - 1, i)); }
  closest(x, z, hint = -1) {
    let best = Infinity;
    const start = hint < 0 ? 0 : Math.max(0, hint - 6), end = hint < 0 ? this.N - 2 : Math.min(this.N - 2, hint + 16);
    for (let i = start; i <= end; i++) {
      const ux = this.px[i + 1] - this.px[i], uz = this.pz[i + 1] - this.pz[i], q = ux * ux + uz * uz;
      const f = clamp(((x - this.px[i]) * ux + (z - this.pz[i]) * uz) / Math.max(q, 1e-8), 0, 1),
        dx = x - this.px[i] - ux * f, dz = z - this.pz[i] - uz * f, d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        this.found = { i, f, e: (dx * uz - dz * ux) / Math.max(1e-4, Math.sqrt(q)), d2 };
      }
    }
    return this.found;
  }
  sample(a, i, f, ahead = 0) {
    let d = f * this.len[i] + ahead;
    while (i < this.N - 2 && d >= this.len[i]) { d -= this.len[i]; i++; }
    while (i > 0 && d < 0) { i--; d += this.len[i]; }
    const u = clamp(d / Math.max(0.01, this.len[i]), 0, 1);
    return a[i] * (1 - u) + a[this.idx(i + 1)] * u;
  }
  heading(i, f) { return this.h[i] + angle(this.h[this.idx(i + 1)] - this.h[i]) * f; }
  valid(car, track) {
    const distance = gap(track.nearest(car.x, car.z).s, this.contract.sourceS, track.length),
      extent = gap(this.contract.endS, this.contract.sourceS, track.length);
    return distance >= -6 && distance < Math.max(40, extent - 25);
  }
}
