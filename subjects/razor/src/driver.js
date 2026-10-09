import { ApexDriver } from '../../apex/src/driver.js';
import { angle, clamp } from '../../apex/src/math.js';
import { TrafficField } from './field.js';
import { RazorCombat } from './combat.js';
import { heldControlPose } from './predict.js';
import { StintBudget } from './stint-budget.js';

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
      this.baseMargin = this.options.margin ?? .97;
      this.stintBudget = new StintBudget(this.track); this.budgetApplied = 1;
    }
  }
  reset() {
    super.reset(); this.lowSince = null; this.kcF = null;
    this.lastR = undefined; this.lastDt = undefined; this.controlPose = null;
    this.tcCap = 1; this.lastStab = 1; this.rebuild = null;
    this.refreshClock = 1; this.forceRefresh = true; this.push = 1; this.pushApplied = 1;
    this.stintBudget?.reset(); this.budgetApplied = 1;
    if (this.baseMargin !== undefined) this.options.margin = this.baseMargin;
  }
  update(car, cars, dt, context = {}) {
    this.now = context.time ?? 0;
    this.controlDelay = context.controlDelay ?? 0;
    this.observationDt = dt;
    this.lastCar = car;
    this.prepare(car);
    if (this.options.adaptiveTyres === true) {
      const state = context.state ?? {};
      const engaged = this.combat?.plan?.kind === 'attack' && ['ATTACK', 'ALONGSIDE', 'CLEAR'].includes(this.combat.state);
      const rival = engaged ? this.field?.byId.get(this.combat.plan.target) : this.field?.list.find(r => r.target && r.ds > 0);
      const factor = this.stintBudget.update(car, state, dt, { rival, maximum: Math.min(this.options.maxTyrePush ?? 1.03, 1 / this.baseMargin),
        engaged, referenceLap: Number.isFinite(car.race?.bestLap) ? car.race.bestLap : undefined });
      this.options.margin = this.baseMargin * factor;
      if (Math.abs(factor - this.budgetApplied) > .002) { this.forceRefresh = true; this.budgetApplied = factor; }
    }
    let hot = 0, wear = 0;
    for (const w of car.wheels) {
      hot = Math.max(hot, w.tyre.core - w.tyre.optimum);
      wear = Math.max(wear, w.tyre.wear);
    }
    // The combined-slip force peak is broad. Extra slip past it only spends
    // tread. Heat and age trim that waste rather than imposing a race-speed cap.
    this.options.tractionSlip = clamp(2.1 - Math.max(0, hot - 20) * 0.004 - Math.max(0, wear - 0.35) * 0.18, 1.86, 2.1);
    const scheduledYaw = this.options.heldYawGain !== undefined && dt + this.controlDelay > 0.075;
    const nominalYaw = this.options.yawGain;
    const previousCurvature = this.kcF;
    const weather = context.state?.weather ?? this.state?.weather ?? 'clear';
    const smoothPedals = this.options.smoothPedals === true && weather === 'clear' && (this.track.wetness ?? 0) < .08;
    const nominalThrust = this.options.freeThrust;
    // Keep one braking envelope in dry racing, rather than changing profiles
    // whenever a threat appears. Rain retains the existing control policy.
    if (smoothPedals && nominalThrust === undefined) this.options.freeThrust = true;
    this.pedalEnvelope = this.options.freeThrust;
    if (scheduledYaw) this.options.yawGain = this.options.heldYawGain;
    try { super.update(car, cars, dt, context); }
    finally {
      if (scheduledYaw) {
        if (nominalYaw === undefined) delete this.options.yawGain;
        else this.options.yawGain = nominalYaw;
      }
      if (nominalThrust === undefined) delete this.options.freeThrust;
      else this.options.freeThrust = nominalThrust;
    }
    if (smoothPedals) {
      this.trackCorrection(car, dt, previousCurvature);
      this.longitudinal(car);
    }
    if (cars?.length > 1 && this.path === this.combat?.plan?.path && this.combat.noseBrake > 0) {
      car.controls.throttle = 0;
      car.controls.brake = Math.max(car.controls.brake, this.combat.noseBrake);
    }
  }
  trackCorrection(real, dt, previousCurvature) {
    const gain = this.options.trackingGain ?? 1;
    if (gain === 1 || !(this.controlDelay > 0) || this.path !== this.line || this.nb || !Number.isFinite(this.kcF)) return;
    const car = this.controlPose ?? real, v = Math.max(.5, car.speed), o = this.options;
    const preview = clamp(.32 * v + 7, 9, 32), path = this.path;
    const q = path.closest(car.x, car.z, this.cur.i), beta = Math.atan2(car.v, Math.max(2, car.u));
    const psi = angle(car.yaw + beta - path.heading(q.i, q.f));
    const limit = (o.fbShare ?? .45) * this.model.lat(v) / (v * v);
    const feedback = clamp(-2 * psi / preview - gain * q.e / (preview * preview), -limit, limit);
    let curvature = path.sample(path.ks, q.i, q.f, v * (o.preview ?? .08)) + feedback;
    // Only an asynchronous seat's older observation needs this extra position
    // feedback. It shares the inherited tracker's existing jerk budget.
    if (Number.isFinite(previousCurvature) && dt > 0) {
      const step = (o.steerJerk ?? 65) * dt / (v * v);
      curvature = clamp(curvature, previousCurvature - step, previousCurvature + step);
    }
    const cap = (o.ayMapCap ?? .98) * this.model.lat(v) / Math.max(.5, this.model.margin);
    const ay = clamp(curvature * v * v, -cap, cap);
    const error = beta - this.model.betaFor(ay, v);
    const slide = Math.sign(error) * Math.max(0, Math.abs(error) - (o.slideBand ?? .04));
    this.steer = clamp(this.model.steerFor(ay, v) + (o.yawGain ?? .45) * (ay / Math.max(2, v) - car.yawRate)
      + (o.slideGain ?? 2.2) * slide, -1, 1);
    this.kcF = curvature; real.controls.steer = this.steer;
  }
  longitudinal(real) {
    const previous = real.controls;
    const car = this.controlPose ?? real, path = this.path, model = this.model, o = this.options;
    const v = Math.max(.5, car.speed), q = path.closest(car.x, car.z, this.cur.i);
    const look = v * .1, distance = Math.max(4, v * .25), wake = car.aero?.wake ?? 0;
    const envelope = this.pedalEnvelope ?? (this.combat?.state !== 'FREE' || wake > (o.towWake ?? .05));
    const profile = envelope ? path.vbrk : path.v;
    let next = path.sample(profile, q.i, q.f, look + distance);
    if (wake > .05) {
      const limited = j => path.vmax[path.idx(q.i + j)] < path.v[path.idx(q.i + j)] + 2;
      if (limited(1) || limited(Math.round(look / path.ds) + 2)) next *= model.wakeSpeed(v, wake);
    }
    if (path !== this.pitGuide.path) next = Math.min(next, this.combat?.cap ?? Infinity);
    if (this.nbShed) next = Math.min(next, v * (o.nbShed ?? .9));
    if (path === this.pitGuide.path) next = Math.min(next, this.pitGuide.cap(Math.max(0, this.pitGuide.toEntry(real.s) - distance)));
    const mass = real.spec.mass + real.fuel * .75;
    const drag = model.dragN * v * v * (1 - Math.min(.95, wake) * .42) / mass + .13;
    const acceleration = Math.max(.5, model.driveG(v, Math.max(1, real.gear), mass));
    this.speedCeiling = this.targetSpeed;
    if (o.reachableTarget === true) {
      // A braking ceiling far above the car is permission to accelerate, not
      // an instantly reachable speed. Both previews use the same achievable
      // acceleration so a remote high ceiling cannot invent a braking slope.
      this.targetSpeed = Math.min(this.targetSpeed, Math.sqrt(v * v + 2 * acceleration * look));
      next = Math.min(next, Math.sqrt(v * v + 2 * acceleration * (look + distance)));
    }
    const gradient = (next * next - this.targetSpeed * this.targetSpeed) / (2 * distance);
    // One signed wheel-force request crosses continuously through coasting.
    // Separate throttle/brake thresholds repeatedly opposed each other near
    // a corner's speed ceiling, even on a smooth profile with settled tyres.
    const drive = Math.max(.5, acceleration + drag);
    const demand = gradient + (o.longitudinalGain ?? 10) * (this.targetSpeed - v) + drag;
    const braking = Math.max(3, model.brake(v) - drag);
    let throttle = clamp(demand / drive, 0, 1), brake = clamp(-demand / braking, 0, 1);
    throttle = Math.min(throttle, Math.max(o.throttleFloor ?? .2, this.share * (o.throttleAllow ?? 1.25)), this.tcCap);
    brake = Math.min(brake, Math.max(o.brakeFloor ?? .12, this.share * (o.brakeAllow ?? 1.15)));
    throttle *= this.protect * this.stability;
    if (this.sR > (o.slipHi ?? 2.15)) brake *= this.protect;
    brake *= this.stability;
    // Preserve the validated pedal policy on a committed combat corridor.
    // A second far-preview brake request can erase its passing opportunity.
    const committed = path === this.combat?.plan?.path && ['attack', 'cover', 'hold', 'evade'].includes(this.combat.plan.kind);
    if (committed) {
      throttle = previous.throttle; brake = previous.brake;
    }
    real.controls.throttle = throttle; real.controls.brake = brake;
    this.mode = brake > .02 ? 'BRAKE' : throttle > .95 || (Math.abs(this.ayReq) < 4 && throttle > .5) ? 'PUSH' : 'CORNER';
    this.pedalDemand = demand; this.profileGradient = gradient; this.profileKind = envelope ? 'braking ceiling' : 'pace profile';
    this.labelIntent(path === this.pitGuide.path);
  }
  predict(car, dt) {
    const heldThreshold = this.classId === 'gt' ? 0.0251 : 0.075;
    if (this.options.physicalPrediction === true && (this.controlDelay > 0 || this.classId === 'gt' && dt > 1 / 30 + 1e-6)
      && dt + this.controlDelay > heldThreshold) {
      this.delay = clamp(this.controlDelay + dt * 0.5, 0.008, 0.06);
      this.posePrediction = 'held controls';
      this.lastR = car.yawRate; this.lastDt = dt;
      this.controlPose = heldControlPose(car, this.track, this.delay);
      return this.controlPose;
    }
    this.posePrediction = 'extrapolated';
    // GT3 aims at the centre of the next held interval after measured transport
    // age. GTP retains the faster controller's calibrated preview at healthy
    // rates; long-held GTP inputs use the chassis forecast above instead.
    const held = this.classId === 'gt' && this.controlDelay > 0 ? 0.5 : dt <= 1 / 30 + 1e-6 ? 1.5 : 0.5;
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
    const budget = this.stintBudget?.report;
    if (this.intent === 'PACE' && budget?.eligible && budget.factor > 1.002) {
      this.sub = `${budget.mode} push · grip budget +${((budget.factor - 1) * 100).toFixed(1)}% · ${budget.stintRemaining.toFixed(1)} laps left`;
    }
  }
  debug() {
    const debug = super.debug();
    return { ...debug, architecture: 'RAZOR', planSource: 'dynamic corridors', slipBudget: this.options.tractionSlip,
      noseBrake: this.combat?.noseBrake ?? 0,
      longitudinal: { demand: this.pedalDemand, gradient: this.profileGradient, ceiling: this.speedCeiling, profile: this.profileKind },
      stintBudget: this.stintBudget?.report,
      controlTiming: { observationDt: this.observationDt, prediction: this.delay, replyAge: this.controlDelay, predictor: this.posePrediction },
      neighbor: this.nb, requestedCurvature: this.kcF,
      combat: { ...debug.combat, clearance: this.combat?.plan?.clearance,
        cands: (this.combat?.visCands ?? []).map(c => ({ kind: c.kind, side: c.side, score: c.score, risk: c.risk,
        chosen: c.chosen, clear: c.clear, endGap: c.endGap })), evidence: 'Associated passes require paired validation; pace passes are not move proof.' } };
  }
}
