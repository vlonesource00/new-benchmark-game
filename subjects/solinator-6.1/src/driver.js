import { RoadGates } from './road.js';
import { TransferPolicy } from './policy.js';
import { Plant, clearance, footprint, resources } from './plant.js';
import { clamp, delta, wrap, lerp } from './math.js';

export class Solinator61 {
  constructor({ track, road = null, options = {} }) {
    this.track = track; this.options = { planHz: 4, horizon: 2.4, tyrePrice: 5, workPrice: 0, stabilityWeight: 900, futureWork: 2,
      pacePorts: [-1.6, 0, 1.6], speedFactors: [.80, .92, 1.04], coupledPorts: false, paceFactor: 1,
      pacePlanning: false, ...options };
    this.road = road ?? new RoadGates(track, options.road);
    this.policy = new TransferPolicy(this.road, options.policy);
    this.plant = new Plant(track); this.reset();
  }
  reset() {
    this.now = 0; this.nextPlan = 0; this.transfer = { extra: 0, factor: this.options.paceFactor };
    this.executedPlan = null;
    this.state = 'PACE'; this.errors = 0; this.opponents = new Map(); this.candidates = [];
    this.nextTorque = 0; this.torqueFactor = 1;
    this.stats = { plans: 0, planningMs: [], rejected: 0 };
  }

  observe(car, cars, dt) {
    const self = this.road.project(car), rivals = [];
    for (const other of cars) {
      if (other === car || other.race?.finishTime != null) continue;
      const ds = delta(other.s, car.s, this.track.length);
      if (ds < -50 || ds > 160) continue;
      const p = this.road.project(other), old = this.opponents.get(other.id);
      // Successive visible states, not access to another driver's controls.
      const lateralRate = old ? clamp((p.lateral - old.q) / Math.max(.001, this.now - old.time), -4, 4) : 0;
      const smoothRate = old ? lerp(old.rate, lateralRate, clamp(dt * 8, 0, 1)) : 0;
      this.opponents.set(other.id, { q: p.lateral, time: this.now, rate: smoothRate });
      rivals.push({ id: other.id, car: other, d: p.d, lateral: p.lateral, rate: smoothRate,
        speed: Math.max(0, other.vx * Math.sin(p.heading) + other.vz * Math.cos(p.heading)),
        ds, heading: p.heading, yaw: other.yaw });
    }
    return { self, rivals };
  }

  prediction(rival, t, response = 0) {
    const d = rival.d + rival.speed * t;
    const q = rival.lateral + clamp((rival.rate + response) * t, -2.8, 2.8);
    const p = this.road.at(d, q), origin = this.road.at(rival.d, rival.lateral);
    // Preserve the exact observed body at t=0; prediction must not silently
    // move an edge-running rival inward to an ego's legal arrival port.
    return { id: rival.id, x: rival.car.x + p.x - origin.x, z: rival.car.z + p.z - origin.z,
      yaw: p.heading + delta(rival.car.yaw, origin.heading, Math.PI * 2) * Math.exp(-t * 2),
      vx: p.tx * rival.speed, vz: p.tz * rival.speed };
  }

  shoot(car, arrivals, rivals, trace = false) {
    const sh = this.plant.copy(car), start = this.road.project(sh).d, initial = resources(sh);
    const points = [], h = 1 / 120, duration = this.options.horizon, wheelWork = [0, 0, 0, 0];
    const committedDistance = this.executedPlan ? delta(this.executedPlan.gate, start, this.road.length) : -1;
    const firstGateDistance = committedDistance > .05 ? committedDistance : Math.max(10, car.speed * duration * .40);
    const gateDistance = firstGateDistance + Math.max(10, car.speed * duration * .40);
    let progress = 0, lastD = start, cost = 0, recoveryCost = 0, hard = false, minClearance = Infinity, work = 0, elapsed = 0;
    for (let i = 0; i < Math.ceil(duration / h); i++) {
      const t = i * h;
      const transfer = progress < firstGateDistance ? arrivals[0] : arrivals[1];
      const u = this.policy.control(sh, transfer);
      const predictions = rivals.map(r => this.prediction(r, t));
      this.plant.step(sh, u.controls, h, predictions);
      const p = this.road.project(sh);
      progress += delta(p.d, lastD, this.road.length); lastD = p.d;
      elapsed = t + h;
      work += sh.wheels.reduce((s, w) => s + w.tyre.slipPower, 0) * h;
      sh.wheels.forEach((w, j) => { wheelWork[j] += w.tyre.slipPower * h; });
      // At 120 Hz even a large closing speed cannot jump across an entire car
      // between immediate-prefix body checks. Longer predictions are sampled
      // more sparsely and retain their uncertainty costs.
      if (t < .65) for (const r of rivals) {
        const c = clearance(sh, this.prediction(r, t + h));
        minClearance = Math.min(minClearance, c);
        recoveryCost += h * 200 * Math.max(0, -c) ** 2;
        if (c < 0) hard = true;
      }
      if (i % 6 === 0) {
        const beta = Math.atan2(sh.v, Math.max(2, sh.u));
        if (sh.speed > 12 && Math.abs(beta) > .32) hard = true;
        cost += 6 * h * Math.max(0, Math.abs(beta) - .12) ** 2 * this.options.stabilityWeight;
        recoveryCost += 6 * h * 50 * Math.max(0, Math.abs(beta) - .25) ** 2;
        const edge = footprint(this.track, sh) - (this.track.halfWidth + this.track.curbWidth * .3);
        recoveryCost += 6 * h * 500 * Math.max(0, edge) ** 2;
        if (edge > .05) { cost += edge * edge * 50 + .5; if (edge > .10) hard = true; }
        for (const r of rivals) {
          for (const response of t < .4 ? [0] : [-.65, 0, .65]) {
            const c = clearance(sh, this.prediction(r, t, response));
            minClearance = Math.min(minClearance, c);
            if (c < 0) { cost += (3 + c * c * 9) * (response === 0 ? 1 : .2); if (t < .65 && response === 0) hard = true; }
          }
        }
        if (trace) points.push({ x: sh.x, z: sh.z, speed: sh.speed, t, yaw: sh.yaw });
      }
      // When every edge is already infeasible, compare an actual escape
      // prefix. Ranking one failed tick by its nominal arrival reward can
      // prefer weak braking while the body keeps leaving the road.
      if ((hard && elapsed >= .25) || progress >= gateDistance) break;
    }
    const terminal = resources(sh);
    const rearLoss = Math.max(0, initial.rear - terminal.rear);
    const wearCost = Math.max(0, terminal.wear - initial.wear);
    const memory = 1 - Math.exp(-Math.max(.25, this.lapsLeft ?? 4) * 73 / 240);
    // Extra sliding work goes into a finite surface+core heat capacity. Its
    // retained fraction and the slope of thermal/pressure grip are priced at
    // a warm stint state, including during an initially cold qualifying lap.
    const futureCost = wheelWork.reduce((sum, energy, j) => {
      const projectedCore = Math.max(100, initial.wheels[j].core);
      const thermalSlope = 2 * Math.max(0, projectedCore - 85) / 105 ** 2;
      const pressureSlope = .13 * (car.wheels[j].tyre.coldPressure + 1.01325) / 297.15;
      return sum + energy * .55 / 24000 * (thermalSlope + pressureSlope) * 8 * memory * Math.max(10, car.speed);
    }, 0) * this.options.futureWork;
    const tyreCost = this.options.tyrePrice * (rearLoss * 120 + wearCost * 800 + work * 1e-7 * Math.max(0, initial.maxCore - 85) / 20) + futureCost;
    const velocityValue = sh.speed * .40;
    cost += tyreCost + Math.abs(this.road.project(sh).lateral - arrivals[1].extra) * .20;
    const remainder = Math.max(0, gateDistance - progress) / Math.max(5, sh.speed);
    const score = -(elapsed + remainder) * Math.max(10, car.speed) + velocityValue - cost;
    return { arrivals, score: hard ? -10000 - recoveryCost + progress * .02 : score, hard, progress, tyreCost, minClearance,
      arrivalTime: elapsed, gateDistance, firstGateDistance, reached: progress >= gateDistance,
      terminal: { d: lastD, speed: sh.speed, yaw: sh.yaw, yawRate: sh.yawRate, resources: terminal }, points };
  }

  plan(car, rivals, returning = false) {
    const started = performance.now(), q = this.road.project(car).lateral;
    const front = rivals.filter(r => r.ds > -3).sort((a, b) => a.ds - b.ds)[0];
    const rear = rivals.filter(r => r.ds < -5 && r.speed > car.speed + .5).sort((a, b) => b.ds - a.ds)[0];
    const extras = returning ? [...new Set([0, this.transfer.extra, clamp(q, -5, 5)])]
      : rivals.length ? [...new Set([0, this.transfer.extra, clamp(q, -5, 5), -3.5, 3.5, -5.5, 5.5])]
      : [...new Set([0, this.transfer.extra, clamp(q, -5, 5), ...this.options.pacePorts])];
    const seeds = extras.map(extra => ({ extra, factor: this.options.paceFactor }));
    for (const factor of this.options.speedFactors) seeds.push({ extra: 0, factor });
    if (this.options.coupledPorts) for (const extra of extras) {
      if (extra === 0) continue;
      for (const factor of this.options.speedFactors.filter(f => f > 1)) seeds.push({ extra, factor });
    }
    // Braking competes with physical passing transfers. There is no blanket
    // lead-speed cap on an adjacent, non-conflicting arrival port.
    if (front && front.ds < 45) seeds.push({ extra: front.lateral, factor: 1, cap: Math.max(5, front.speed - 1) });
    // Coasting/braking at the currently occupied port is an executable edge,
    // rather than an imagined instantaneous return to the centre gate. It is
    // needed when an unstable axle or contact has removed every drive edge.
    if (car.speed > 12) seeds.push({ extra: clamp(q, -5, 5), factor: 1, brake: .15 },
      { extra: clamp(q, -5, 5), factor: 1, brake: .35 }, { extra: 0, factor: 1, brake: .35 },
      { extra: clamp(q, -5, 5), factor: 1, brake: .65 }, { extra: 0, factor: 1, brake: .65 });
    let candidates = seeds.map(a => this.shoot(car, [a, a], rivals));
    const beam = candidates.filter(c => !c.hard).sort((a, b) => b.score - a.score).slice(0, 2);
    for (const first of beam) for (const extra of !returning && rivals.length ? [0, -3.5, 3.5] : [0]) {
      if (extra === first.arrivals[0].extra) continue;
      candidates.push(this.shoot(car, [first.arrivals[0], { extra, factor: this.options.paceFactor }], rivals));
    }
    for (const candidate of candidates) {
      // Reward useful pre-overlap coverage; never pay for closing on a body.
      if (rear && rear.ds > -35 && !candidate.hard) {
        const cover = Math.max(0, 1 - Math.abs(candidate.arrivals[0].extra - rear.lateral) / 3);
        candidate.score += cover * 1.2;
      }
      if (candidate.arrivals[0].extra === this.transfer.extra && !candidate.hard) candidate.score += .8;
      if (returning) candidate.score -= Math.abs(candidate.arrivals[1].extra) * 2;
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.find(c => !c.hard) ?? candidates[0];
    const first = selected.arrivals[0];
    const startD = this.road.project(car).d;
    this.executedPlan = { first: { ...first }, exit: { ...selected.arrivals[1] },
      gate: wrap(startD + selected.firstGateDistance, this.road.length), recovery: selected.hard };
    this.transfer = { ...selected.arrivals[0] };
    this.selectedTrajectory = this.shoot(car, selected.arrivals, rivals, true).points;
    this.candidates = candidates.map(c => ({ extra: c.arrivals[0].extra, exit: c.arrivals[1].extra,
      score: c.score, hard: c.hard, progress: c.progress, tyreCost: c.tyreCost, clearance: c.minClearance }));
    this.state = returning ? 'REJOIN' : front && front.ds < 60 ? Math.abs(this.transfer.extra - front.lateral) > 1.8 ? 'ATTACK' : 'FOLLOW' : rear ? 'DEFEND' : 'PACE';
    this.stats.plans++; this.stats.rejected += candidates.filter(c => c.hard).length;
    this.stats.planningMs.push(performance.now() - started);
  }

  update(car, cars, dt, context = {}) {
    this.now = context.time ?? this.now + dt;
    this.lapsLeft = Math.max(.25, (context.totalLaps ?? 4) - (car.race?.lap ?? 1) + 1);
    const { self, rivals } = this.observe(car, cars, dt);
    if (this.executedPlan && delta(this.executedPlan.gate, self.d, this.road.length) <= 0) {
      this.transfer = { ...this.executedPlan.exit }; this.executedPlan = null;
    }
    // The physically validated free-air transfer is already an arrival edge.
    // Search alternatives when a body can affect its execution, rather than
    // changing ports just because an uncatchable car is visible downstream.
    const combat = rivals.some(r => Math.abs(r.ds) < 20
      || (r.ds > 0 && r.ds < 130 && car.speed > r.speed + .5)
      || (r.ds < 0 && r.ds > -40 && r.speed > car.speed + .5));
    const escaping = this.executedPlan?.recovery && (Math.abs(Math.atan2(car.v, Math.max(2, car.u))) > .25
      || footprint(this.track, car) > this.track.halfWidth + this.track.curbWidth * .3);
    const returning = !combat && (Math.abs(this.transfer.extra) > .5 || escaping);
    if (this.options.planning !== false && (combat || returning || this.options.pacePlanning) && this.now >= this.nextPlan) {
      this.plan(car, rivals, returning);
      this.nextPlan = this.now + 1 / this.options.planHz;
    }
    if (!combat && !returning && !this.options.pacePlanning && this.options.planning !== false) {
      this.transfer = { extra: 0, factor: this.options.paceFactor };
      this.executedPlan = null; this.state = 'PACE';
    }
    const command = this.policy.control(car, this.transfer, self);
    if (this.options.workPrice > 0 && car.speed > 8 && this.now >= this.nextTorque) {
      this.priceTorque(car); this.nextTorque = this.now + .05;
    }
    command.controls.throttle *= this.torqueFactor;
    car.controls = command.controls; this.targetSpeed = command.targetSpeed; this.aim = command.aim;
    // The graph checks the immediate prefix at every physical tick. This
    // observed-body check also reacts between graph expansions.
    for (const rival of rivals) {
      if (Math.abs(rival.ds) > 15) continue;
      const closing = car.speed - rival.speed;
      const c = clearance(car, rival.car, .10);
      if (c < .25 && rival.ds > 0 && Math.abs(self.lateral - rival.lateral) < 1.9 && closing > 1) {
        car.controls.throttle = 0; car.controls.brake = Math.max(car.controls.brake, clamp(closing / 8, .15, .9));
      }
    }
  }
  priceTorque(car) {
    const start = this.road.project(car).d;
    const heat = Math.max(...car.wheels.slice(2).map(w => w.tyre.core));
    // A maneuver's extra wheel work reaches the core after its immediate
    // arrival advantage. Anticipate a warm stint even during the opening lap.
    const price = this.options.workPrice * 6e-5 * Math.max(.5, (heat - 75) / 15);
    let best = -Infinity, factor = 1;
    for (const f of [1, .72, .45, .18]) {
      const sh = this.plant.copy(car); let energy = 0;
      for (let i = 0; i < 24; i++) {
        const u = this.policy.control(sh, this.transfer).controls;
        u.throttle *= f; this.plant.step(sh, u, 1 / 120);
        energy += sh.wheels.slice(2).reduce((sum, w) => sum + w.tyre.slipPower, 0) / 120;
      }
      const projection = this.road.project(sh), beta = Math.atan2(sh.v, Math.max(2, sh.u));
      const score = delta(projection.d, start, this.road.length) + sh.speed * .24
        - energy * price - Math.max(0, Math.abs(beta) - .12) ** 2 * 35;
      if (score > best) { best = score; factor = f; }
    }
    this.torqueFactor = factor;
  }
}

export function createSolinatorBridge({ hostTrack, index = 0, options = {}, road = null }) {
  let driver = new Solinator61({ track: hostTrack, road, options });
  return { id: 'solinator-6.1', candidateId: 'solinator-6.1', label: 'solinator 6.1', color: '#ffce45',
    gridSlot: index, driver, errors: 0, lastError: null,
    update(car, cars, dt, context) {
      try { driver.update(car, cars, dt, context); }
      catch (error) { this.errors++; this.lastError = error; throw error; }
    },
    reset() { driver.reset(); this.errors = 0; this.lastError = null; },
    debug() { return { architecture: 'solinator 6.1', state: driver.state, targetSpeed: driver.targetSpeed,
      planSource: 'Cartesian gate transfers / full-plant arrival graph', candidates: driver.candidates,
      controllerCadence: '120 Hz execution / 4 Hz physical planning',
      stats: { acceptedPlans: driver.stats.plans, rejected: driver.stats.rejected } }; },
    visualDebug() { return { selectedTrajectory: { points: driver.selectedTrajectory ?? [], color: '#ffce45', mode: driver.state },
      trackingPoint: driver.aim ? { ...driver.aim, y: 0 } : null }; }
  };
}
