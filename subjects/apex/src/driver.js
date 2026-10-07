import { CarModel, liveGrip } from './model.js';
import { Line } from './line.js';
import { clamp, angle } from './math.js';
import { PitGuide } from './pit.js';

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
    const o = this.options;
    this.model = new CarModel(car.classId);
    this.line = new Line(this.track, { ds: o.lines?.[this.track.id]?.[car.classId]?.ds ?? 3, edge: o.edge ?? -0.5 });
    const baked = o.lines?.[this.track.id]?.[car.classId];
    if (o.useTrim === false && baked) { baked.trim = undefined; baked.btrim = undefined; }
    if (!this.line.load(baked)) { this.line.seed(); this.line.optimise(this.model, { iterations: o.quickIterations ?? 4000, seed: 7 }); }
    this.model.margin = o.margin ?? 1; this.model.jerk = o.jerk ?? 0;
    this.line.speeds(this.model);
    this.cursor = -1;
    this.pitGuide = new PitGuide(this.track);
    this.slipPeak = new Float32Array(this.line.N); this.lapClean = true; this.lastStation = -1; this.learned = 0; this.lapCount = 0;
  }
  reset() { this.steer = 0; this.cursor = -1; this.sent = null; this.pitGuide?.reset(); this.path = null; }
  debug() { return { architecture: 'APEX', intent: this.mode, targetSpeed: this.targetSpeed, e: this.e, stability: this.stability, grip: this.model?.grip }; }
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
    if (Math.abs(g - this.model.grip) < 0.004 && Math.abs(this.push - this.pushApplied) < 0.004) return;
    this.pushApplied = this.push; this.model.margin = (o.margin ?? 1) * this.push;
    this.model.grip = g;
    this.lapEstimate = this.line.speeds(this.model, { mass: car.spec.mass + car.fuel * 0.75 });
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
    // in-lap: peel to the pit-side edge on a lane of our own line, never above the host's braking envelope
    const state = context?.state ?? {}, boxing = Boolean(real.race?.boxThisLap || state.pitPlan) && !state.pit, toPit = boxing ? this.pitGuide.toEntry(real.s ?? 0) : Infinity;
    let path = line, pitCap = Infinity;
    if (toPit < 600 && toPit > 0.3) {
      path = this.pitGuide.path ?? this.pitGuide.build(line, model, { mass: real.spec.mass + real.fuel * 0.75 });
      pitCap = this.pitGuide.cap(toPit);
      c = path.closest(car.x, car.z, c.i);
    } else if (this.pitGuide.path) this.pitGuide.reset();
    this.path = path;
    const { i, f, e } = c; this.e = e;
    // ---- lateral ----
    const hPath = path.heading(i, f), beta = Math.atan2(car.v, Math.max(2, car.u));
    const psi = angle(car.yaw + beta - hPath);
    const Lp = clamp(0.32 * v + 7, 9, 32);
    const kp = path.sample(path.ks, i, f, v * (o.preview ?? 0.08));
    const kc = kp - 2 * psi / Lp - e / (Lp * Lp);
    this.ayReq = v * v * kp; this.latCap = model.lat(v);
    const ff = model.steerFor(v * v * kc, v), rDes = v * kc, rErr = rDes - car.yawRate;
    const dBeta = this.dBeta = beta - model.betaFor(v * v * kc, v), slide = Math.sign(dBeta) * Math.max(0, Math.abs(dBeta) - (o.slideBand ?? 0.04));
    this.steer = clamp(ff + (o.yawGain ?? 0.45) * rErr + (o.slideGain ?? 2.2) * slide, -1, 1);
    const over = Math.sign(car.yawRate) === Math.sign(rDes) ? Math.max(0, Math.abs(car.yawRate) - Math.abs(rDes)) : Math.abs(car.yawRate);
    this.stability = clamp(1 - 2.5 * Math.max(0, over - 0.08) - 4 * Math.max(0, Math.abs(dBeta) - (o.betaLimit ?? 0.06)), 0, 1);
    // ---- longitudinal ----
    const look = v * 0.1, d2 = Math.max(4, v * 0.25);
    let vt = path.sample(path.v, i, f, look), vt2 = path.sample(path.v, i, f, look + d2);
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
    real.controls = { throttle, brake, steer: this.steer };
    if (o.learn) this.learn(car, i);
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
      this.line.speeds(this.model, { mass: 1100 });
    }
    this.lapCount ??= 0; this.lapClean = true; this.slipPeak.fill(0);
  }
}
