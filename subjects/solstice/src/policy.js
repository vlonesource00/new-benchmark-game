import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { clamp, angle } from './math.js';

export const POLICY_DEFAULTS = Object.freeze({
  lookahead: .55, poseLead: .02, betaGain: 1.7, yawGain: .15,
  speedGain: 3.5, tractionSlip: .095, gripUse: .93, brakeAccel: 21,
  minLook: 9, maxLook: 34, slipLimit: .16, execution: 'force', understeer: .004,
  geometricBeta: .65, geometricYaw: .16, previewBrake: 12, brakeLead: .18,
  combinedDrive: false, brakeFloor: 5.5, axleBrake: false, rotation: 0,
  hotDriveSlip: .085, thermalCore: 88, rearSlipLimit: null,
  actualBrakeReserve: false, courseForceLimit: 0, saturationBrakeShare: 0,
  yawResponse: 8, slipResponse: 7.7, warmForceTransition: false,
  cornerGripUse: .91, warmCornerGripUse: null, warmGuardCore: 90, warmGuardRange: 6
});

export class ForcePolicy {
  constructor(track, path, options = {}) {
    this.track = track; this.path = path; this.o = { ...POLICY_DEFAULTS, ...options };
    this.lastTarget = null; this.targetSpeed = 0;
  }

  point(s, plan) {
    return plan.hold == null ? this.path.at(s, plan.extra ?? 0, plan.bounds)
      : (() => { const p = this.track.at(s, plan.hold);
        return { ...p, offset: plan.hold,
          curvature: p.curvature / Math.max(.2, 1 - p.curvature * plan.hold) }; })();
  }

  axleSlip(car, start, force, grip) {
    const spec = car.spec, mass = spec.mass + car.fuel * .75;
    const share = start === 0 ? spec.frontWeight : 1 - spec.frontWeight;
    const downforce = car.aero?.downforce ?? 0;
    let lo = 0, hi = start === 2 ? (this.o.rearSlipLimit ?? this.o.slipLimit) : this.o.slipLimit;
    const tyres = [car.wheels[start], car.wheels[start + 1]];
    const peaks = tyres.map(w => {
      const load = w.load > 100 ? w.load : (mass * 9.81 * share + downforce * share) / 2;
      return load * tyreGrip(w.tyre, load) * spec.tyreGrip * grip;
    });
    for (let i = 0; i < 8; i++) {
      const a = (lo + hi) / 2, sy = Math.tan(a) * 8.6;
      let lateral = 0;
      for (let j = 0; j < 2; j++) {
        const sx = tyres[j].tyre.kappa * 10.5, slip = Math.hypot(sx, sy);
        const shape = Math.tanh(slip) * (1 - .16 * clamp((slip - 1.4) / 5, 0, 1));
        lateral += peaks[j] * shape * sy / Math.max(1e-6, slip);
      }
      if (lateral < Math.abs(force)) lo = a; else hi = a;
    }
    return Math.sign(force) * (lo + hi) / 2;
  }

  control(car, projection, plan = {}, speedCap = Infinity) {
    const o = this.o, spec = car.spec, speed = car.speed;
    const look = clamp(o.minLook + speed * (plan.lookahead ?? o.lookahead), o.minLook, o.maxLook);
    const target = this.point(projection.s + look, plan);
    const course = speed > 3 ? Math.atan2(car.vx, car.vz) : car.yaw;
    const beta = speed > 5 ? angle(course - car.yaw) : 0;
    const dx = target.x - car.x - car.vx * o.poseLead;
    const dz = target.z - car.z - car.vz * o.poseLead;
    const length = Math.max(5, Math.hypot(dx, dz));
    let curvature = 2 * Math.sin(angle(Math.atan2(dx, dz) - course)) / length;
    if (o.execution === 'course' && speed > 8) {
      const here = this.point(projection.s, plan);
      const preview = this.point(projection.s + look * .25, plan);
      const lateralError = (car.x - here.x) * Math.cos(here.heading) - (car.z - here.z) * Math.sin(here.heading);
      curvature = preview.curvature - 2 * Math.sin(angle(course - here.heading)) / look - 2 * lateralError / (look * look);
    }
    const mass = spec.mass + car.fuel * .75;
    const rearTyres = car.wheels.slice(2, 4).map(w => w.tyre);
    const warmRear = clamp((Math.max(...rearTyres.map(t => t.core)) - 86) / 18, 0, 1);
    const usedRear = clamp((Math.max(...rearTyres.map(t => t.wear)) - .12) / .38, 0, 1);
    // Force feasibility protects replacement tyres as soon as they heat up.
    // Its gate is independent of the stricter temperature AND wear gate for
    // deliberately sliding the rear: a fresh warm set still needs braking.
    const warmForce = o.warmForceTransition ? clamp((Math.max(...rearTyres.map(t => t.core))
      - o.warmGuardCore) / Math.max(1, o.warmGuardRange), 0, 1) : 1;
    const actualBrakeReserve = o.actualBrakeReserve && warmForce > .1;
    const requestedCurvature = curvature;
    if (o.courseForceLimit > 0 && speed > 8) {
      const surface = this.track.surface(car.x, car.z).grip;
      const capacity = [0, 2].map(start => car.wheels.slice(start, start + 2).reduce((sum, w) => {
        const share = start === 0 ? spec.frontWeight : 1 - spec.frontWeight;
        const load = w.load > 100 ? w.load : (mass * 9.81 + (car.aero?.downforce ?? 0)) * share / 2;
        return sum + load * tyreGrip(w.tyre, load) * spec.tyreGrip * surface;
      }, 0));
      const limit = Math.min(capacity[0] / (mass * spec.frontWeight), capacity[1] / (mass * (1 - spec.frontWeight)))
        * o.courseForceLimit / (speed * speed);
      curvature += (clamp(curvature, -limit, limit) - curvature) * warmForce;
    }
    // Additional rotation belongs to a warm, used tyre. Temperature alone
    // must not provoke a slide on fresh tyres after a pit stop.
    const hereCurvature = Math.abs(this.point(projection.s, plan).curvature);
    const aheadCurvature = Math.abs(this.point(projection.s + Math.min(look, 18), plan).curvature);
    const rotation = clamp(plan.rotation ?? o.rotation, 0, 1) * warmRear * usedRear
      * clamp((aheadCurvature - hereCurvature) * 150 + .25, 0, 1)
      * clamp(Math.abs(curvature) * speed * 1.5, 0, 1);
    this.lastRotation = rotation;
    let delta;
    if (speed < 8) {
      delta = Math.atan(2 * spec.wheelbase * Math.sin(angle(Math.atan2(dx, dz) - car.yaw)) / length);
    } else if (o.execution === 'pursuit') {
      const pursuit = 2 * Math.sin(angle(Math.atan2(dx, dz) - car.yaw)) / length;
      delta = Math.atan(spec.wheelbase * pursuit) + o.understeer * speed * speed * target.curvature
        + o.geometricBeta * beta + o.geometricYaw * (speed * pursuit - car.yawRate);
    } else {
      const grip = this.track.surface(car.x, car.z).grip;
      const force = mass * speed * speed * curvature;
      const front = this.axleSlip(car, 0, force * spec.frontWeight, grip);
      const rear = this.axleSlip(car, 2, force * (1 - spec.frontWeight), grip);
      // Deliberate rear rotation is an entry phase of the feedback policy.
      // It releases as curvature opens so the exit can use engine torque.
      const betaTarget = spec.wheelbase * spec.frontWeight * curvature - rear - Math.sign(curvature) * .08 * rotation;
      if (o.execution === 'force-yaw') {
        const frontLever = spec.wheelbase * (1 - spec.frontWeight);
        const yawTarget = speed * curvature + o.slipResponse * (beta - betaTarget);
        const yawMoment = spec.yawInertia * o.yawResponse * (yawTarget - car.yawRate);
        const rearMoment = car.wheels.slice(2, 4).reduce((sum, w) => sum + w.tyre.fy * w.z, 0);
        const longitudinalMoment = car.wheels.reduce((sum, w) => sum - w.tyre.fx * w.x, 0);
        const frontForce = (yawMoment + car.yawRate * 130 - rearMoment - longitudinalMoment) / frontLever;
        const frontSlip = this.axleSlip(car, 0, frontForce, grip);
        delta = beta + Math.atan2(car.yawRate * frontLever, Math.max(4, car.u)) + frontSlip;
      } else {
        delta = Math.atan(spec.wheelbase * curvature) + front - rear
          + o.betaGain * (plan.stability ?? 1) * (beta - betaTarget)
          + o.yawGain * (speed * curvature * (1 + .2 * rotation) - car.yawRate);
      }
    }
    const steer = clamp(delta / spec.steeringLock, -1, 1);
    const factor = plan.factor ?? 1;
    const envelope = plan.hold == null ? this.path.variantEnvelope(plan.extra ?? 0, plan.bounds) : this.path.laneEnvelope(plan.hold);
    const brakingEnvelope = (plan.brakingHold ?? plan.hold) == null
      ? this.path.variantEnvelope(plan.extra ?? 0, plan.brakingBounds ?? plan.bounds)
      : this.path.laneEnvelope(plan.brakingHold ?? plan.hold);
    const reference = s => Math.min(this.path.sample(envelope, s), this.path.sample(brakingEnvelope, s)) * factor;
    let targetSpeed = Math.min(speedCap, reference(projection.s + 2));
    for (let ahead = 12; ahead < Math.min(240, speed * 4 + 30); ahead += 8) {
      const v = reference(projection.s + ahead);
      const brakingDistance = Math.max(0, ahead - speed * o.brakeLead);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(v * v + 2 * o.previewBrake * brakingDistance));
    }
    // A lane transfer changes curvature. Slow only for its actual course
    // demand rather than for the mere presence of traffic.
    const grip = Math.min(...car.wheels.map(w => tyreGrip(w.tyre, Math.max(1000, w.load)))) * spec.tyreGrip
      * this.track.surface(car.x, car.z).grip;
    const cornerUse = o.cornerGripUse + ((o.warmCornerGripUse ?? o.cornerGripUse) - o.cornerGripUse)
      * clamp(warmRear * usedRear * 4, 0, 1);
    const available = grip * (9.81 + (car.aero?.downforce ?? 0) / mass) * clamp(cornerUse, .55, .99);
    const lateral = speed * speed * Math.abs(curvature);
    if (Math.abs(requestedCurvature) > .0015) targetSpeed = Math.min(targetSpeed, Math.sqrt(available / Math.abs(requestedCurvature)));
    const next = reference(projection.s + 8), here = reference(projection.s + 2);
    const feed = clamp((next * next - here * here) / 12, -o.brakeAccel, 10);
    let demand = feed + o.speedGain * (targetSpeed - speed);
    const brakingLateral = actualBrakeReserve ? Math.abs(car.ay) : lateral;
    const longitudinal = Math.sqrt(Math.max(1, available * available - Math.min(available, brakingLateral) ** 2));
    const brakingFloor = o.saturationBrakeShare > 0 && warmForce > .1
      ? Math.max(o.brakeFloor, clamp((speed - targetSpeed) * 1.5, 0, 6)) : o.brakeFloor;
    demand = clamp(demand, -Math.max(brakingFloor, longitudinal), Math.max(1.5, longitudinal));
    const ratio = spec.gears[car.gear] * spec.finalDrive;
    const rpm = car.rpm;
    const torque = spec.maxTorque * clamp(1 - ((rpm - 5500) / 6700) ** 2, .45, 1);
    const drive = Math.max(1, torque * ratio * .91 / spec.radius / mass);
    const drag = .5 * 1.225 * spec.area * spec.cd * speed * speed / mass + .13;
    let throttle = clamp((demand + drag) / drive, 0, 1);
    const brakeTorqueAcceleration = 2 * spec.brakeTorque / (spec.radius * mass);
    let brake = clamp((-demand - drag) / brakeTorqueAcceleration, 0, 1);
    const driven = spec.drive === 'front' ? 0 : 2;
    if (o.combinedDrive && speed > 5) {
      let force = 0;
      const rearCore = Math.max(...car.wheels.slice(driven, driven + 2).map(w => w.tyre.core));
      const warmth = clamp((rearCore - o.thermalCore) / 12, 0, 1);
      const driveSlip = .085 + (o.hotDriveSlip - .085) * warmth;
      for (const w of car.wheels.slice(driven, driven + 2)) {
        const load = Math.max(100, w.load), peak = load * tyreGrip(w.tyre, load) * spec.tyreGrip * this.track.surface(car.x, car.z).grip;
        const sx = driveSlip * 10.5, sy = Math.tan(clamp(w.tyre.alpha, -1.2, 1.2)) * 8.6;
        const slip = Math.hypot(sx, sy);
        const shape = Math.tanh(slip) * (1 - .16 * clamp((slip - 1.4) / 5, 0, 1));
        force += peak * shape * sx / Math.max(1e-6, slip);
      }
      throttle = Math.min(throttle, force / (drive * mass));
    }
    if (o.axleBrake && brake > 0 && speed > 5) {
      const caps = [0, 2].map(start => car.wheels.slice(start, start + 2).reduce((sum, w) =>
        sum + Math.max(100, w.load) * tyreGrip(w.tyre, Math.max(100, w.load)) * spec.tyreGrip * this.track.surface(car.x, car.z).grip, 0));
      const ay = Math.max(Math.abs(car.ay), lateral);
      const frontLateral = actualBrakeReserve ? Math.abs(car.wheels[0].tyre.fy + car.wheels[1].tyre.fy) : mass * ay * spec.frontWeight;
      const rearLateral = actualBrakeReserve ? Math.abs(car.wheels[2].tyre.fy + car.wheels[3].tyre.fy) : mass * ay * (1 - spec.frontWeight);
      // Combined-slip forces can trade lateral force for braking. Do not
      // demand that the *previous* full lateral force survive unchanged when
      // an overspeed car now needs to brake. The private rollout evaluates
      // the resulting rotation and rejects an unstable pressure request.
      const trade = targetSpeed < speed - .7 ? clamp(o.saturationBrakeShare, 0, .5) * warmForce : 0;
      const front = Math.max(caps[0] * trade,
        Math.sqrt(Math.max(0, (caps[0] * .94) ** 2 - frontLateral ** 2)));
      const rear = Math.max(caps[1] * trade,
        Math.sqrt(Math.max(0, (caps[1] * (.94 + .08 * rotation)) ** 2 - rearLateral ** 2)));
      const bias = car.setup.brakeBias;
      brake = Math.min(brake, Math.min(front / bias, rear / (1 - bias)) / mass / brakeTorqueAcceleration);
    }
    const spin = Math.max(car.wheels[driven].tyre.kappa, car.wheels[driven + 1].tyre.kappa);
    throttle *= clamp(1 - Math.max(0, spin - o.tractionSlip) * 12, .12, 1);
    // Keep tyre feedback on the ascending force branch. This is control,
    // never a write to setup, gearbox, wheel or engine state.
    const betaLimit = .20 + .06 * rotation;
    if (Math.abs(beta) > betaLimit) throttle *= clamp(1 - (Math.abs(beta) - betaLimit) * 5, .1, 1);
    if (targetSpeed < speed - .7) throttle = 0;
    if (brake > .01) throttle = 0; else brake = 0;
    if (plan.coast && targetSpeed > speed && targetSpeed - speed < 4 && Math.abs(curvature) < .004) throttle = 0;
    this.lastTarget = target; this.targetSpeed = targetSpeed;
    return { throttle, brake, steer };
  }
}
