import { ApexDriver } from '../../apex/src/driver.js';
import { clamp } from '../../apex/src/math.js';
import { TrafficField } from './field.js';
import { RazorCombat } from './combat.js';
import { heldControlPose } from './predict.js';

// Share the identified vehicle model and baked geometry, not APEX's tactical
// policy. RAZOR owns observations, corridors, commitment and slip expenditure.
export class RazorDriver extends ApexDriver {
  prepare(car) {
    super.prepare(car);
    // Close overlap constrains steering. Longitudinal intervention belongs to
    // RAZOR's verified front-bumper obstruction, not the shared side guard.
    if (this.options.overlapPedalCap === false) this.options.nbShed = Infinity;
    if (!(this.combat instanceof RazorCombat)) {
      this.field = new TrafficField(this.track);
      this.combat = new RazorCombat(this);
    }
  }
  reset() {
    super.reset(); this.lowSince = null; this.kcF = null;
    this.lastR = undefined; this.lastDt = undefined; this.controlPose = null;
    this.tcCap = 1; this.lastStab = 1; this.rebuild = null;
    this.refreshClock = 1; this.forceRefresh = true; this.push = 1; this.pushApplied = 1;
  }
  update(car, cars, dt, context = {}) {
    this.now = context.time ?? 0;
    this.controlDelay = context.controlDelay ?? 0;
    this.observationDt = dt;
    this.lastCar = car;
    let hot = 0, wear = 0;
    for (const w of car.wheels) {
      hot = Math.max(hot, w.tyre.core - w.tyre.optimum);
      wear = Math.max(wear, w.tyre.wear);
    }
    // The combined-slip force peak is broad. Extra slip past it only spends
    // tread. Heat and age trim that waste rather than imposing a race-speed cap.
    this.options.tractionSlip = clamp(2.1 - Math.max(0, hot - 20) * 0.004 - Math.max(0, wear - 0.35) * 0.18, 1.86, 2.1);
    super.update(car, cars, dt, context);
    if (cars?.length > 1 && this.path === this.combat?.plan?.path && this.combat.noseBrake > 0) {
      car.controls.throttle = 0;
      car.controls.brake = Math.max(car.controls.brake, this.combat.noseBrake);
    }
  }
  predict(car, dt) {
    if (this.options.physicalPrediction === true && this.classId === 'gt' && this.controlDelay > 0
      && dt + this.controlDelay > 0.0251) {
      this.delay = clamp(this.controlDelay + dt * 0.5, 0.008, 0.06);
      this.posePrediction = 'held controls';
      this.lastR = car.yawRate; this.lastDt = dt;
      this.controlPose = heldControlPose(car, this.track, this.delay);
      return this.controlPose;
    }
    this.posePrediction = 'extrapolated';
    // Predict the actual held-control age, rather than treating a slower
    // decision rate as an extra one-and-a-half frames of transport latency.
    // Once reply age is measured, it already accounts for transport. Add
    // only half the next held interval, otherwise a worker aims too far ahead.
    const held = this.controlDelay > 0 ? 0.5 : dt <= 1 / 30 + 1e-6 ? 1.5 : 0.5;
    const horizon = clamp(this.controlDelay + dt * held, 0.008, 0.06);
    // Use the bounded extrapolator only where its chassis response has been
    // validated. GTP needs its existing faster angular prediction in fights.
    if (!(this.controlDelay > 0) || !Number.isFinite(this.options.predictionJerk)) {
      this.controlPose = super.predict(car, Math.max(0.0126, horizon / 1.5));
      return this.controlPose;
    }
    const delay = this.delay = Math.max(0.0189, horizon), r0 = car.yawRate;
    const angularBudget = this.options.predictionJerk / Math.max(12, car.speed);
    const dr = this.lastR === undefined ? 0 : clamp((r0 - this.lastR) / Math.max(0.001, this.lastDt ?? dt), -angularBudget, angularBudget);
    this.lastR = r0; this.lastDt = dt;
    // A held steering command cannot sustain an arbitrary yaw-acceleration
    // spike. Extrapolate only the angular change our commanded jerk supports;
    // the measured yaw rate itself is retained, including a real slide.
    const sn = Math.sin(car.yaw), cs = Math.cos(car.yaw);
    const vx = car.vx + (car.ax * sn + car.ay * cs) * delay;
    const vz = car.vz + (car.ax * cs - car.ay * sn) * delay;
    const yawRate = r0 + dr * delay, yaw = car.yaw + 0.5 * (r0 + yawRate) * delay;
    const u = vx * Math.sin(yaw) + vz * Math.cos(yaw), v = vx * Math.cos(yaw) - vz * Math.sin(yaw);
    this.controlPose = Object.create(car, {
      x: { value: car.x + 0.5 * (car.vx + vx) * delay }, z: { value: car.z + 0.5 * (car.vz + vz) * delay },
      yaw: { value: yaw }, yawRate: { value: yawRate }, vx: { value: vx }, vz: { value: vz }, u: { value: u }, v: { value: v }, speed: { value: Math.hypot(u, v) }
    });
    return this.controlPose;
  }
  labelIntent(pitting) {
    const cs = pitting ? 'PIT' : this.combat?.plan?.defendingReturn ? 'DEFEND' : this.combat?.state ?? 'FREE';
    if (this.stability < 0.3 && this.lastCar?.speed > 8) this.lowSince ??= this.now;
    else this.lowSince = null;
    const recovering = this.lowSince !== null && this.now - this.lowSince >= (this.options.recoveryHold ?? 0.18);
    this.intent = recovering ? 'RECOVER' : { PIT: 'PIT', ATTACK: 'ATTACK', ALONGSIDE: 'ALONGSIDE', CLEAR: 'ATTACK', TOW: 'TOW', DEFEND: 'DEFEND', EVADE: 'EVADE', BLOCKED: 'WAIT' }[cs] ?? 'PACE';
    const p = this.combat?.plan, side = p?.side > 0 ? 'right' : 'left';
    this.sub = p?.kind === 'attack' ? `committed ${side} corridor · accelerate in owned space`
      : cs === 'TOW' ? 'tracking the moving wake'
      : cs === 'DEFEND' ? 'one cover · maintain exit speed'
      : cs === 'EVADE' ? 'open-space escape'
      : cs === 'PURSUE' ? 'fast line · close the gap before moving'
      : cs === 'BLOCKED' ? 'road blocked · braking before the obstacle'
      : Number.isFinite(this.combat?.cap) ? 'nose blocked · escape not yet reachable'
      : p?.kind === 'return' ? 'smooth return to fast line' : this.mode?.toLowerCase() ?? '';
  }
  debug() {
    const debug = super.debug();
    return { ...debug, architecture: 'RAZOR', planSource: 'dynamic corridors', slipBudget: this.options.tractionSlip,
      noseBrake: this.combat?.noseBrake ?? 0,
      controlTiming: { observationDt: this.observationDt, prediction: this.delay, replyAge: this.controlDelay, predictor: this.posePrediction },
      neighbor: this.nb, requestedCurvature: this.kcF,
      combat: { ...debug.combat, clearance: this.combat?.plan?.clearance,
        cands: (this.combat?.visCands ?? []).map(c => ({ kind: c.kind, side: c.side, score: c.score, risk: c.risk,
        chosen: c.chosen, clear: c.clear, endGap: c.endGap })), evidence: 'Associated passes require paired validation; pace passes are not move proof.' } };
  }
}
