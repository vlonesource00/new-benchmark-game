import { clamp, angle, wrap, lerp } from './math.js';
import { tyreGrip } from '../../../host/astra/src/sim/tyre.js';
import { CAR_CLASSES } from '../../../host/astra/src/sim/car-specs.js';

export const POLICY_DEFAULTS = Object.freeze({ lookahead: .50, headingGain: 0, yawGain: .4,
  lateralGain: 1, gripUse: .72, brakeUse: .86, driveUse: .90, maxSpeed: 85, speedGain: .85,
  understeer: .004, rearSlip: .18, gripExponent: 1.5,
  slipCut: .22, slipGain: 2, betaGain: 3, throttleFloor: .12,
  execution: 'pursuit', poseLead: .083, velocityGain: 1, rateGain: .18, slipFeed: 1,
  powerProfile: false, dynamicGrip: false, feedforward: false, hotSlipGain: 0, betaAlign: 0, axleModel: 'average',
  forceBudget: false, forceGain: 12, hotReserve: 0, forceSteering: false, forceBetaGain: 1, forceYawGain: .15,
  warmReference: false, warmStart: 100, warmSpan: 12, warmCurvature: 0 });

// Feedback transfers aim for a downstream position AND velocity port. This
// seed policy is independently derived from the physical plant and road gates.
export class TransferPolicy {
  constructor(road, options = {}) {
    this.road = road; this.o = { ...POLICY_DEFAULTS, ...options };
    this.buildEnvelope();
    this.warmPolicy = this.o.warmReference ? new TransferPolicy(road, { ...POLICY_DEFAULTS, warmReference: false }) : null;
  }

  buildEnvelope() {
    const n = this.road.n;
    this.nominal = new Float64Array(n);
    this.portEnvelopes = new Map();
    const mu = 1.36, mass = 1316, aero = .5 * 1.225 * 1.9 * 2.25 / mass;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.road.points[i].curvature), coeff = k - mu * this.o.gripUse * aero;
      this.nominal[i] = coeff > 0 ? Math.min(this.o.maxSpeed, Math.sqrt(mu * this.o.gripUse * 9.81 / coeff)) : this.o.maxSpeed;
    }
    // Only a search seed. Online graph edges are tested against live tyres.
    for (let pass = 0; pass < 5; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n, distance = wrap(this.road.points[j].d - this.road.points[i].d, this.road.length);
        this.nominal[i] = Math.min(this.nominal[i], Math.sqrt(this.nominal[j] ** 2 + 2 * 12 * this.o.brakeUse * distance));
      }
      for (let i = 0; i < n; i++) {
        const j = wrap(i - 1, n), distance = wrap(this.road.points[i].d - this.road.points[j].d, this.road.length);
        const accel = this.o.powerProfile ? this.driveAcceleration(this.nominal[j]) : 5;
        this.nominal[i] = Math.min(this.nominal[i], Math.sqrt(this.nominal[j] ** 2 + 2 * accel * distance));
      }
    }
  }

  driveAcceleration(speed, car = null) {
    // Directly derived from the common host's torque curve and gearbox.
    const spec = car?.spec ?? CAR_CLASSES.gt;
    let gear = 1;
    while (gear < 6 && speed / spec.radius * spec.gears[gear] * spec.finalDrive * 9.5493 > 7450) gear++;
    const ratio = spec.gears[gear] * spec.finalDrive;
    const rpm = Math.max(1100, speed / spec.radius * ratio * 9.5493);
    const torque = spec.maxTorque * clamp(1 - ((rpm - 5500) / 6700) ** 2, .45, 1);
    const mass = spec.mass + (car?.fuel ?? 35) * .75;
    const drag = .5 * 1.225 * spec.area * spec.cd * speed ** 2 / mass;
    return clamp(torque * ratio * .91 / spec.radius / mass - drag - .13, .4, 11);
  }

  envelope(extra = 0, scale = 1) {
    const key = Math.round(extra * 4) / 4;
    if (!this.o.dynamicGrip && (!this.road.options.portGeometry || key === 0)) return this.nominal;
    const mu = this.o.dynamicGrip ? Math.floor(1.36 * scale * 100) / 100 : 1.36;
    const cacheKey = `${this.road.options.portGeometry ? key : 0}:${mu}`;
    if (this.portEnvelopes.has(cacheKey)) return this.portEnvelopes.get(cacheKey);
    const curve = this.road.options.portGeometry && key !== 0 ? this.road.portCurve(key) : this.road.points;
    const n = this.road.n, speed = new Float64Array(n), distance = new Float64Array(n);
    const aero = .5 * 1.225 * 1.9 * 2.25 / 1316;
    for (let i = 0; i < n; i++) {
      const coefficient = Math.abs(curve[i].curvature) - mu * this.o.gripUse * aero;
      speed[i] = coefficient > 0 ? Math.min(this.o.maxSpeed, Math.sqrt(mu * this.o.gripUse * 9.81 / coefficient)) : this.o.maxSpeed;
      distance[i] = curve[i].segment ?? wrap(curve[(i + 1) % n].d - curve[i].d, this.road.length);
    }
    for (let pass = 0; pass < 5; pass++) {
      for (let i = n - 1; i >= 0; i--) speed[i] = Math.min(speed[i], Math.sqrt(speed[(i + 1) % n] ** 2 + 24 * this.o.brakeUse * distance[i]));
      for (let i = 0; i < n; i++) { const j = wrap(i - 1, n), accel = this.o.powerProfile ? this.driveAcceleration(speed[j]) : 5;
        speed[i] = Math.min(speed[i], Math.sqrt(speed[j] ** 2 + 2 * accel * distance[j])); }
    }
    this.portEnvelopes.set(cacheKey, speed);
    if (this.portEnvelopes.size > 160) this.portEnvelopes.delete(this.portEnvelopes.keys().next().value);
    return speed;
  }

  gripScale(car) {
    const grip = car.wheels.map(v => tyreGrip(v.tyre, 3300));
    let rear = (grip[2] + grip[3]) / 2;
    if (this.o.axleModel === 'worst') rear = Math.min(grip[2], grip[3]);
    if (this.o.axleModel === 'loaded') {
      const left = car.wheels[2].load ?? 3300, right = car.wheels[3].load ?? 3300;
      rear = (grip[2] * left + grip[3] * right) / Math.max(1, left + right);
    }
    const weakest = Math.min((grip[0] + grip[1]) / 2, rear);
    const reserve = clamp(1 - this.o.hotReserve * Math.max(0, Math.max(car.wheels[2].tyre.core, car.wheels[3].tyre.core) - 100), .65, 1);
    return this.o.dynamicGrip ? clamp(weakest / 1.36 * reserve, .52, 1.05)
      : clamp(weakest / 1.36, .52, 1.05) ** this.o.gripExponent;
  }

  speed(d, car, scale = this.gripScale(car), extra = 0) {
    const p = this.road.at(d), a = this.road.points[p.index], b = this.road.points[(p.index + 1) % this.road.n];
    const f = wrap(p.d - a.d, this.road.length) / wrap(b.d - a.d, this.road.length);
    const envelope = this.envelope(extra, scale);
    const nominal = lerp(envelope[p.index], envelope[(p.index + 1) % this.road.n], clamp(f, 0, 1));
    let speed = nominal * (this.o.dynamicGrip ? 1 : scale);
    if (this.warmPolicy) {
      const core = Math.max(car.wheels[2].tyre.core, car.wheels[3].tyre.core);
      let weight = clamp((core - this.o.warmStart) / this.o.warmSpan, 0, 1);
      if (this.o.warmCurvature > 0) weight *= clamp((Math.abs(p.curvature) - this.o.warmCurvature * .5) / (this.o.warmCurvature * .5), 0, 1);
      if (weight > 0) speed = lerp(speed, Math.min(speed, this.warmPolicy.speed(d, car)), weight);
    }
    return speed;
  }

  axleAngle(car, start, force) {
    const tyres = car.wheels.slice(start, start + 2);
    const peaks = tyres.map(w => Math.max(0, w.load) * tyreGrip(w.tyre, Math.max(1, w.load)) * car.spec.tyreGrip);
    let low = 0, high = .38;
    for (let iteration = 0; iteration < 9; iteration++) {
      const alpha = (low + high) * .5, sy = Math.tan(alpha) * 8.6;
      const lateral = tyres.reduce((sum, w, i) => {
        const sx = w.tyre.kappa * 10.5, slip = Math.hypot(sx, sy);
        const shape = Math.tanh(slip) * (1 - .16 * clamp((slip - 1.4) / 5, 0, 1));
        return sum + peaks[i] * shape * sy / Math.max(.0001, slip);
      }, 0);
      if (lateral < Math.abs(force)) low = alpha; else high = alpha;
    }
    return Math.sign(force) * (low + high) * .5;
  }

  control(car, transfer = {}, projected = null) {
    const o = this.o, road = this.road, p = projected ?? road.project(car);
    const extra = transfer.extra ?? 0, look = clamp(car.speed * o.lookahead, 8, 28);
    const port = road.port(p.d + look, extra);
    const dx = port.x - car.x, dz = port.z - car.z, length = Math.max(4, Math.hypot(dx, dz));
    // Heading demand is Cartesian. The centreline kink is absent from this law.
    const velocityHeading = Math.atan2(car.vx, car.vz);
    const beta = car.speed > 5 ? angle(velocityHeading - car.yaw) : 0;
    const pursuit = 2 * Math.sin(angle(Math.atan2(dx, dz) - car.yaw)) / length;
    const headingError = angle(port.heading - car.yaw);
    const yawDemand = pursuit * Math.max(4, car.speed);
    let steer = (Math.atan(car.spec.wheelbase * pursuit) + o.understeer * car.speed ** 2 * port.curvature
      + o.headingGain * headingError * .08 + o.lateralGain * beta
      + o.yawGain * (yawDemand - car.yawRate) * .12) / car.spec.steeringLock;
    if (o.execution === 'velocity') {
      // Invert the body/course decomposition at an actuator-lagged pose. The
      // requested world velocity points into the next gate, while measured
      // sideslip and yaw-rate feedback determine the steering execution.
      const px = car.x + car.vx * o.poseLead, pz = car.z + car.vz * o.poseLead;
      const courseError = angle(Math.atan2(port.x - px, port.z - pz) - velocityHeading);
      const courseRate = 2 * Math.max(4, car.speed) * Math.sin(courseError) / length;
      steer = (Math.atan(car.spec.wheelbase * courseRate / Math.max(4, car.speed))
        + o.understeer * car.speed ** 2 * port.curvature + o.slipFeed * beta
        + o.velocityGain * courseError * .12 + o.rateGain * (courseRate - car.yawRate)) / car.spec.steeringLock;
    }
    if (o.forceSteering && car.speed > 6) {
      // Allocate a world-space course acceleration between the two axles and
      // invert the actual combined-slip law. Front-minus-rear slip compliance
      // can change sign as the driven tyres heat; a fixed understeer constant
      // cannot represent that change.
      const courseError = angle(Math.atan2(dx, dz) - velocityHeading);
      const curvature = 2 * Math.sin(courseError) / length;
      const mass = car.spec.mass + car.fuel * .75, lateral = mass * car.speed ** 2 * curvature;
      const frontAngle = this.axleAngle(car, 0, lateral * car.spec.frontWeight);
      const rearAngle = this.axleAngle(car, 2, lateral * (1 - car.spec.frontWeight));
      const betaTarget = car.spec.wheelbase * car.spec.frontWeight * curvature - rearAngle;
      const delta = Math.atan(car.spec.wheelbase * curvature) + frontAngle - rearAngle
        + o.forceBetaGain * (beta - betaTarget) + o.forceYawGain * (car.speed * curvature - car.yawRate);
      steer = delta / car.spec.steeringLock;
    }
    const gripScale = this.gripScale(car);
    steer += o.hotSlipGain * Math.max(0, 1 - gripScale) * beta / car.spec.steeringLock;
    steer += o.betaAlign * Math.sign(beta) * Math.max(0, Math.abs(beta) - .12) / car.spec.steeringLock;
    steer = clamp(steer, -1, 1);
    let target = this.speed(p.d, car, gripScale, extra) * (transfer.factor ?? 1);
    const profileHere = target;
    const profileAhead = this.speed(p.d + 4, car, gripScale, extra) * (transfer.factor ?? 1);
    let plannedAcceleration = clamp((profileAhead ** 2 - profileHere ** 2) / 8, -20, 11);
    // Check braking reachability from this actual arrival state, using gate
    // distance. Scale later demands on live tyre state rather than lap number.
    for (let distance = 12; distance <= Math.min(220, car.speed * 4 + 25); distance += 12) {
      const v = this.speed(p.d + distance, car, gripScale, extra) * (transfer.factor ?? 1);
      const reachable = Math.sqrt(v * v + 2 * 12 * o.brakeUse * distance);
      if (reachable < target) { target = reachable; plannedAcceleration = -12 * o.brakeUse; }
    }
    if (Number.isFinite(transfer.cap) && transfer.cap < target) { target = transfer.cap; plannedAcceleration = Math.min(0, plannedAcceleration); }
    const demand = (target - car.speed) * o.speedGain;
    let throttle = demand > -.35 ? clamp((demand + 1.7) / 4, 0, 1) : 0;
    let brake = demand < -.35 ? clamp(-demand / 11, 0, 1) : 0;
    if (o.feedforward) {
      const mass = car.spec.mass + car.fuel * .75;
      const drag = .5 * 1.225 * car.spec.area * car.spec.cd * car.speed ** 2 / mass + .13;
      const need = plannedAcceleration + (target - car.speed) * o.speedGain + drag;
      throttle = need > 0 ? clamp(need / (this.driveAcceleration(car.speed, car) + drag), 0, 1) : 0;
      brake = need < 0 ? clamp(-need / 22, 0, 1) : 0;
    }
    // A short slip episode is allowed. Growing driven-axle slip gets corrected
    // before yaw demand keeps stealing the rear axle's lateral force.
    const rear = car.wheels.slice(2), slip = Math.max(...rear.map(w => w.tyre.kappa));
    const yawError = Math.abs(car.yawRate - port.curvature * car.speed);
    if (Math.abs(beta) > o.rearSlip && yawError > .12) throttle *= clamp(1 - (Math.abs(beta) - o.rearSlip) * o.betaGain, o.throttleFloor, 1);
    if (slip > o.slipCut) throttle *= clamp(1 - (slip - o.slipCut) * o.slipGain, o.throttleFloor, 1);
    if (o.forceBudget && car.speed > 8) {
      // Inverse of the host tyre's tanh(10.5*kappa) law. Reserve the lateral
      // force needed by this world-velocity port before requesting drive.
      const capacity = rear.reduce((sum, w) => sum + Math.max(0, w.load) * tyreGrip(w.tyre, Math.max(1, w.load)), 0);
      const mass = car.spec.mass + car.fuel * .75;
      const lateral = Math.max(Math.abs(car.ay), Math.abs(port.curvature) * car.speed ** 2);
      const utilisation = clamp(mass * lateral * (1 - car.spec.frontWeight) / Math.max(1000, capacity), 0, .995);
      const longitudinal = clamp(Math.sqrt(1 - utilisation ** 2) * .96, .1, .96);
      const budget = Math.atanh(longitudinal) / 10.5;
      throttle *= clamp(1 - Math.max(0, slip - budget) * o.forceGain, .04, 1);
    }
    if (Number.isFinite(transfer.brake)) { throttle = 0; brake = clamp(transfer.brake, 0, 1); }
    return { controls: { throttle, brake, steer }, targetSpeed: target, aim: port, beta };
  }

}
