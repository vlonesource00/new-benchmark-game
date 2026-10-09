import { CarModel, liveGrip } from '../../apex/src/model.js';
import { Line } from '../../apex/src/line.js';
import { PitGuide } from '../../apex/src/pit.js';
import { clamp } from '../../apex/src/math.js';
import { tyreWet } from '../../../game/engine/sim/water.js';
import { Vehicle } from '../../../game/engine/sim/vehicle.js';
import { Atlas } from './atlas.js';
import { Perception, HALF_LEN } from './perception.js';
import { Forecast } from './forecast.js';
import { Lattice } from './lattice.js';
import { Arbiter } from './arbiter.js';
import { Controller } from './control.js';
import { WaterSense } from './water.js';
import { TreadBudget } from './tread.js';

const now = () => globalThis.performance?.now?.() ?? 0;   // planner cost statistics only, never a decision input

/**
 * TEMPEST: perception → forecast → manoeuvre-lane lattice → exact rollout → arbiter → controller (see ../ARCHITECTURE.md).
 * Shared libraries only: APEX's identified vehicle model, the Line geometry container and the baked lines.
 * Writes car.controls and nothing else.
 */
/** The car stepped on its held controls by the game's own vehicle model, on a road it cannot rubber in. */
function heldPose(car, track, delay) {
  const pose = Object.assign(Object.create(Vehicle.prototype), car);
  pose.controls = { ...car.controls }; pose.setup = { ...car.setup }; pose.aero = { ...car.aero };
  pose.wheels = car.wheels.map((w) => ({ ...w, tyre: { ...w.tyre } }));
  if (car.hybrid) pose.hybrid = { ...car.hybrid };
  const road = Object.create(track); road.deposit = () => 0;   // no rubber laid, no spray thrown (the model adds the return value)
  const n = Math.max(1, Math.ceil(delay * 120));
  for (let i = 0; i < n; i++) pose.step(delay / n, road, car.aero?.wake ?? 0);
  const sn = Math.sin(pose.yaw), cs = Math.cos(pose.yaw);
  pose.u = pose.vx * sn + pose.vz * cs; pose.v = pose.vx * cs - pose.vz * sn; pose.speed = Math.hypot(pose.u, pose.v);
  return pose;
}

export class TempestDriver {
  constructor(track, options = {}) {
    this.track = track; this.options = options; this.line = null; this.intent = 'INIT'; this.sub = '';
    this.cursor = -1; this.push = 1; this.pushApplied = 1; this.clockMs = now; this.tread = new TreadBudget(track, options);
  }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId;
    const cc = this.options.classes?.[car.classId]; if (cc) this.options = { ...this.options, ...cc };
    const pc = this.options.perClass?.[car.classId]; if (pc) this.options = { ...this.options, ...pc };
    const o = this.options, mass = car.spec.mass + car.fuel * 0.75;
    this.model = new CarModel(car.classId);
    const baked = o.lines?.[this.track.id]?.[car.classId];
    this.line = new Line(this.track, { ds: baked?.ds ?? 3, edge: o.edge ?? -0.5 });
    if (!this.line.load(o.useTrim === false && baked ? { ...baked, trim: undefined, btrim: undefined } : baked)) {
      this.line.seed(); this.line.optimise(this.model, { iterations: o.quickIterations ?? 4000, seed: 7 });
    }
    this.model.margin = o.margin ?? 1; this.model.jerk = o.jerk ?? 0; this.model.gearAware = o.gears !== false;
    this.sopt = {}; for (const key of ['gears', 'notch', 'notchBand', 'notchMargin', 'notchGain', 'notchHalf', 'notchProm', 'brakeExp']) if (o[key] !== undefined) this.sopt[key] = o[key];
    this.line.speeds(this.model, { ...this.sopt, mass });
    this.atlas = new Atlas(this.line, this.model, mass, this.sopt);
    this.field = new Perception(this.track); this.forecast = new Forecast(this);
    this.lattice = new Lattice(this); this.arbiter = new Arbiter(this); this.control = new Controller(this);
    this.water = new WaterSense(this); this.pitGuide = new PitGuide(this.track); this.shadows = new Map();
    this.slipPeak = new Float32Array(this.line.N); this.lapClean = true; this.lastStation = -1; this.lapCount = 0; this.slides = 0;
    this.forceRefresh = true; this.rebuild = null; this.refreshClock = 99;
  }
  reset() {
    this.cursor = -1; this.path = null; this.lastR = undefined; this.lastDt = undefined;
    this.field?.reset(); this.arbiter?.reset(); this.control?.reset(); this.pitGuide?.reset();
    this.forceRefresh = true; this.rebuild = null; this.refreshClock = 99;
  }
  /** Racing line of another class (for forecasting its cars). */
  shadow(cls) {
    if (cls === this.classId) return this.line;
    if (this.shadows.has(cls)) return this.shadows.get(cls);
    const baked = this.options.lines?.[this.track.id]?.[cls]; let sh = null;
    if (baked) {
      sh = new Line(this.track, { ds: baked.ds });
      if (sh.load({ ...baked, trim: undefined, btrim: undefined })) { const m = new CarModel(cls); m.margin = this.options.margin ?? 1; m.jerk = this.options.jerk ?? 0; m.grip = 0.95; sh.speeds(m, { notch: false }); }
      else sh = null;
    }
    this.shadows.set(cls, sh); return sh;
  }
  wetGrip(car) { return 1 - tyreWet(this.track, car) * 0.36; }
  meanWetGrip(car) { return this.wetGrip(car); }
  /** Live grip and the thermal push level; the profile is rebuilt a few slices per frame when they move. */
  refresh(car) {
    const o = this.options, lg = liveGrip(car);
    const g = lg.grip * (1 - (o.balanceK ?? 0) * Math.max(0, lg.imbalance)) * this.wetGrip(car) * (this.track.tempGrip ?? 1);
    let hot = 0; for (const w of car.wheels) hot = Math.max(hot, w.tyre.core - (w.tyre.optimum ?? 90));
    const target = clamp(1 - (o.thermalK ?? 0) * Math.max(0, hot - (o.thermalHot ?? 10)), o.pushMin ?? 0.8, 1);
    this.push += (target - this.push) * 0.2; this.hot = hot;
    this.spend = (this.spend ?? 1) + (this.spendNow() - (this.spend ?? 1)) * 0.2;
    const total = this.push * this.spend;
    if (this.rebuild) return;
    if (!this.forceRefresh && Math.abs(g - this.model.grip) < 0.004 && Math.abs(total - this.pushApplied) < 0.004) return;
    this.forceRefresh = false; this.pushApplied = total;
    this.model.margin = (o.margin ?? 1) * total; this.model.grip = g;
    // treadScope "clean": the tread budget is spent on the racing line only, where the slide learner trims it, and a lane
    // is planned and driven at the unspent margin (corner speed goes with the square root of the margin); "all": lanes too
    const lanes = o.treadScope === 'all';
    this.laneMargin = (o.margin ?? 1) * this.push * (lanes ? this.spend : 1); this.laneScale = lanes ? 1 : 1 / Math.sqrt(this.spend);
    const L = this.line, sh = Object.create(L);
    Object.assign(sh, { v: L.v.slice(), vmax: L.vmax.slice(), vbrk: L.vbrk.slice(), vfree: L.vfree.slice(), cap: L.cap.slice(), kept: L.kept, notches: L.notches });
    this.rebuild = { sh, gen: sh.speedsGen(this.model, { ...this.sopt, mass: car.spec.mass + car.fuel * 0.75 }) };
    this.stepRebuild();
  }
  /** The tread budget (`tread: true`): in clean-air PACE only (treadScope "clean"), or everywhere ("all"). */
  spendNow() {
    const o = this.options; if (o.tread !== true) return 1;
    return o.treadScope === 'all' || (this.intent === 'PACE' && (this.wake ?? 0) < 0.03) ? this.tread.push : 1;
  }
  stepRebuild() {
    const R = this.rebuild;
    for (let k = 0; k < (this.options.rebuildSlices ?? 3); k++) {
      const r = R.gen.next(); if (!r.done) continue;
      const L = this.line, sh = R.sh;
      L.v.set(sh.v); L.vmax.set(sh.vmax); L.vbrk.set(sh.vbrk); L.vfree.set(sh.vfree); L.cap.set(sh.cap); L.kept = sh.kept; L.notches = sh.notches;
      this.lapEstimate = r.value; this.rebuild = null; return;
    }
  }
  /** Seat-worker delay: carry the pose forward to when the controls will act. */
  predict(car, dt) {
    const o = this.options, held = dt > 0.0125;
    // a long hold (slow seat replies, a sped-up sim): run the car itself on the controls it is holding to the middle of
    // the next held interval, instead of extrapolating a yaw acceleration that far
    if (held && dt + (this.controlDelay ?? 0) > (o.holdPhysical ?? 0.045)) {
      this.lastR = car.yawRate; this.lastDt = dt;
      return heldPose(car, this.track, this.delay = clamp((this.controlDelay ?? 0) + 0.5 * dt, 0.008, o.holdPhysicalCap ?? 0.1));
    }
    const delay = clamp((this.controlDelay ?? 0) + (held ? (o.holdLead ?? 1.5) * dt : 0), 0, o.holdCap ?? 0.045);
    const r0 = car.yawRate, dr = this.lastR === undefined ? 0 : clamp((r0 - this.lastR) / Math.max(1e-3, this.lastDt ?? dt), -8, 8);
    this.lastR = r0; this.lastDt = dt; this.delay = delay;
    if (!(delay > 0)) return car;
    const yaw0 = car.yaw, s0 = Math.sin(yaw0), c0 = Math.cos(yaw0);
    const vx = car.vx + (car.ax * s0 + car.ay * c0) * delay, vz = car.vz + (car.ax * c0 - car.ay * s0) * delay;
    const yawRate = clamp(r0 + dr * delay, -3, 3), yaw = yaw0 + 0.5 * (r0 + yawRate) * delay, s = Math.sin(yaw), c = Math.cos(yaw);
    const u = vx * s + vz * c, v = vx * c - vz * s;
    return Object.create(car, {
      x: { value: car.x + 0.5 * (car.vx + vx) * delay }, z: { value: car.z + 0.5 * (car.vz + vz) * delay },
      yaw: { value: yaw }, yawRate: { value: yawRate }, vx: { value: vx }, vz: { value: vz }, u: { value: u }, v: { value: v }, speed: { value: Math.hypot(u, v) }
    });
  }
  /** Immediate nose cap: a car (or a stopped hazard) in our committed lane right now. */
  noseCap(me, path, v) {
    let cap = Infinity, brake = 0;
    for (const r of this.field.list) {
      const Ls = HALF_LEN + r.halfLength;
      if (r.ds < Ls - 0.6 || r.ds > 90) continue;
      const st = path.stationOf(r.s), lat = path.sample(path.lat, Math.floor(st), st % 1, 0);
      const c = Math.abs(lat - r.d) - (me.halfWidth + r.across);
      if (c > (r.hazard ? 0.6 : 0.15)) continue;
      const rv = r.hazard ? Math.min(r.v, 3) : r.v, room = r.ds - Ls - (r.hazard ? 2.5 : 0.8) - 0.2 * Math.max(0, v - rv);
      const b = this.model.brake(Math.max(8, rv));
      cap = Math.min(cap, rv + Math.sqrt(2 * (this.options.noseB ?? 0.6) * b * Math.max(0, room)));
      // closing faster than the full brakes can absorb: brake now
      if (room < 25 && v > rv + 1) brake = Math.max(brake, clamp((v * v - rv * rv) / (2 * Math.max(1, room) * this.model.brake(v)), 0, 1));
    }
    return { cap, brake: brake > 0.85 ? brake : 0 };
  }
  update(real, cars, dt, context = {}) {
    this.prepare(real);
    this.controlDelay = context.controlDelay ?? 0;
    const car = this.predict(real, dt), line = this.line, o = this.options, t = context.time ?? 0;
    this.refreshClock += dt;
    if (this.rebuild) this.stepRebuild();
    if (this.refreshClock > 0.25) { this.refreshClock = 0; this.water.update(car, 0.25); if (o.tread === true) { this.tread.o = o; this.tread.update(real, context.state ?? {}, o.margin ?? 1); } this.refresh(car); }
    let c = line.closest(car.x, car.z, this.cursor);
    if (c.d2 > 400) c = line.closest(car.x, car.z, -1);
    this.cursor = c.i;
    if (real.gear > 0 && line.cap[c.i] === Infinity) line.gearSeen[c.i] = real.gear;
    const state = context.state ?? {}; this.state = state;
    const boxing = Boolean(real.race?.boxThisLap || state.pitPlan) && !state.pit, toPit = boxing ? this.pitGuide.toEntry(real.s ?? 0) : Infinity;
    const field = this.field;
    field.update(real, cars ?? [], context, t, state);
    const me = field.me;
    let path = line, pitCap = Infinity, pitCap2 = Infinity, planCap = Infinity, planCap2 = Infinity;
    const look = car.speed * 0.1, d2 = Math.max(4, car.speed * 0.25);
    if (toPit < 600 && toPit > 0.3) {
      path = this.pitGuide.path ?? this.pitGuide.build(line, this.model, { mass: real.spec.mass + real.fuel * 0.75 });
      pitCap = this.pitGuide.cap(toPit); pitCap2 = this.pitGuide.cap(Math.max(0, toPit - d2));
      this.arbiter.plan = null; this.arbiter.state = 'PIT';
    } else {
      if (this.pitGuide.path) this.pitGuide.reset();
      if (o.combat !== false) {
        path = this.arbiter.update(t, real, me, field, this.forecast, dt);
        const plan = this.arbiter.plan;
        if (plan) { planCap = plan.capAt(me.s + look); planCap2 = plan.capAt(me.s + look + d2); }
      }
    }
    if (path !== line) c = path.closest(car.x, car.z, c.i);
    this.path = path;
    const nose = this.noseCap(me, path, car.speed); this.lastNose = nose.cap;
    const nb = this.control.neighbor(me, field, car.speed);
    const st = this.arbiter.state; this.wake = car.aero?.wake ?? 0;
    this.control.step(real, car, path, c, dt, {
      nb, cap: planCap, cap2: planCap2, nose: nose.cap, noseBrake: nose.brake, pitCap, pitCap2,
      freeThrust: o.freeThrust ?? (st !== 'PACE' || (car.aero?.wake ?? 0) > 0.05),
      tractionSlip: clamp((o.tractionSlip ?? 2.1) - Math.max(0, this.hot - 20) * 0.004 - Math.max(0, this.maxWear(car) - 0.35) * 0.18, 1.86, 2.1)
    });
    this.c = c; this.cur = { i: c.i, v: car.speed };
    this.learnStep(car, c.i, path === line, t);
    this.intent = this.control.stability < 0.3 ? 'RECOVER' : st;
    this.sub = this.describe();
  }
  maxWear(car) { let w = 0; for (const x of car.wheels) w = Math.max(w, x.tyre.wear); return w; }
  /**
   * One learner, one target: the margin to the tyres' force peak per corner. A slide on the racing line cuts the
   * trim there at once (and brakes earlier into it); clean laps move every corner-limited station toward the
   * peak-slip target. Both write the same trims, so they cannot undo each other's purpose.
   */
  learnStep(car, i, onLine, t) {
    const o = this.options, line = this.line, N = line.N;
    // a slide in another car's wake says nothing about the clean-air line (the wake took the downforce; the profile
    // already slows for it): trimming the line for it would slow every later lap in clean air
    const dirty = (car.aero?.wake ?? 0) > (o.slideLearnWake ?? 0.05);
    if (o.slideLearn !== false && onLine && !dirty && this.control.stability < 0.5 && !(t < (this.slideAt ?? -9) + 1.5)) {
      this.slideAt = t; const back = Math.round((o.slideBack ?? 60) / line.ds), fwd = Math.round(12 / line.ds);
      for (let j = -back; j <= fwd; j++) { const k = line.idx(i + j); line.btrim[k] = Math.max(o.slideFloor ?? 0.85, line.btrim[k] * (1 - (o.slideBrake ?? 0.03))); }
      for (let j = -fwd; j <= 2 * fwd; j++) { const k = line.idx(i + j); line.trim[k] = Math.max(o.slideFloor ?? 0.85, line.trim[k] * (1 - (o.slideCorner ?? 0.015))); }
      this.forceRefresh = true; this.slides++;
    }
    if (!o.learn) return;
    if (this.lastStation > N * 0.75 && i < N * 0.25) this.finishLap();
    this.lastStation = i;
    if (Math.abs(car.lateral ?? 0) > this.track.halfWidth + this.track.curbWidth || car.speed < 12 || !onLine) this.lapClean = false;
    let s = 0; for (const w of car.wheels) s = Math.max(s, Math.tan(Math.min(1.2, Math.abs(w.tyre.alpha))) * 8.6);
    if (s > this.slipPeak[i]) this.slipPeak[i] = s;
  }
  finishLap() {
    const o = this.options, line = this.line, N = line.N, target = o.slipTarget ?? 2.0, gain = o.learnGain ?? 0.25;
    if (this.lapClean && this.lapCount++ >= 1) {
      for (let i = 0; i < N; i++) {
        if (!(line.vmax[i] <= line.v[i] + 0.6 && this.slipPeak[i] > 0.3)) continue;
        line.trim[i] = clamp(line.trim[i] * (1 + gain * clamp((target - this.slipPeak[i]) / target, -0.12, 0.08)), 0.6, 1.3);
      }
      this.forceRefresh = true;
    }
    this.lapClean = true; this.slipPeak.fill(0);
  }
  /** Where the committed path leaves the racing line and where it comes back, in metres ahead (debugger only). */
  move() {
    const path = this.path, line = this.line, c = this.c;
    if (!path || path === line || !c) return null;
    const n = 110; let out = null, back = null, peak = 0;
    for (let j = 0; j <= n; j++) {
      const i = path.idx(c.i + j), dev = Math.hypot(path.px[i] - line.px[i], path.pz[i] - line.pz[i]);
      peak = Math.max(peak, dev);
      if (out == null) { if (dev > 0.5) out = j; }
      else if (dev < 0.3) { back = j; break; }
    }
    if (out == null) return null;
    const at = (j) => { const i = path.idx(c.i + j); return { x: +path.px[i].toFixed(2), z: +path.pz[i].toFixed(2) }; };
    return { out: out * path.ds, back: back == null ? null : back * path.ds, peak, outPt: out > 0 ? at(out) : null, backPt: back == null ? null : at(back) };
  }
  describe() {
    const a = this.arbiter, p = a?.plan, st = this.intent, f = a?.focus, mv = this.move();
    if (st === 'PIT') return 'pit entry';
    if (st === 'RECOVER') return 'catching a slide';
    const who = f?.name ? `${f.name} ${Math.abs(f.gap).toFixed(0)} m` : '';
    const where = mv ? (mv.out > 3 ? ` · out ${mv.out.toFixed(0)} m` : '') + (mv.back != null ? ` · rejoin ${mv.back.toFixed(0)} m` : '') : '';
    if (st === 'ATTACK') return `pass ${who || 'ahead'}${where}`;
    if (st === 'DEFEND') return `cover ${who || 'behind'}`;
    if (st === 'TOW') return `slipstream ${who}${where}`;
    if (st === 'ROUTE') return `around ${f?.why === 'contact' ? 'blocked line' : f?.why ?? ''} ${who}${where}`;
    if (p?.passes > 0 && mv) return `pass ${who || 'ahead'} planned${where}`;
    if (mv && mv.peak > 1.2) return `${mv.peak.toFixed(1)} m off line${who ? ` · behind ${who}` : ''}${where}`;
    if (f?.why === 'follow') return `following ${who} on the line`;
    return this.water?.active ? 'wet grip map' : 'racing line';
  }
  debug() {
    const a = this.arbiter, p = a?.plan, ctl = this.control;
    return {
      architecture: 'TEMPEST', intent: this.intent, sub: this.sub, mode: ctl?.mode, targetSpeed: ctl?.targetSpeed, stability: ctl?.stability,
      grip: this.model?.grip, push: this.push, hot: this.hot, share: ctl?.share, tcCap: ctl?.tcCap, latHold: ctl?.guard ?? false, wake: this.wake ?? 0,
      focus: a?.focus ?? null, side: p?.side ?? 0, move: this.move(), lead: a?.lead ?? null, pending: a?.want ?? null, cands: a?.cands ?? null,
      plan: p ? { horizon: +(p.K * p.dS).toFixed(0), passes: p.passes, tow: +p.tow.toFixed(2), defend: p.defend, score: +p.score.toFixed(3), edges: p.edges, first: p.first, last: p.last } : null,
      combat: a ? { state: a.state, side: 0, stats: { ...a.books(), recovers: ctl?.recovers ?? 0, slides: this.slides }, events: a.events.slice(-6) } : null,
      tread: { push: this.tread.push, spend: this.spend ?? 1, why: this.tread.why, endWear: this.tread.endWear, rate: this.tread.rate },
      water: this.water?.debug()
    };
  }
  visualDebug() {
    const path = this.path ?? this.line, cur = this.c;
    if (!path || !cur) return { trackingPoint: this.track.at(this.track.gridS) };
    const i0 = cur.i, n = clamp(Math.round(8 * Math.max(10, this.cur.v) / path.ds), 40, 110), pts = [];
    for (let j = 0; j <= n; j += 2) { const i = path.idx(i0 + j); pts.push({ x: +path.px[i].toFixed(2), z: +path.pz[i].toFixed(2), v: +path.v[i].toFixed(1) }); }
    const Lp = clamp(0.32 * this.cur.v + 7, 9, 32), ai = path.idx(i0 + Math.round(Lp / path.ds));
    const tone = { ATTACK: '#ff4d6d', TOW: '#ffb02e', DEFEND: '#3ad6ff', ROUTE: '#ff8f3d', PIT: '#c77dff', RECOVER: '#ffffff' }[this.intent];
    // posts on the ground: where the move leaves the racing line and where it rejoins it
    const mv = this.move(), marks = [];
    if (mv?.outPt) marks.push({ ...mv.outPt, color: tone ?? '#ffffff', kind: 'out' });
    if (mv?.backPt) marks.push({ ...mv.backPt, color: '#3ddc84', kind: 'back' });
    return { trackingPoint: { x: path.px[ai], z: path.pz[ai] }, selectedTrajectory: { points: pts, mode: this.intent, ...(tone ? { color: tone } : {}) }, candidates: [], marks };
  }
}
