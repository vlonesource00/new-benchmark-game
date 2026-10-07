import { CarModel, liveGrip } from './model.js';
import { RivalLine } from './rival.js';
import { Line } from './line.js';
import { clamp, angle } from './math.js';
import { PitGuide } from './pit.js';
import { Field } from './field.js';
import { Combat } from './combat.js';

/**
 * APEX driver. Writes only `car.controls` (and, for the GTP energy manager, `car.intent`).
 * M1 pace core: identified g-g-v model → baked minimum-time line → quasi-steady-state speed profile →
 * curvature-preview tracker with yaw-rate and sideslip feedback.
 */
export class ApexDriver {
  constructor(track, options = {}) {
    this.track = track; this.options = options;
    this.model = null; this.line = null; this.mode = 'INIT'; this.targetSpeed = 0;
    this.steer = 0; this.cursor = -1; this.stability = 1; this.push = 1; this.pushApplied = 1;
  }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId;
    // per-track, per-class overrides (config.tracks[track].perClass[class])
    const pc = this.options.perClass?.[car.classId]; if (pc) this.options = { ...this.options, ...pc };
    const o = this.options;
    this.model = new CarModel(car.classId);
    this.line = new Line(this.track, { ds: o.lines?.[this.track.id]?.[car.classId]?.ds ?? 3, edge: o.edge ?? -0.5 });
    const baked = o.lines?.[this.track.id]?.[car.classId];
    if (o.useTrim === false && baked) { baked.trim = undefined; baked.btrim = undefined; }
    if (!this.line.load(baked)) { this.line.seed(); this.line.optimise(this.model, { iterations: o.quickIterations ?? 4000, seed: 7 }); }
    this.model.margin = o.margin ?? 1; this.model.jerk = o.jerk ?? 0;
    this.sopt = {}; for (const key of ['gears', 'notch', 'notchBand', 'notchMargin', 'notchGain', 'notchHalf', 'notchProm']) if (o[key] !== undefined) this.sopt[key] = o[key];
    this.model.gearAware = o.gears !== false;
    this.line.speeds(this.model, { ...this.sopt, mass: car.spec.mass + car.fuel * 0.75 });
    this.cursor = -1;
    this.pitGuide = new PitGuide(this.track);
    this.field = new Field(this.track); this.combat = new Combat(this); this.shadows = new Map(); this.rivalLines = new Map();
    this.slipPeak = new Float32Array(this.line.N); this.lapClean = true; this.lastStation = -1; this.learned = 0; this.lapCount = 0;
  }
  reset() { this.steer = 0; this.cursor = -1; this.sent = null; this.pitGuide?.reset(); this.path = null; this.field?.reset(); this.combat?.reset(); }
  /** Racing line (with its speed profile) of another class, for predicting rivals of that class. */
  shadow(cls) {
    if (cls === this.classId) return this.line;
    if (this.shadows.has(cls)) return this.shadows.get(cls);
    const baked = this.options.lines?.[this.track.id]?.[cls]; let sh = null;
    if (baked) { sh = new Line(this.track, { ds: baked.ds }); if (sh.load(baked)) { const m = new CarModel(cls); m.margin = this.options.margin ?? 1; m.jerk = this.options.jerk ?? 0; m.grip = 0.9; sh.speeds(m, { notch: false }); } else sh = null; }
    this.shadows.set(cls, sh); return sh;
  }
  /** The measured line of the architecture driving this rival (public on the timing screen), or null when none was baked for this track and class. */
  rivalLine(r) {
    const arch = this.state?.rivals?.find((o) => o.id === r.id)?.driver; if (!arch) return null;
    const key = arch + "|" + r.cls;
    if (!this.rivalLines.has(key)) { const d = this.options.rivals?.[this.track.id]?.[r.cls]?.[arch]; this.rivalLines.set(key, d ? new RivalLine(d) : null); }
    return this.rivalLines.get(key);
  }
  /** What the debugger shows: intent and the numbers behind it. Cheap: reads what the last update left behind. */
  debug() {
    const c = this.combat, plan = c?.plan, st = c?.stats ?? {}, lat = this.latCap ? Math.abs(this.ayReq ?? 0) / this.latCap : 0;
    return {
      architecture: 'APEX', intent: this.intent ?? this.mode, sub: this.sub ?? '', mode: this.mode,
      targetSpeed: this.targetSpeed, lineSpeed: this.lineSpeed, e: this.e, stability: this.stability, grip: this.model?.grip, balance: this.balance,
      wake: this.wake, share: this.share, tcCap: this.tcCap, protect: this.protect, latUse: lat, push: this.push, hot: this.hot, slipF: this.sF, slipR: this.sR, latHold: Boolean(this.nbHeld),
      focus: c?.focus?.id ?? null, focusKind: c?.focus?.kind ?? null, focusGap: c?.focus?.ds ?? null, side: plan?.side ?? 0,
      combat: c ? { state: c.state, side: plan?.side ?? 0, A: plan?.A ?? 0, cap: Number.isFinite(c.cap) ? c.cap : null, tag: plan?.tag, contact: c.contact ?? null, stats: st,
        cands: (c.visCands ?? []).map((q) => ({ kind: q.kind, score: q.score, chosen: q.chosen, risk: q.risk, clear: q.clear })), events: (c.events ?? []).slice(-6) } : null
    };
  }
  /** Geometry for the 3D lens and the radar: the path being followed, the lanes weighed, the aim point and the rival forecasts. */
  visualDebug() {
    const path = this.path ?? this.line, cur = this.cur;
    if (!path || !cur) return null;
    const i0 = path.idx(cur.i), n = clamp(Math.round(8 * Math.max(10, cur.v) / path.ds), 40, 110), pts = [];
    for (let j = 0; j <= n; j += 2) { const i = path.idx(i0 + j); pts.push({ x: +path.px[i].toFixed(2), z: +path.pz[i].toFixed(2), v: +path.v[i].toFixed(1) }); }
    const Lp = clamp(0.32 * cur.v + 7, 9, 32), ai = path.idx(i0 + Math.round(Lp / path.ds)), c = this.combat;
    const tone = { ATTACK: '#ff4d6d', TOW: '#ffb02e', ALONGSIDE: '#ff8f3d', FOLLOW: '#ffb02e', PIT: '#c77dff' }[this.intent];
    return {
      trackingPoint: { x: path.px[ai], z: path.pz[ai] },
      selectedTrajectory: { points: pts, mode: this.intent ?? this.mode, ...(tone ? { color: tone } : {}) },
      candidates: (c?.visCands ?? []).map((q) => ({ kind: q.kind, score: q.score, chosen: q.chosen, points: q.points })),
      extras: { ...(c?.vis() ?? {}), me: { l: +(this.field?.me?.lat ?? 0).toFixed(2), v: +cur.v.toFixed(1) }, half: this.track.halfWidth }
    };
  }
  /** Intent label for the debugger, from what the combat planner and the pit guide are doing. */
  labelIntent(pitting) {
    const c = this.combat, cs = pitting ? 'PIT' : c?.state ?? 'FREE';
    this.intent = this.stability < 0.3 ? 'RECOVER' : { PIT: 'PIT', ATTACK: 'ATTACK', SETUP: 'TOW', ALONGSIDE: 'ALONGSIDE', FOLLOW: 'FOLLOW' }[cs] ?? 'PACE';
    this.sub = cs === 'SETUP' ? `in the tow · pull out ${c.plan?.side > 0 ? 'left' : 'right'} in ${c.plan?.delay?.toFixed(1)} s` : cs === 'ATTACK' ? `${c.plan?.tag ?? ''} ${c.plan?.side > 0 ? 'left' : 'right'} lane` : cs === 'ALONGSIDE' ? 'holding the gap' : cs === 'FOLLOW' && Number.isFinite(c.cap) ? 'speed capped behind' : this.mode.toLowerCase();
  }
  /** Live grip: the game's tyre formula for each wheel, relative to the identification reference. */
  refresh(car) {
    const o = this.options, lg = liveGrip(car);
    // A rear that is weaker than the front turns a limit corner into oversteer: take extra margin for the imbalance.
    const g = lg.grip * (1 - (o.balanceK ?? 0) * Math.max(0, lg.imbalance)) * (1 - (this.track.wetness ?? 0) * 0.36) * (this.track.tempGrip ?? 1);
    this.balance = lg.imbalance;
    // Thermal governor: the core is the slow variable. Past the compound's window every extra degree costs grip twice
    // (temperature and pressure) and wears the tread faster, so the push eases off before the tyres are cooked.
    let hot = 0; for (const w of car.wheels) hot = Math.max(hot, w.tyre.core - (w.tyre.optimum ?? 90));
    const target = clamp(1 - (o.thermalK ?? 0) * Math.max(0, hot - (o.thermalHot ?? 10)), o.pushMin ?? 0.8, 1);
    this.push += (target - this.push) * 0.2; this.hot = hot;
    if (!this.forceRefresh && Math.abs(g - this.model.grip) < 0.004 && Math.abs(this.push - this.pushApplied) < 0.004) return;
    this.forceRefresh = false;
    this.pushApplied = this.push; this.model.margin = (o.margin ?? 1) * this.push;
    this.model.grip = g;
    this.lapEstimate = this.line.speeds(this.model, { ...this.sopt, mass: car.spec.mass + car.fuel * 0.75 });
  }
  /**
   * In a seat worker the answer reaches the car about 1.5 snapshot intervals after the state it was computed
   * from (`dt` then spans the interval, not one physics step). The pose and body velocities are carried forward
   * over that delay so the controls fit the car they will act on, not the car as it was.
   */
  predict(car, dt) {
    const delay = dt > 0.0125 ? Math.min(0.09, 1.5 * dt) : 0;
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
  update(real, cars, dt, context) {
    this.prepare(real);
    const car = this.predict(real, dt);
    const track = this.track, line = this.line, model = this.model, o = this.options;
    const v = Math.max(0.5, car.speed);
    this.refreshClock = (this.refreshClock ?? 99) + dt;
    if (this.refreshClock > 0.25) { this.refreshClock = 0; this.refresh(car); }
    let c = line.closest(car.x, car.z, this.cursor);
    if (c.d2 > 400) c = line.closest(car.x, car.z, -1);
    this.cursor = c.i;
    if (real.gear > 0 && line.cap[c.i] === Infinity) line.gearSeen[c.i] = real.gear;
    // in-lap: peel to the pit-side edge on a lane of our own line, never above the host's braking envelope
    const state = context?.state ?? {}, boxing = Boolean(real.race?.boxThisLap || state.pitPlan) && !state.pit, toPit = boxing ? this.pitGuide.toEntry(real.s ?? 0) : Infinity;
    let path = line, pitCap = Infinity;
    if (toPit < 600 && toPit > 0.3) {
      path = this.pitGuide.path ?? this.pitGuide.build(line, model, { mass: real.spec.mass + real.fuel * 0.75 });
      pitCap = this.pitGuide.cap(toPit);
      c = path.closest(car.x, car.z, c.i);
    } else if (this.pitGuide.path) this.pitGuide.reset();
    this.state = state;
    let combatCap = Infinity;
    if (path === line && o.combat !== false && cars?.length > 1) {
      const now = context?.time ?? 0;
      this.field.update(real, cars, context, now, state);
      const r = this.combat.update(now, real, c, v, this.field, cars);
      path = r.path; combatCap = r.cap;
      if (path !== line) c = path.closest(car.x, car.z, c.i);
    }
    this.path = path;
    const { i, f, e } = c; this.e = e; this.cur = { i, x: real.x, z: real.z, v };
    // ---- lateral ----
    const hPath = path.heading(i, f), beta = Math.atan2(car.v, Math.max(2, car.u));
    const psi = angle(car.yaw + beta - hPath);
    const Lp = clamp(0.32 * v + 7, 9, 32);
    const kp = path.sample(path.ks, i, f, v * (o.preview ?? 0.08));
    // the correction toward the line is bounded by what the tyres can give on top of the corner itself
    const fbMax = (o.fbShare ?? 0.45) * model.lat(v) / (v * v);
    let corr = clamp(-2 * psi / Lp - e / (Lp * Lp), -fbMax, fbMax);
    // lateral discipline: never close on a car alongside faster than there is room for. Past the allowed drift the car holds
    // the heading that drifts at exactly the allowed rate, with the full tyre budget available to do it.
    const nb = o.latGuard === false || !this.combat ? null : this.combat.neighbor(v); this.nb = nb;
    if (nb) {
      const drift = nb.dir * v * Math.sin(psi);
      if (drift > nb.rate) { const pt = nb.dir * Math.asin(clamp(nb.rate / v, -0.35, 0.35)), fbSafe = 0.8 * model.lat(v) / (v * v); corr = clamp(-2 * (psi - pt) / Lp, -fbSafe, fbSafe); this.nbHeld = true; } else this.nbHeld = false;
    } else this.nbHeld = false;
    const kc = kp + corr;
    this.ayReq = v * v * kp; this.latCap = model.lat(v);
    const ff = model.steerFor(v * v * kc, v), rDes = v * kc, rErr = rDes - car.yawRate;
    const dBeta = this.dBeta = beta - model.betaFor(v * v * kc, v), slide = Math.sign(dBeta) * Math.max(0, Math.abs(dBeta) - (o.slideBand ?? 0.04));
    this.steer = clamp(ff + (o.yawGain ?? 0.45) * rErr + (o.slideGain ?? 2.2) * slide, -1, 1);
    const over = Math.sign(car.yawRate) === Math.sign(rDes) ? Math.max(0, Math.abs(car.yawRate) - Math.abs(rDes)) : Math.abs(car.yawRate);
    this.stability = clamp(1 - 2.5 * Math.max(0, over - 0.08) - 4 * Math.max(0, Math.abs(dBeta) - (o.betaLimit ?? 0.06)), 0, 1);
    // ---- longitudinal ----
    const look = v * 0.1, d2 = Math.max(4, v * 0.25);
    // target: the braking envelope when the car may use all the thrust it really has (hybrid, tow), else the table profile
    // (in a slipstream the thrust is worth more than the table says, so the same envelope applies there)
    const wk = car.aero?.wake ?? 0;
    const prof = (o.freeThrust ?? (this.combat?.state !== 'FREE' || wk > (o.towWake ?? 0.05))) ? path.vbrk : path.v;
    let vt = path.sample(prof, i, f, look), vt2 = path.sample(prof, i, f, look + d2);
    // dirty air: where a corner sets the speed, the downforce a car ahead takes away takes speed too (straights keep the tow)
    if (wk > 0.05) { const ws = model.wakeSpeed(v, wk); const lim = (j) => path.vmax[path.idx(i + j)] < path.v[path.idx(i + j)] + 2; if (lim(1) || lim(Math.round(look / path.ds) + 2)) { vt *= ws; vt2 *= ws; } }
    this.wake = wk;
    if (combatCap < Infinity) { vt = Math.min(vt, combatCap); vt2 = Math.min(vt2, combatCap); }
    if (pitCap < Infinity) { vt = Math.min(vt, pitCap); vt2 = Math.min(vt2, this.pitGuide.cap(Math.max(0, toPit - d2))); }
    const aProf = (vt2 * vt2 - vt * vt) / (2 * d2);
    this.targetSpeed = vt;
    let throttle = 0, brake = 0;
    const err = vt - v;
    if (err > 0.4 || (err > -0.2 && aProf > -1)) throttle = clamp(0.4 + err * 0.9 + aProf * 0.1, 0, 1);
    else if (-err < 2 && -aProf < 3) throttle = 0;
    else {
      brake = clamp(Math.max(0, -aProf) / model.brake(v) + (v - vt) * 0.18, 0, 1);
      if (v < vt - 0.5) brake *= 0.3;
    }
    // Friction circle: the pedals share the tyres with the corner. How much of the lateral peak the car is using (the
    // larger of what the path demands and what the car is doing, against the physical table without margin) sets how
    // much braking or drive is left, so a braking zone that reaches into a corner is trailed off instead of stamped on.
    const phys = model.lat(v) / Math.max(0.5, (model.margin ?? 1) * (line.trim[i] ?? 1)), use = clamp(Math.max(Math.abs(v * v * kp), Math.abs(car.ay) * 0.9) / Math.max(1, phys), 0, 1);
    const share = Math.sqrt(Math.max(0, 1 - use ** (o.circleExp ?? 2)));
    this.share = share;
    if (brake > 0) brake = Math.min(brake, Math.max(o.brakeFloor ?? 0.12, share * (o.brakeAllow ?? 1.15)));
    throttle = Math.min(throttle, Math.max(o.throttleFloor ?? 0.2, share * (o.throttleAllow ?? 1.25)));
    // Traction governor: the driven axle's combined slip is held near the force peak (2.4); beyond it the
    // tyre gives less force and more heat, and a rear-driven car that also corners snaps loose.
    const di = car.spec.drive === 'front' ? 0 : 2, comb = (t) => Math.hypot(t.kappa * 10.5, Math.tan(Math.min(1.2, Math.abs(t.alpha))) * 8.6);
    const rs = Math.max(comb(car.wheels[di].tyre), comb(car.wheels[di + 1].tyre)), S = o.tractionSlip ?? 2.2;
    this.tcCap = clamp((this.tcCap ?? 1) + dt * (rs > S ? -10 * (rs - S) - 1 : 2.5), 0.1, 1);
    throttle = Math.min(throttle, this.tcCap);
    // Protective layer from the tyres themselves: lateral slip beyond the force peak (2.4) on either axle, or a rear
    // that slips well past the front, is a car about to leave. Pedals are eased before the slide, not after it.
    const lat = (t) => Math.tan(Math.min(1.2, Math.abs(t.alpha))) * 8.6;
    const sF = Math.max(lat(car.wheels[0].tyre), lat(car.wheels[1].tyre)), sR = Math.max(lat(car.wheels[2].tyre), lat(car.wheels[3].tyre));
    const hi = o.slipHi ?? 2.15, tooFar = Math.max(0, Math.max(sF, sR) - hi), loose = Math.max(0, sR - sF - (o.looseBand ?? 0.35));
    this.protect = clamp((1 - (o.protectGain ?? 2) * tooFar) * (1 - (o.looseGain ?? 1.2) * loose), 0.15, 1);
    this.sF = sF; this.sR = sR;
    throttle *= this.protect; if (sR > hi) brake *= this.protect;
    brake *= this.stability; throttle *= this.stability;
    this.mode = brake > 0 ? 'BRAKE' : throttle > 0.95 ? 'PUSH' : 'CORNER';
    this.lineSpeed = path.sample(path.v, i, f, 0); this.labelIntent(toPit < 600 && toPit > 0.3);
    real.controls = { throttle, brake, steer: this.steer };
    if (real.hybrid) this.energy(real, car);
    if (o.learn) this.learn(car, i);
  }
  /** GTP energy manager (P2): where the battery is spent. The host applies the intent inside its own energy rules. */
  energy(real, car) {
    const o = this.options.hyb; if (!o) return;
    const soc = real.hybrid.energy / 3e6, v = car.speed;
    let d = clamp((o.vHi - v) / Math.max(1, o.vHi - o.vLo), 0, 1);
    if (soc < (o.socMin ?? 0.05)) d *= Math.max(0, soc / (o.socMin ?? 0.05));
    real.intent = { deploy: d * (o.max ?? 1), harvest: o.harvest ?? 0.5, ttl: 0.3 };
  }
  /**
   * Corner-limit learning (iterative learning control). The tyres tell where the limit is: the force
   * shape peaks at combined slip 2.4 and is within 1 % of it at 2.0. The peak slip magnitude on each
   * corner-limited station is compared with the target, and that station's usage trim moves toward it,
   * so the speed profile converges on the speed this car really holds there.
   */
  learn(car, i) {
    const o = this.options, line = this.line, N = line.N;
    if (this.lastStation >= 0 && this.lastStation > N * 0.75 && i < N * 0.25) { this.finishLap(); }
    this.lastStation = i;
    if (Math.abs(car.lateral) > this.track.halfWidth + this.track.curbWidth || car.speed < 12) this.lapClean &&= car.speed < 12;
    let s = 0;
    for (const w of car.wheels) s = Math.max(s, Math.tan(Math.min(1.2, Math.abs(w.tyre.alpha))) * 8.6);
    if (s > this.slipPeak[i]) this.slipPeak[i] = s;
  }
  finishLap() {
    const o = this.options, line = this.line, N = line.N, target = o.slipTarget ?? 2.0, gain = o.learnGain ?? 0.25;
    if (this.lapClean && this.lapCount++ >= 1) {
      const err = new Float32Array(N), w = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const limited = line.vmax[i] <= line.v[i] + 0.6 && this.slipPeak[i] > 0.3;
        if (limited) { err[i] = clamp((target - this.slipPeak[i]) / target, -0.12, 0.08); w[i] = 1; }
      }
      // smooth the correction over neighbouring stations of the same corner
      const R = 3;
      for (let i = 0; i < N; i++) {
        let sum = 0, ws = 0;
        for (let j = -R; j <= R; j++) { const k = line.idx(i + j); if (w[k]) { sum += err[k] * (R + 1 - Math.abs(j)); ws += R + 1 - Math.abs(j); } }
        if (ws > 0 && w[i]) line.trim[i] = clamp(line.trim[i] * (1 + gain * sum / ws), 0.6, 1.3);
      }
      this.learned++;
      this.line.speeds(this.model, { ...this.sopt, mass: 1100 });
    }
    this.lapCount ??= 0; this.lapClean = true; this.slipPeak.fill(0);
    this.forceRefresh = true;                         // the gears seen this lap decide the next profile's notches
  }
}
