import { CarModel, liveGrip } from './model.js';
import { Line } from './line.js';
import { clamp, angle } from './math.js';

/**
 * APEX driver. Writes only `car.controls` (and, for the GTP energy manager, `car.intent`).
 * M1 pace core: identified g-g-v model → baked minimum-time line → quasi-steady-state speed profile →
 * curvature-preview tracker with yaw-rate and sideslip feedback.
 */
export class ApexDriver {
  constructor(track, options = {}) {
    this.track = track; this.options = options;
    this.model = null; this.line = null; this.mode = 'INIT'; this.targetSpeed = 0;
    this.steer = 0; this.cursor = -1; this.stability = 1;
  }
  prepare(car) {
    if (this.line && this.classId === car.classId) return;
    this.classId = car.classId;
    const o = this.options;
    this.model = new CarModel(car.classId);
    this.line = new Line(this.track, { ds: o.lines?.[this.track.id]?.[car.classId]?.ds ?? 3, edge: o.edge ?? -0.5 });
    const baked = o.lines?.[this.track.id]?.[car.classId];
    if (!this.line.load(baked)) { this.line.seed(); this.line.optimise(this.model, { iterations: o.quickIterations ?? 4000, seed: 7 }); }
    this.model.margin = o.margin ?? 1; this.model.jerk = o.jerk ?? 0;
    this.line.speeds(this.model);
    this.cursor = -1;
    this.slipPeak = new Float32Array(this.line.N); this.lapClean = true; this.lastStation = -1; this.learned = 0; this.lapCount = 0;
  }
  reset() { this.steer = 0; this.cursor = -1; this.sent = null; }
  debug() { return { architecture: 'APEX', intent: this.mode, targetSpeed: this.targetSpeed, e: this.e, stability: this.stability, grip: this.model?.grip }; }
  /** Live grip: the game's tyre formula for each wheel, relative to the identification reference. */
  refresh(car) {
    const g = liveGrip(car, this.model) * (1 - (this.track.wetness ?? 0) * 0.36) * (this.track.tempGrip ?? 1);
    if (Math.abs(g - this.model.grip) < 0.004) return;
    this.model.grip = g;
    this.lapEstimate = this.line.speeds(this.model, { mass: car.spec.mass + car.fuel * 0.75 });
  }
  update(car, cars, dt, context) {
    this.prepare(car);
    const track = this.track, line = this.line, model = this.model, o = this.options;
    const v = Math.max(0.5, car.speed);
    this.refreshClock = (this.refreshClock ?? 99) + dt;
    if (this.refreshClock > 0.25) { this.refreshClock = 0; this.refresh(car); }
    let c = line.closest(car.x, car.z, this.cursor);
    if (c.d2 > 400) c = line.closest(car.x, car.z, -1);
    this.cursor = c.i;
    const { i, f, e } = c; this.e = e;
    // ---- lateral ----
    const hPath = line.heading(i, f), beta = Math.atan2(car.v, Math.max(2, car.u));
    const psi = angle(car.yaw + beta - hPath);
    const Lp = clamp(0.32 * v + 7, 9, 32);
    const kp = line.sample(line.ks, i, f, v * 0.08);
    const kc = kp - 2 * psi / Lp - e / (Lp * Lp);
    this.ayReq = v * v * kp; this.latCap = model.lat(v);
    const ff = model.steerFor(v * v * kc, v), rDes = v * kc, rErr = rDes - car.yawRate;
    const dBeta = beta - model.betaFor(v * v * kc, v), slide = Math.sign(dBeta) * Math.max(0, Math.abs(dBeta) - (o.slideBand ?? 0.04));
    this.steer = clamp(ff + (o.yawGain ?? 0.45) * rErr + (o.slideGain ?? 2.2) * slide, -1, 1);
    const over = Math.sign(car.yawRate) === Math.sign(rDes) ? Math.max(0, Math.abs(car.yawRate) - Math.abs(rDes)) : Math.abs(car.yawRate);
    this.stability = clamp(1 - 2.5 * Math.max(0, over - 0.08) - 4 * Math.max(0, Math.abs(dBeta) - (o.betaLimit ?? 0.06)), 0, 1);
    // ---- longitudinal ----
    const look = v * 0.1, d2 = Math.max(4, v * 0.25);
    const vt = line.sample(line.v, i, f, look), vt2 = line.sample(line.v, i, f, look + d2);
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
    brake *= this.stability; throttle *= this.stability;
    this.mode = brake > 0 ? 'BRAKE' : throttle > 0.95 ? 'PUSH' : 'CORNER';
    car.controls = { throttle, brake, steer: this.steer };
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
