import { RacingPath } from './path.js';
import { ForcePolicy } from './policy.js';
import { Traffic } from './traffic.js';
import { PredictionTrack, shadowOf, copyVehicle } from './plant.js';
import { PaceGovernor } from '../../../game/core/difficulty.js';
import { PitLane, PitAutopilot } from '../../../game/core/pit.js';
import { RacingLine } from '../../../game/engine/sim/ai.js';
import { clamp, angle, distance } from './math.js';

const clock = () => globalThis.performance?.now?.() ?? Date.now();
export const DEFAULTS = Object.freeze({ planHz: 8, horizon: 1.1, maxPlanMs: 14,
  envelopeHz: 3, laneRate: 1.7, tyrePrice: 2e-7, governorPrediction: false });

export class SolsticeDriver {
  constructor(track, options = {}, teamState = null) {
    this.track = track; this.o = { ...DEFAULTS, ...options }; this.teamState = teamState;
    this.path = null;
    this.policy = null;
    this.traffic = new Traffic(track, { laneRate: this.o.laneRate }); this.prediction = new PredictionTrack(track);
    this.stats = { plans: 0, rollouts: 0, latencyMs: 0, maxLatencyMs: 0, cost: 0 };
    this.reset();
  }
  reset() {
    this.nextPlan = -Infinity; this.nextEnvelope = -Infinity;
    this.lastTime = null; this.elapsed = 0; this.lastPosition = null;
    this.selected = { extra: 0, hold: null, factor: 1 };
    this.hold = null;
    this.bounds = null; this.controlPeriod = 1 / 120;
    this.extra = 0; this.stalled = 0; this.reverseUntil = -Infinity;
    this.mode = 'PACE'; this.fuelMark = null; this.burn = null;
    this.fuelSpent = 0; this.fuelDistance = 0; this.fuelS = null;
    this.traffic?.reset?.();
    this.predictGovernor = null;
    this.pitGuide = null; this.pitArmed = false; this.lastPitFlag = false;
  }
  prepare(car) {
    if (this.path) return;
    const start = clock();
    this.path = new RacingPath(this.track, { brakeReserve: .8, ...this.o.path, car });
    this.policy = new ForcePolicy(this.track, this.path, this.o.policy);
    this.path.rebuildEnvelope(car, this.envelopeGrip());
    // Match the public line used by the host's pit autopilot at handoff.
    // This private, read-only geometry does not replace the racing line.
    this.pitLine = new RacingLine(this.track, car.spec);
    this.stats.initMs = clock() - start;
    this.stats.geometrySource = this.path.geometrySource;
  }
  envelopeGrip() {
    const grip = this.policy.o.gripUse;
    const wet = clamp(((this.track.wetness ?? 0) - .08) / .14, 0, 1);
    return grip + (Math.min(grip, .86) - grip) * wet;
  }
  resourcePlan(car, context, dt, projection) {
    if (this.fuelMark != null && car.fuel <= this.fuelMark) {
      const spent = this.fuelMark - car.fuel;
      const rate = spent / Math.max(.001, dt);
      if (Number.isFinite(rate)) this.burn = this.burn == null ? rate : this.burn + (rate - this.burn) * Math.min(1, dt / 8);
      this.fuelSpent += spent;
    }
    if (projection && this.fuelS != null) {
      const ds = distance(projection.s, this.fuelS, this.track.length);
      if (ds > 0 && ds < Math.max(15, car.speed * dt * 3)) this.fuelDistance += ds;
    }
    this.fuelS = projection?.s ?? null;
    this.fuelMark = car.fuel;
    const team = this.teamState?.(car);
    const lapsLeft = Math.max(1, (context.totalLaps ?? 6) - (car.race?.lap ?? 1) + 1);
    const remainingFraction = 1 - ((car.race?.progress ?? 0) % this.track.length + this.track.length) % this.track.length / this.track.length;
    const fuelLaps = team?.fuelLaps ?? clamp(Math.round((context.totalLaps ?? 6) * .68), 3, 9);
    const stintLaps = team?.stintLaps ?? Math.floor(fuelLaps * Math.max(0, 1 - car.fuel / 60));
    const targetLaps = Math.min(lapsLeft - 1 + remainingFraction,
      Math.max(remainingFraction, fuelLaps - stintLaps - (1 - remainingFraction)));
    const measuredFuel = this.fuelDistance > this.track.length * .45
      ? this.fuelSpent * this.track.length / this.fuelDistance : 0;
    const lapFuel = team?.fuelPerLap ?? measuredFuel;
    // Saving is warranted only when it can avoid a fuel shortfall in the
    // current stint. A called tyre change and the last lap get full pace.
    const push = lapsLeft <= 1 || Boolean(team?.pitPlan?.tyres);
    const save = !push && lapFuel > 0 && car.fuel / lapFuel < Math.max(.7, targetLaps - .12)
      && car.fuel / lapFuel > 1.05;
    const over = Math.max(...car.wheels.map(w => w.tyre.core - (w.tyre.optimum ?? 85)));
    const hot = !push && over > 14;
    return { save, push, factor: hot ? clamp(1 - (over - 14) * .0025, .94, 1) : 1,
      forceGuard: clamp((this.controlPeriod - .025) / .015, 0, 1) };
  }
  recover(car, p, now, dt) {
    const heading = Math.abs(p.lateral) < this.track.halfWidth + this.track.curbWidth
      ? this.path.at(p.s).heading : p.heading;
    const headingError = angle(heading - car.yaw);
    this.stalled = car.speed < 1.5 && now > 6 ? this.stalled + dt : 0;
    if (this.stalled > 1.3 && now >= this.reverseUntil) this.reverseUntil = now + 1.6;
    if (now < this.reverseUntil) {
      this.mode = 'RECOVER';
      return { throttle: .5, brake: 0, steer: clamp(-headingError * 1.5, -1, 1), reverse: true };
    }
    if (this.reverseUntil !== -Infinity) { this.reverseUntil = -Infinity; this.stalled = 0; this.nextPlan = -Infinity; }
    if (Math.abs(headingError) > 1.1 && car.speed > 4) {
      this.mode = 'RECOVER';
      return { throttle: .1, brake: .25, steer: clamp(headingError * 1.5, -1, 1) };
    }
    return null;
  }
  pitAssist(car, cars, p, dt) {
    if (!this.pitLane) {
      // PitLane installs its corridor on this private geometry descriptor.
      // It never receives or changes the live Track or any physical state.
      const source = this.track;
      const descriptor = { id: source.id, scenario: source.scenario, length: source.length,
        halfWidth: source.halfWidth, curbWidth: source.curbWidth, finishS: source.finishS,
        setPitLane(segments) { this.pitLane = segments; } };
      this.pitLane = new PitLane(descriptor, cars.length);
    }
    const lane = this.pitLane, flag = Boolean(car.race?.pitLap);
    const release = flag && Math.abs(p.lateral) > this.track.halfWidth - 1
      && ((lane.inLane(p.s) && lane.d(lane.entry, p.s) > 40)
        || lane.inWindow(p.s, lane.exit, lane.handover));
    if (release) {
      const index = Math.max(0, cars.findIndex(c => c.id === car.id));
      this.pitGuide ??= new PitAutopilot(lane, lane.boxes[index], this.pitLine);
      this.pitGuide.phase = 'release';
      this.pitControl(car, p, dt);
      const target = this.pitPolicy.lastTarget;
      this.trackingPoint = { x: target.x, z: target.z };
      this.targetSpeed = this.pitPolicy.targetSpeed;
      this.mode = 'PIT_RELEASE'; this.nextPlan = -Infinity;
      this.pitArmed = false; this.lastPitFlag = flag;
      return true;
    }
    if (this.pitGuide?.phase === 'release') {
      this.pitGuide = null; this.hold = null; this.bounds = null; this.extra = 0;
    }
    const start = (lane.approach - 120 + lane.L) % lane.L;
    const end = (lane.entry + 40) % lane.L;
    const window = lane.inWindow(p.s, start, end);
    if (window && ((flag && !this.lastPitFlag) || this.teamState?.(car)?.pitPlan)) this.pitArmed = true;
    this.lastPitFlag = flag;
    if (!this.pitArmed) return false;
    if (!window) {
      this.pitArmed = false; this.pitGuide = null;
      this.nextPlan = -Infinity; this.hold = null; this.bounds = null; this.extra = 0;
      return false;
    }
    if (!this.pitGuide) {
      const index = Math.max(0, cars.findIndex(c => c.id === car.id));
      this.pitGuide = new PitAutopilot(lane, lane.boxes[index], this.pitLine);
    }
    this.pitControl(car, p, dt);
    const target = this.pitPolicy.lastTarget;
    this.trackingPoint = { x: target.x, z: target.z };
    this.targetSpeed = this.pitPolicy.targetSpeed;
    this.mode = 'PIT_APPROACH'; this.nextPlan = -Infinity;
    return true;
  }
  pitControl(car, p, dt) {
    const lane = this.pitLane, guide = this.pitGuide;
    guide.track = this.track;
    const targetLat = s => {
      const ahead = lane.d(s, lane.entry), approachLength = lane.d(lane.approach, lane.entry);
      if (guide.phase === 'approach' && ahead > approachLength) {
        const u = clamp((approachLength + 120 - ahead) / 120, 0, 1);
        const blend = u * u * (3 - 2 * u);
        return this.path.at(s).offset * (1 - blend) + this.pitLine.offsetAt(s) * blend;
      }
      return guide.targetLat(s);
    };
    const point = s => {
      const a = this.track.at(s - 4, targetLat(s - 4));
      const b = this.track.at(s, targetLat(s));
      const c = this.track.at(s + 4, targetLat(s + 4));
      const ax = b.x - a.x, az = b.z - a.z, bx = c.x - b.x, bz = c.z - b.z;
      const den = Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz);
      return { ...b, offset: targetLat(s), heading: Math.atan2(c.x - a.x, c.z - a.z),
        curvature: den > 1e-7 ? 2 * (az * bx - ax * bz) / den : 0 };
    };
    this.pitPolicy ??= new ForcePolicy(this.track, this.path, { ...this.policy.o,
      execution: 'force-yaw', courseForceLimit: .85, lookahead: .55,
      minLook: 6, maxLook: 18, brakeFloor: 6, actualBrakeReserve: true, axleBrake: false,
      warmForceTransition: false, cornerGripUse: .91, warmCornerGripUse: null });
    this.pitPolicy.point = point;
    this.traffic.proposals(car, this.path, this.lastTime ?? this.elapsed);
    const cap = Math.min(guide.targetSpeed(p.s, car) * .9, this.traffic.followCap);
    car.controls = this.pitPolicy.control(car, p, { rotation: 0 }, cap);
    this.targetSpeed = this.pitPolicy.targetSpeed;
  }
  rollout(car, proposal, resource) {
    this.lastRollout = { progress: -Infinity, speed: 0 };
    copyVehicle(this.shadow, car);
    const shadow = this.shadow, dt = 1 / 120;
    let score = 0, travelled = 0, lastS = this.track.nearest(car.x, car.z).s;
    let hold = this.hold, extra = this.extra, bounds = this.bounds && { ...this.bounds }, nextControl = 0;
    if (proposal.yield) { extra = car.lateral - this.path.at(lastS).offset; hold = null; }
    if (bounds && !proposal.bounds) { extra = car.lateral - this.path.at(lastS).offset; bounds = null; }
    const startOff = Math.abs(car.lateral) > this.track.halfWidth + this.track.curbWidth;
    const initialBeta = car.speed > 5 ? Math.abs(angle(Math.atan2(car.vx, car.vz) - car.yaw)) : 0;
    const betaBoundary = Math.max(.4, initialBeta + .03);
    const horizon = this.o.horizon;
    const governor = this.predictGovernor && Object.assign(Object.create(PaceGovernor.prototype), this.predictGovernor);
    let command = null;
    for (let t = 0; t < horizon - 1e-9; t += dt) {
      const p = this.track.nearest(shadow.x, shadow.z);
      const execution = { ...proposal, brakingHold: proposal.hold, brakingBounds: proposal.bounds };
      if (proposal.hold != null || hold != null) {
        hold ??= p.lateral;
        if (proposal.hold == null) {
          extra = hold - this.path.at(p.s).offset; hold = null;
        } else hold += clamp(proposal.hold - hold, -this.o.laneRate * dt, this.o.laneRate * dt);
      }
      extra += clamp((proposal.extra ?? 0) - extra, -this.o.laneRate * dt, this.o.laneRate * dt);
      bounds = this.advanceBounds(bounds, proposal.bounds, p.lateral, dt);
      execution.hold = hold; execution.extra = extra; execution.bounds = bounds;
      if (t + 1e-9 >= nextControl) {
        command = this.policy.control(shadow, p, execution, proposal.speedCap ?? this.traffic.speedCap);
        nextControl = t + this.controlPeriod;
      }
      shadow.controls = { ...command };
      if (governor) {
        governor.push = resource.push; governor.manageStep(shadow, dt); governor.apply(shadow, p.s);
      }
      shadow.step(dt, this.prediction, car.aero?.wake ?? 0);
      const next = this.track.nearest(shadow.x, shadow.z);
      travelled += distance(next.s, lastS, this.track.length); lastS = next.s;
      const lateral = Math.abs(next.lateral), hard = this.track.halfWidth + this.track.curbWidth;
      if (lateral > hard && !startOff) return 1e6 + (horizon - t) * 1e3;
      if (shadow.damage > car.damage + .001) return 1e6 + (horizon - t) * 1e3;
      score += dt * (6 * Math.max(0, lateral - (this.track.halfWidth - .25)) ** 2);
      const beta = shadow.speed > 5 ? Math.abs(angle(Math.atan2(shadow.vx, shadow.vz) - shadow.yaw)) : 0;
      if (beta > betaBoundary) return 1e6 + (horizon - t) * 1e3;
      score += dt * 12 * Math.max(0, beta - .17) ** 2;
      score += dt * this.traffic.risk(shadow, t + dt, proposal.tactic === 'clearance');
      const heatPrice = resource.push ? this.o.tyrePrice * .4 : this.o.tyrePrice;
      score += dt * heatPrice * shadow.wheels.reduce((sum, w) => sum + w.tyre.slipPower, 0);
      if (!Number.isFinite(score + shadow.x + shadow.z + shadow.speed)) return 1e9;
    }
    const terminalPlan = { ...proposal, hold, extra, bounds };
    const p = this.track.nearest(shadow.x, shadow.z), target = this.policy.point(p.s, terminalPlan);
    // Beyond this short rollout, retain the normal envelope as the braking
    // reference. A temporary faster policy must leave a feasible continuation.
    const terminalCap = this.path.sample(hold == null ? this.path.variantEnvelope(extra, bounds) : this.path.laneEnvelope(hold), p.s + shadow.speed * .18);
    const overspeed = Math.max(0, shadow.speed - terminalCap - .7);
    score += .16 * overspeed * overspeed + .025 * (p.lateral - target.offset) ** 2;
    const targetHeading = Math.atan2(this.policy.point(p.s + 8, terminalPlan).x - target.x,
      this.policy.point(p.s + 8, terminalPlan).z - target.z);
    score += .6 * angle(Math.atan2(shadow.vx, shadow.vz) - targetHeading) ** 2;
    score += this.traffic.continuationCost(shadow, horizon, s => this.policy.point(s, proposal));
    this.lastRollout = { progress: travelled, speed: shadow.speed };
    return score - travelled / Math.max(20, car.speed) - .012 * shadow.speed;
  }
  plan(car, now, resource, proposals) {
    this.shadow ??= shadowOf(car);
    const start = clock();
    const mandatory = this.traffic.mode === 'alongside'
      || (this.traffic.mode === 'attack' && this.traffic.engagement?.committed);
    const base = { ...(mandatory ? proposals[0] : {}), extra: mandatory ? (proposals[0]?.extra ?? 0) : 0,
      hold: mandatory ? (proposals[0]?.hold ?? null) : null,
      bounds: mandatory ? (proposals[0]?.bounds ?? null) : null,
      speedCap: mandatory ? (proposals[0]?.speedCap ?? this.traffic.speedCap) : this.traffic.followCap,
      lookahead: this.selected.lookahead ?? this.policy.o.lookahead,
      factor: resource.factor, coast: resource.save, push: resource.push, forceGuard: resource.forceGuard };
    let candidates = [base];
    for (const p of proposals) candidates.push({ ...p, speedCap: p.speedCap ?? this.traffic.speedCap,
      factor: (p.factor ?? 1) * resource.factor, coast: resource.save, push: resource.push,
      forceGuard: resource.forceGuard });
    const rearTyres = car.wheels.slice(2, 4).map(w => w.tyre);
    if (rearTyres.some(t => t.core > (t.optimum ?? 85) + 4 && t.wear > .12))
      candidates.push({ ...base, rotation: .35 });
    candidates.push({ ...base, factor: .96 * resource.factor },
      { ...base, lookahead: .45 }, { ...base, lookahead: .9 },
      { ...base, factor: 1.035 * resource.factor });
    const distinct = new Set();
    candidates = candidates.filter(p => {
      const key = JSON.stringify([p.extra, p.hold, p.bounds, p.factor, p.coast,
        p.lookahead ?? this.policy.o.lookahead, p.rotation ?? this.policy.o.rotation, p.speedCap]);
      if (distinct.has(key)) return false;
      distinct.add(key); return true;
    });
    // Stable deterministic tie-breaking: a busy grid keeps its existing lane.
    let best = Infinity, chosen = base, count = 0, baseline = null;
    for (const p of candidates) {
      const value = this.rollout(car, p, resource);
      baseline ??= { ...this.lastRollout };
      const preservePace = p.tactic !== 'defend' || !Number.isFinite(baseline.progress)
        || (this.lastRollout.progress >= baseline.progress - Math.max(.75, baseline.progress * p.maxPaceLoss)
          && this.lastRollout.speed >= baseline.speed * .94);
      if (preservePace && value < best - .003) { best = value; chosen = p; }
      count++;
      if (count >= 3 && clock() - start >= this.o.maxPlanMs) break;
    }
    // A single predicted body overlap contributes over 40 points. If every
    // full-pace trajectory overlaps traffic, include actual braking actions.
    // Mere proximity and ordinary path/heat costs stay far below this gate.
    if (best >= 25 && this.traffic.hasForwardThreat()) for (const fraction of [.86, .72, .5]) {
      // Brake for the present obstacle without shrinking every later corner
      // in the line's envelope. The latter could halve an already slow apex.
      const p = { ...chosen, speedCap: Math.min(chosen.speedCap ?? Infinity, car.speed * fraction) };
      const value = this.rollout(car, p, resource); count++;
      if (value < best) { best = value; chosen = p; }
      if (best < 25) break;
    }
    this.selected = chosen;
    this.traffic.accept(chosen);
    const latency = clock() - start;
    this.stats = { ...this.stats, plans: this.stats.plans + 1, rollouts: this.stats.rollouts + count,
      latencyMs: latency, maxLatencyMs: Math.max(latency, this.stats.maxLatencyMs), cost: best };
    this.nextPlan = now + 1 / this.o.planHz;
  }
  advanceBounds(previous, requested, lateral, dt) {
    if (!requested) return null;
    const edge = this.track.halfWidth - 1.15;
    const start = previous ?? { min: Math.min(lateral - .1, requested.min ?? -edge),
      max: Math.max(lateral + .1, requested.max ?? edge) };
    const lo = requested.min ?? -edge, hi = requested.max ?? edge;
    return { min: start.min + clamp(lo - start.min, -this.o.laneRate * dt, this.o.laneRate * dt),
      max: start.max + clamp(hi - start.max, -this.o.laneRate * dt, this.o.laneRate * dt) };
  }
  update(car, cars, dt, context = {}) {
    this.prepare(car);
    this.elapsed += dt;
    const now = Number.isFinite(context.time) ? context.time : this.elapsed;
    const step = this.lastTime == null ? dt : clamp(now - this.lastTime, .001, .25);
    if (this.lastPosition && (now < this.lastTime || Math.hypot(car.x - this.lastPosition.x, car.z - this.lastPosition.z) > Math.max(15, car.speed * step * 3))) this.reset();
    this.lastTime = now; this.lastPosition = { x: car.x, z: car.z };
    this.controlPeriod = clamp(step, 1 / 120, .1);
    const p = context.projections?.get?.(car.id) ?? this.track.nearest(car.x, car.z);
    this.traffic.observe(car, cars, context);
    if (this.pitAssist(car, cars, p, step)) return;
    const recovering = this.recover(car, p, now, step);
    if (recovering) { car.controls = recovering; this.nextPlan = -Infinity; return; }
    const resource = this.resourcePlan(car, context, step, p);
    if (this.o.governorPrediction) {
      this.predictGovernor ??= new PaceGovernor(this.track, 1);
      this.predictGovernor.push = resource.push; this.predictGovernor.manageStep(car, step);
    }
    const proposals = this.traffic.proposals(car, this.path, now);
    if (this.selected.tactic === 'clearance' && this.traffic.mode === 'alongside'
      && !proposals.some(proposal => proposal.tactic === 'clearance')) this.nextPlan = now;
    if (now >= this.nextEnvelope) {
      this.path.rebuildEnvelope(car, this.envelopeGrip());
      this.nextEnvelope = now + 1 / this.o.envelopeHz;
    }
    if (now >= this.nextPlan) this.plan(car, now, resource, proposals);
    // Optional tactics and a clear leading trajectory must pass the native
    // comparison. Other alongside situations retain the live body corridor.
    const requestedBounds = this.traffic.mode === 'alongside' && this.selected.tactic !== 'clearance'
      ? (proposals[0]?.bounds ?? null) : (this.selected.bounds ?? null);
    if (this.traffic.mode === 'alongside' && proposals[0]?.yield) {
      this.extra = p.lateral - this.path.at(p.s).offset; this.hold = null;
    }
    if (this.bounds && !requestedBounds) this.extra = p.lateral - this.path.at(p.s).offset;
    this.bounds = this.advanceBounds(this.bounds, requestedBounds, p.lateral, step);
    if (this.selected.hold != null) {
      this.hold ??= p.lateral;
      this.hold += clamp(this.selected.hold - this.hold, -this.o.laneRate * step, this.o.laneRate * step);
    } else if (this.hold != null) {
      this.extra = this.hold - this.path.at(p.s).offset;
      this.hold = null;
    }
    this.extra += clamp((this.selected.extra ?? 0) - this.extra, -this.o.laneRate * step, this.o.laneRate * step);
    const plan = { ...this.selected, extra: this.extra, hold: this.hold,
      bounds: this.bounds, brakingBounds: requestedBounds, brakingHold: this.selected.hold,
      forceGuard: resource.forceGuard };
    if (Math.abs(p.lateral) > this.track.halfWidth + this.track.curbWidth) {
      plan.extra = 0; plan.hold = 0; plan.factor = .45; this.mode = 'REJOIN';
    } else this.mode = resource.save ? 'SAVE' : ({ attack: 'ATTACK', defend: 'DEFEND',
      alongside: 'ALONGSIDE', follow: 'FOLLOW', free: 'PACE', traffic: 'PACE' }[this.traffic.mode] ?? 'PACE');
    const livePass = this.selected.tactic === 'attack' && this.traffic.mode === 'attack'
      ? proposals.find(proposal => proposal.rivalId === this.selected.rivalId && proposal.side === this.selected.side) : null;
    const trafficCap = livePass ? livePass.speedCap : this.selected.bounds || this.selected.hold != null
      ? this.traffic.speedCap : this.traffic.followCap;
    const speedCap = Math.min(trafficCap, this.selected.speedCap ?? Infinity);
    car.controls = this.policy.control(car, p, plan, speedCap);
    this.trackingPoint = { x: this.policy.lastTarget.x, z: this.policy.lastTarget.z };
    this.targetSpeed = this.policy.targetSpeed;
  }
}
