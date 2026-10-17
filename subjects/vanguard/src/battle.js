import { clamp, gap, roadSample, angle } from './math.js';
import { HALF_LENGTH, HALF_WIDTH } from './observer.js';
import { longitudinalDemand } from './controller.js';
import { allocate } from './axles.js';
import { bodyContact } from './body.js';
import { deployment } from './strategy.js';

/** Closed-loop rollout evaluation on compiled corridor demand with exact 2D body contact and hybrid co-state. */
export function evaluate(path, car, course, observer, target, horizon = target?.hazard ? 3.4 : (course.options.combatHorizon ?? 3.4)) {
  const model = course.model, t = course.track, c = path.closest(car.x, car.z);
  let i = c.i, f = c.f, v = Math.max(2, car.speed), time = 0, arc = 0, risk = 0, blocked = 0, cleared = false, threat = null, peakRisk = 0;
  const startS = observer.me.s, initialGap = target?.ds ?? 0;
  let energy = car.hybrid?.energy ?? 0;
  let gear = car.gear;
  let rubbingDamage = 0;
  let hardImpact = false;
  const rubPeaks = new Map();
  while (time < horizon) {
    const h = 0.10, k = path.sample(path.ks, i, f), d = path.sample(path.lat, i, f), heading = path.heading(i, f),
      body = { x: path.sample(path.px, i, f), z: path.sample(path.pz, i, f), h: heading, vx: Math.sin(heading) * v, vz: Math.cos(heading) * v };
    const road = roadSample(path, i, f, t.length), use = clamp(v * v * Math.abs(k) / Math.max(1, model.lat(v) / model.margin), 0, 1);
    let cap = Infinity, wake = 0;
    for (const r of observer.list) {
      if (!r.physical || r.pit) continue;
      const p = observer.at(r, time), ds = gap(p.s, road, t.length), across = Math.abs(p.d - d);
      if (ds > 0 && ds < 110 && across < 2.4 + 0.05 * ds) {
        wake = Math.max(wake, Math.exp(-ds / 55) * (1 - (across / (2.4 + 0.05 * ds)) ** 2));
      }
      if (Math.abs(ds) < 9 && across < 5) {
        const contact = bodyContact(body, p, path.contactMargin ?? 0.08);
        if (contact) {
          const { depth, closing, longitudinal } = contact;
          if (depth > 0.16 && (closing > 6 || (longitudinal > 0.65 && closing > 3.5))) hardImpact = true;
          const rub = course.racecraft?.contactRisk(body, p, contact, r.hazard, h, rubPeaks.get(r.id) ?? 0);
          if (rub) { rubbingDamage += rub.damage; rubPeaks.set(r.id, Math.max(rubPeaks.get(r.id) ?? 0, closing)); }
          else rubPeaks.delete(r.id);
          const cost = rub?.risk ?? h * (Math.max(0, depth - 0.12) * 1.2 + Math.max(0, closing - 1.5) ** 2 * (longitudinal > 0.65 ? 0.6 : 0.16) + (r.hazard || closing > 6 ? 20 : 0));
          risk += cost;
          if (cost > peakRisk) { peakRisk = cost; threat = r.id; }
        } else rubPeaks.delete(r.id);
      } else rubPeaks.delete(r.id);
      if (ds > HALF_LENGTH + r.along && ds < 35 && across < HALF_WIDTH + r.across + 0.18) {
        const room = ds - HALF_LENGTH - r.along - 0.6;
        cap = Math.min(cap, Math.sqrt(p.v * p.v + 2 * model.brake(v) * 0.75 * Math.max(0, room)));
        blocked += h;
      }
      if (r.id === target?.id && ds < -(HALF_LENGTH + r.along + 0.2)) cleared = true;
    }
    const demand = longitudinalDemand(path, { i, f }, v, model, { cap, wake });
    const pedals = allocate(demand.acceleration, v, model, { share: Math.sqrt(Math.max(0, 1 - use ** 3)), reserve: 1, spin: 0 }, course.options);
    gear = model.gearAt(v, gear);
    const drag = model.dragK * v * v + 0.13, drive = model.driveG(v, gear, car.spec.mass + car.fuel * 0.75);
    const targetGap = target ? gap(observer.at(target, time).s, road, t.length) : Infinity;
    const fight = Boolean(path.attackSide && target?.eligible && Math.abs(targetGap) < 22);
    const spend = deployment(energy / 3e6, v, {
      fight,
      exit: demand.feed > 0 || demand.target > v + 1,
      throttle: pedals.throttle,
      brake: pedals.brake,
      source: demand.source
    });
    const power = car.hybrid && pedals.throttle > 0.8 && v > 10 && energy > 0 ? 95e3 * spend.deploy : 0;
    energy = Math.max(0, energy - power * h);
    const acceleration = pedals.throttle * (drive + drag) + power / (Math.max(12, v) * (car.spec.mass + car.fuel * 0.75)) + model.towGain(v, wake) - drag - pedals.brake * model.brake(v);
    const next = Math.max(1, v + acceleration * h), dist = (v + next) * 0.5 * h;
    v = next; time += h; arc += dist;
    let x = f * path.len[i] + dist;
    while (x >= path.len[i]) { x -= path.len[i]; i = path.idx(i + 1); }
    f = x / Math.max(0.01, path.len[i]);
  }
  const road = roadSample(path, i, f, t.length), progress = gap(road, startS, t.length),
    rival = target ? observer.at(target, time) : null;
  const finalGap = rival ? gap(rival.s, road, t.length) : 0;
  if (rubbingDamage > (course.racecraft?.moveBudget ?? Infinity)) risk += 5;
  return { path, progress, exit: v, risk, threat, blocked, cleared, finalGap, initialGap, rubbingDamage, hardImpact,
    relativeGain: initialGap - finalGap, exitAdvantage: rival ? v - rival.v : 0, routeTax: path.timeTax ?? 0,
    score: progress + v * 0.8 - risk * 5 };
}

/** Verify lateral clearance in the future road section where entry completes. */
export function corridorFits(path, base, car, target, side) {
  const c = path.closest(car.x, car.z),
    x = path.sample(path.px, c.i, c.f, path.entryLength),
    z = path.sample(path.pz, c.i, c.f, path.entryLength);
  const section = base.closest(x, z);
  return side * (section.e - (target.offset ?? 0)) > HALF_WIDTH + (target.courseAcross ?? target.across) + 0.02;
}

/** Lane ownership is a body-space fact, not a future pull-out waypoint. */
export function ownsRacingLane(car, target, side) {
  if (!side || !target.eligible || target.hazard) return false;
  const other = target.car, delta = angle(other.yaw - car.yaw);
  if (Math.abs(delta) >= 0.18) return false;
  const dx = car.x - other.x, dz = car.z - other.z, sy = Math.sin(car.yaw), cy = Math.cos(car.yaw),
    across = dx * cy - dz * sy, along = dx * sy + dz * cy,
    otherAcross = Math.abs(Math.cos(delta)) * HALF_WIDTH + Math.abs(Math.sin(delta)) * HALF_LENGTH,
    otherAlong = Math.abs(Math.cos(delta)) * HALF_LENGTH + Math.abs(Math.sin(delta)) * HALF_WIDTH,
    room = side * across - HALF_WIDTH - otherAcross,
    closing = side * (((other.vx ?? 0) - (car.vx ?? 0)) * cy - ((other.vz ?? 0) - (car.vz ?? 0)) * sy);
  return Math.abs(along) < HALF_LENGTH + otherAlong + 0.5 && room > -0.12 &&
    closing < 1.5 && room - Math.max(0, closing) * 0.30 > -0.18;
}

/** A rejected high-score lane must not hide another lane inside the same
 * collision budget. Rank admissible corridors, then decide whether to commit. */
export function selectCandidate(best, candidate, riskLimit) {
  if (!candidate.fits || candidate.hardImpact || candidate.risk >= riskLimit) return best;
  return !best || candidate.score > best.score ? candidate : best;
}

/** A defended apex can be attacked over-under: outside entry, then a smooth
 * late crossing behind the rival. Its second transition obeys the jerk budget. */
export function switchbackPlan(base, car, target, options) {
  if (target.hazard || !target.eligible || target.kind !== 'race' || target.ds < 5 || target.ds > 30) return null;
  const c = base.closest(car.x, car.z), horizon = Math.max(100, car.speed * 3.2);
  let apex = 0, curvature = 0;
  for (let distance = 35; distance < horizon; distance += 8) {
    const k = base.sample(base.ks, c.i, c.f, distance);
    if (Math.abs(k) > Math.abs(curvature)) { curvature = k; apex = distance; }
  }
  const inside = Math.sign(curvature), apexSpeed = base.sample(base.vbrk, c.i, c.f, apex);
  if (Math.abs(curvature) < 0.002 || car.speed - apexSpeed < 6 || inside * (target.offset ?? 0) < 0.5) return null;
  const clearance = options.separation, entry = Math.max(35, car.speed * 0.65),
    switchStart = Math.max(entry + 6, apex + 8),
    switchLength = Math.max(40, Math.max(apexSpeed + 6, 18) * Math.cbrt(120 * clearance / Math.max(20, options.steerJerk)) * 1.08);
  return { side: -inside, inside, entry, switchStart, switchLength,
    hold: switchStart + switchLength - entry + Math.max(65, apexSpeed * 1.6), clearance };
}

export class Battle {
  constructor(course, options, outcomes) {
    this.course = course;
    this.options = options;
    this.outcomes = outcomes;
    this.reset();
  }
  separation(held = false) {
    const normal = held ? this.options.holdSeparation : this.options.separation;
    return this.course.racecraft?.clearance(normal, held) ?? normal;
  }
  reset() {
    this.state = 'PACE';
    this.target = null;
    this.targetWasHazard = false;
    this.side = 0;
    this.path = null;
    this.returnPath = null;
    this.returnGuard = null;
    this.returnTarget = null;
    this.at = -99;
    this.since = 0;
    this.clearAt = null;
    this.returnReason = null;
    this.progressMark = null;
    this.candidates = [];
    this.sequence = 0;
    this.moveKind = null;
  }
  wire() {
    return {
      state: this.state, target: this.target, targetWasHazard: this.targetWasHazard,
      side: this.side, since: this.since, clearAt: this.clearAt,
      returnReason: this.returnReason, returnTarget: this.returnTarget, moveKind: this.moveKind
    };
  }
  adopt(b) {
    if (!b) return;
    const state = this.state, clearAt = this.clearAt, returnReason = this.returnReason;
    const ahead = this.target === b.target &&
      ((['CLEAR', 'RETURN'].includes(state) && ['ATTACK', 'ALONGSIDE', 'EVADE'].includes(b.state)) ||
       (state === 'RETURN' && b.state === 'CLEAR'));
    Object.assign(this, b);
    if (ahead) { this.state = state; this.clearAt = clearAt; this.returnReason = returnReason; }
  }
  progress(observer, now) {
    const r = observer.list.find(r => r.id === this.target);
    if (this.state === 'RETURN') return r;
    if (!r || (!r.eligible && !r.hazard)) {
      if (this.target !== null) {
        this.state = 'RETURN';
        this.returnReason = 'ineligible';
        this.clearAt ??= now;
      }
      return r;
    }
    if (r.hazard) this.targetWasHazard = true;
    const overlap = Math.abs(r.ds) < HALF_LENGTH + r.along + 0.35;
    if (overlap && this.side) {
      this.state = r.hazard ? 'EVADE' : this.state === 'DEFEND' && r.ds < 0 ? 'DEFEND' : 'ALONGSIDE';
      this.clearAt = null;
    } else if (this.state === 'ALONGSIDE' && r.ds > HALF_LENGTH + r.along + 0.35) {
      this.state = 'ATTACK';
    }
    const ownSpeed = observer.car?.speed ?? observer.me.v;
    if (this.state === 'DEFEND' && r.ds < 0 && r.ds > -Math.max(26, ownSpeed * 0.65) &&
      (r.referenceSpeed ?? r.v) > ownSpeed - 0.7) {
      // We began this move ahead. The passing clear timer would return us to
      // the racing line just as the attacker arrives alongside.
      this.clearAt = null;
      return r;
    }
    if (r.ds < -(HALF_LENGTH + r.along + 0.4)) {
      this.clearAt ??= now;
      this.state = 'CLEAR';
    } else if (this.clearAt !== null) {
      this.clearAt = null;
    }
    // Fast post-hazard recovery: stationary/spun hazards return after 0.08 s; moving traffic holds the straight passing lane for 1.1 s.
    const clearHold = (r.hazard || this.targetWasHazard) ? 0.08 : 1.1;
    if (this.clearAt !== null && now - this.clearAt > clearHold) {
      this.state = 'RETURN';
      this.returnReason = 'clear';
    }
    return r;
  }
  update(car, observer, now, { force = false, enabled = true } = {}) {
    const course = this.course, base = course.line, r = this.progress(observer, now);
    if (!enabled) { this.path = base; this.state = 'PACE'; return base; }
    if (!force && now - this.at < this.options.battlePeriod) return this.path ?? base;
    this.at = now;
    this.sequence++;
    course.beginRoutes(this.path, this.returnPath, this.returnGuard?.path);

    if (this.state === 'RETURN') {
      const c = base.closest(car.x, car.z);
      const next = observer.list.find(q =>
        q.physical && !q.pit && q.ds > 6 && q.ds < Math.max(60, car.speed * 1.65) && q.id !== this.target &&
        (q.hazard || (q.eligible && car.speed - q.v > 2))
      );
      if (next && this.side && this.returnReason === 'clear') {
        const clearance = next.hazard
          ? HALF_WIDTH + next.across + 0.55
          : next.kind === 'traffic'
            ? Math.max(3.3, this.separation())
            : this.separation();
        const path = course.corridor(car, next, this.side, 4, {
          entry: Math.max(40, car.speed * 0.8),
          hold: Math.max(150, car.speed * 4),
          returnLength: 100,
          clearance
        });
        const lane = evaluate(path, car, course, observer, next);
        this.candidates = [{ ...lane, kind: 'continue', side: this.side }];
        const direct = evaluate(base, car, course, observer, next);
        const trafficChain = next.kind === 'traffic' && car.speed - next.v > 3 && (next.ds - 5) / Math.max(0.2, car.speed - next.v) < 4;
        if (lane.risk < 0.4 && (trafficChain || (lane.progress > direct.progress - 2 && lane.exit > direct.exit - 1))) {
          this.target = next.id;
          this.targetWasHazard = Boolean(next.hazard);
          this.state = next.hazard ? 'EVADE' : 'ATTACK';
          this.since = now;
          this.clearAt = null;
          this.returnReason = null;
          this.returnPath = null;
          this.returnGuard = null;
          this.returnTarget = null;
          if (next.eligible) this.outcomes.declare(next, observer, now, this.side);
          return (this.path = path);
        }
        // If continuing on `this.side` is blocked by a staggered car, check `-this.side` (staggered S-chain)
        if (lane.risk >= 0.4 && next.kind === 'traffic') {
          const altPath = course.corridor(car, next, -this.side, 5, {
            entry: Math.max(42, car.speed * 0.82),
            hold: Math.max(150, car.speed * 4),
            returnLength: 100,
            clearance
          });
          const altLane = evaluate(altPath, car, course, observer, next);
          this.candidates.push({ ...altLane, kind: 's-chain', side: -this.side });
          if (altLane.risk < 0.35 && corridorFits(altPath, base, car, next, -this.side) && (trafficChain || altLane.progress > direct.progress - 2)) {
            this.target = next.id;
            this.targetWasHazard = Boolean(next.hazard);
            this.side = -this.side;
            this.state = 'ATTACK';
            this.since = now;
            this.clearAt = null;
            this.returnReason = null;
            this.returnPath = null;
            this.returnGuard = null;
            this.returnTarget = null;
            if (next.eligible) this.outcomes.declare(next, observer, now, this.side);
            return (this.path = altPath);
          }
        }
      }
      if (Math.abs(c.e) < 0.35) { this.reset(); return (this.path = base); }
      const returnEntry = this.targetWasHazard
        ? Math.max(46, car.speed * 0.88)
        : Math.max(90, car.speed * 1.8);
      const returnLen = this.targetWasHazard ? 42 : 60;
      this.returnPath ??= course.corridor(car, null, 0, 0, {
        entry: returnEntry, hold: 16, returnLength: returnLen, clearance: 0
      });
      const merge = evaluate(this.returnPath, car, course, observer, null),
        neighbor = observer.list.find(q =>
          q.id === merge.threat && q.physical && !q.pit &&
          q.ds > -(HALF_LENGTH + q.along) && q.ds < Math.max(25, car.speed * 0.7) &&
          (q.ds >= 0 || q.hazard || (q.kind === 'traffic' && car.speed - q.v > 3))
        );
      if (neighbor && merge.risk > 0.3) {
        const stillHeld = this.returnGuard?.id === neighbor.id &&
          Math.abs((neighbor.offset ?? neighbor.d) - this.returnGuard.offset) < 0.6 &&
          gap(this.returnGuard.path.holdEndS, observer.me.s, course.track.length) > Math.max(35, car.speed * 0.6);
        if (!stillHeld) {
          const h = course.track.at(course.track.nearest((car.x + neighbor.car.x) * 0.5, (car.z + neighbor.car.z) * 0.5).s).heading,
            lateral = (car.x - neighbor.car.x) * Math.cos(h) - (car.z - neighbor.car.z) * Math.sin(h),
            side = Math.sign(lateral) || this.side || 1,
            clearance = Math.max(Math.abs(lateral), neighbor.kind === 'traffic' ? 3.3 : this.separation(true)),
            path = course.corridor(car, neighbor, side, 2, {
              entry: Math.max(40, car.speed * 0.8),
              hold: Math.max(120, car.speed * 2.4),
              returnLength: 100,
              clearance
            });
          this.returnGuard = { id: neighbor.id, offset: neighbor.offset ?? neighbor.d, path };
        }
        const held = evaluate(this.returnGuard.path, car, course, observer, null);
        this.candidates = [{ ...merge, kind: 'join', side: 0 }, { ...held, kind: 'hold-space', side: this.returnGuard.path.attackSide }];
        if (held.risk < merge.risk - 0.05) {
          this.returnTarget = neighbor.id;
          return (this.path = this.returnGuard.path);
        }
      }
      if (this.returnTarget !== null && this.returnGuard && this.path === this.returnGuard.path) {
        this.returnPath = course.corridor(car, null, 0, 3, {
          entry: returnEntry, hold: 16, returnLength: returnLen, clearance: 0
        });
        this.returnGuard = null;
      }
      this.returnTarget = null;
      return (this.path = this.returnPath);
    }

    const adaptive = this.options.adaptiveAttacks === true && course.racecraft?.enabled;
    const beside = !this.side && observer.list.find(q =>
      q.eligible && Math.abs(q.ds) < HALF_LENGTH + q.along + 0.4 && Math.abs(q.d - observer.me.d) < 4.5 &&
      (!adaptive || ownsRacingLane(car, q, Math.sign((observer.me.offset ?? observer.me.d) - (q.offset ?? q.d))))
    );
    if (beside) {
      const lateral = (observer.me.offset ?? observer.me.d) - (beside.offset ?? beside.d),
        side = Math.sign(lateral) || (car.id < beside.id ? -1 : 1), owned = Math.max(this.separation(true), side * lateral);
      const path = course.corridor(car, beside, side, 1, {
        entry: Math.max(35, car.speed * 0.9),
        hold: Math.max(150, car.speed * 4),
        returnLength: 100,
        clearance: owned
      });
      const held = adaptive ? evaluate(path, car, course, observer, beside) : null;
      // Starting beside a car is not permission to use an unchecked route.
      // The old branch bypassed all rollout checks and could create a fast
      // lateral hit after a braking/return sequence.
      if (!adaptive || (held.risk < 0.5 && !held.hardImpact)) {
        this.target = beside.id;
        this.targetWasHazard = false;
        this.side = side;
        this.state = beside.ds >= 0 ? 'ALONGSIDE' : 'DEFEND';
        this.since = now;
        if (beside.ds >= 0) this.outcomes.declare(beside, observer, now, side);
        if (held) this.candidates = [{ ...held, side, kind: 'owned-lane', fits: true }];
        return (this.path = path);
      }
      course.reserved?.delete(path);
    }

    // Early hazard horizon (`car.speed * 1.65`) avoids noseConstraint braking before evasive corridor starts.
    const target = r ?? observer.list.find(q =>
      q.physical && !q.pit && q.ds > 3 &&
      q.ds < (q.hazard ? Math.max(68, car.speed * 1.65) : Math.max(45, car.speed * 1.25)) &&
      (q.eligible || (q.hazard && (Math.abs(q.d - observer.me.d) < 3.8 || Math.abs(q.offset ?? 0) < 3.5)))
    );
    const current = evaluate(base, car, course, observer, target);
    this.candidates = [{ ...current, kind: 'course', side: 0 }];
    if (!target) {
      const rear = observer.list.find(q =>
        q.eligible && q.ds < -6 && q.ds > -Math.max(24, car.speed * 0.45) && q.v - car.speed > 1.2
      );
      if (rear) {
        const c = base.closest(car.x, car.z), k = base.sample(base.ks, c.i, c.f, Math.max(55, car.speed * 1.2)), side = Math.sign(k);
        if (side && Math.abs(k) > 0.001) {
          const path = course.corridor(car, null, side, 5, {
            entry: Math.max(60, car.speed * 1.1), hold: 120, returnLength: 100, clearance: 1.1
          });
          const cover = evaluate(path, car, course, observer, rear);
          if (cover.risk < 0.35 && cover.progress > current.progress - 1.5 && cover.exit > current.exit - 1) {
            this.target = rear.id;
            this.targetWasHazard = false;
            this.side = side;
            this.state = 'DEFEND';
            this.since = now;
            this.candidates.push({ ...cover, kind: 'cover', side });
            return (this.path = path);
          }
        }
      }
      this.target = null;
      this.targetWasHazard = false;
      this.side = 0;
      this.state = 'PACE';
      return (this.path = base);
    }

    const closing = car.speed - (target.referenceSpeed ?? target.v),
      gapTime = (target.ds - 5) / Math.max(0.2, closing),
      hazard = target.hazard;
    if (hazard) this.targetWasHazard = true;
    const committed = this.side !== 0 && this.target === target.id;
    const ownedLane = adaptive && committed && course.racecraft?.rubbing &&
      ownsRacingLane(car, target, this.side);
    if (committed && !hazard && target.ds > HALF_LENGTH + target.along + 0.35) {
      if (this.progressMark?.id !== target.id || target.ds < this.progressMark.gap - 0.5) {
        this.progressMark = { id: target.id, gap: target.ds, time: now };
      }
      if (now - this.since > 8.5 && now - this.progressMark.time > 2.5 && this.state !== 'DEFEND') {
        this.state = 'RETURN';
        this.returnReason = 'abort';
        this.clearAt = now;
        return this.path ?? base;
      }
    }
    const entry = hazard ? clamp(target.ds - 10, 22, 72) : clamp(car.speed * 0.75, 28, 70),
      hold = hazard ? clamp(target.ds + 16, 40, 95) : clamp(car.speed * 4, 150, 310),
      returnLen = hazard ? Math.max(48, car.speed * 0.85) : Math.max(70, car.speed * 1.3),
      clearance = hazard
        ? HALF_WIDTH + target.across + 0.55
        : ['ALONGSIDE', 'DEFEND'].includes(this.state)
          ? Math.max(this.separation(true), this.side * ((observer.me.offset ?? observer.me.d) - (target.offset ?? target.d)))
          : target.kind === 'traffic'
            ? Math.max(3.3, this.separation())
            : this.separation();
    const clearanceForSide = side => {
      let space = clearance;
      const offset = target.offset ?? 0;
      for (const q of observer.list) {
        if (q.id === target.id || !q.physical || !q.hazard || q.pit || q.ds < 0 || q.ds > Math.max(250, car.speed * 3.9)) continue;
        const obstacle = side * Math.max(side * (q.offset ?? 0), side * (offset + (q.d - target.d)));
        const targetWillEvade = !hazard && q.ds > target.ds + 10 &&
          (Math.abs((q.offset ?? 0) - offset) < HALF_WIDTH + q.across + 0.85 || Math.abs(q.d - target.d) < HALF_WIDTH + q.across + 1.2);
        const need = HALF_WIDTH + q.across + 0.55 + (targetWillEvade ? 1.05 + Math.max(0, q.across - HALF_WIDTH) * 0.65 : 0);
        if (Math.abs(offset + side * space - obstacle) < need) space = Math.max(space, side * (obstacle - offset) + need);
      }
      return space;
    };
    if (committed && this.path && (now - this.since < 7.5 || ownedLane)) {
      const held = evaluate(this.path, car, course, observer, target);
      const space = clearanceForSide(this.side);
      const wantedOffset = (target.offset ?? target.d) + this.side * space;
      const moved = space > clearance + 0.05 || (space > (this.path.clearance ?? 0) + 0.35)
        ? Math.abs(wantedOffset - (this.path.corridorOffset ?? wantedOffset)) > 0.4 || space > (this.path.clearance ?? 0) + 0.35
        : Math.abs((target.offset ?? target.d) - (this.path.targetOffset ?? target.offset ?? target.d)) > 0.4;
      const remaining = gap(this.path.holdEndS ?? observer.me.s, observer.me.s, course.track.length);
      const losing = adaptive && target.eligible && target.ds > HALF_LENGTH + target.along &&
        held.progress < current.progress - 2 && held.exit < current.exit - 1;
      if (held.risk < 0.5 && !moved && !losing && remaining > Math.max(45, car.speed * 0.8)) {
        this.candidates.push({ ...held, side: this.side, kind: 'held' });
        return this.path;
      }
      if (target.ds < -(HALF_LENGTH + target.along + 0.4)) {
        this.state = 'RETURN';
        this.returnReason = 'clear';
        return this.path;
      }
    }

    if (!committed && !hazard && target.ds > Math.max(22, closing * 2.1 + car.speed * 0.35) && gapTime > 2.65) {
      this.state = 'TOW';
      const c = base.closest(car.x, car.z), straight = Math.abs(base.sample(base.ks, c.i, c.f, car.speed)) < 0.001;
      const offset = target.offset ?? 0;
      if (straight && target.ds < 95 && target.ds > 26 && Math.abs(offset) > 0.45 && Math.abs(offset) < 3.5) {
        const towPath = course.corridor(car, target, 0, 5, {
          entry: Math.max(80, car.speed * 1.45), hold: 130, returnLength: 100, clearance: 0
        });
        const tow = evaluate(towPath, car, course, observer, target);
        this.candidates.push({ ...tow, kind: 'wake', side: 0 });
        if (tow.risk < 0.1 && tow.score > current.score + 1.1) {
          this.path = towPath;
          return towPath;
        }
      }
      return (this.path = base);
    }

    const sides = committed ? [this.side] : [-1, 1];
    const nextTraffic = !hazard && observer.list.find(q =>
      q.id !== target.id && q.physical && !q.pit && q.ds > target.ds + 8 && q.ds < target.ds + 55 &&
      (q.hazard || (q.eligible && car.speed - q.v > 2.5))
    );
    let chosen = null;
    const riskLimit = Math.max(0.8, current.risk + 0.2);
    for (const side of sides) {
      const space = clearanceForSide(side);
      const offset = target.offset ?? 0;
      const path = course.corridor(car, target, side, 1 + this.candidates.length, {
        entry, hold, returnLength: returnLen, clearance: space,
        ...(hazard ? { jerk: 220, joinSpeed: Math.max(12, car.speed * 0.68) } : {})
      });
      const candidate = evaluate(path, car, course, observer, target);
      const near = path.closest(car.x, car.z);
      candidate.side = side;
      candidate.kind = hazard ? 'evade' : Math.sign(base.ks[near.i]) === side ? 'inside' : 'outside';
      // Entering a lane and retaining a lane already occupied alongside are
      // different contracts. Requiring a new full-width pull-out at a future
      // entry station makes a legal overlap abort just before the corner.
      candidate.fits = corridorFits(path, base, car, target, side) ||
        (ownedLane && side === this.side && candidate.risk < 0.12 && !candidate.hardImpact);
      candidate.score += (committed ? 6 : 0) + (candidate.cleared ? 8 : 0);
      this.candidates.push(candidate);
      chosen = selectCandidate(chosen, candidate, riskLimit);

      // S-thread candidate if `nextTraffic` blocks `side` past `target`
      if (nextTraffic && this.candidates.length < (this.options.maxCandidates ?? 8) - 1) {
        const nextOff = nextTraffic.offset ?? 0;
        const nextNeed = HALF_WIDTH + nextTraffic.across + 0.65;
        if (Math.abs(offset + side * space - nextOff) < nextNeed) {
          const sPath = course.corridor(car, target, side, 1 + this.candidates.length, {
            entry, hold, returnLength: returnLen, clearance: space,
            secondTarget: nextTraffic, secondSide: -side, secondClearance: space,
            switchStart: clamp(target.ds + 6, entry + 4, target.ds + 14),
            switchLength: clamp(nextTraffic.ds - target.ds - 4, 16, 40)
          });
          const sCand = evaluate(sPath, car, course, observer, target);
          sCand.side = side;
          sCand.kind = 's-thread';
          sCand.fits = corridorFits(sPath, base, car, target, side);
          sCand.score += (committed ? 5 : 0) + (sCand.cleared ? 8.5 : 0);
          this.candidates.push(sCand);
          chosen = selectCandidate(chosen, sCand, riskLimit);
        }
      }
    }

    const switchback = this.options.switchbacks !== false && !committed && this.candidates.length < (this.options.maxCandidates ?? 8) - 1
      ? switchbackPlan(base, car, target, { ...this.options, separation: this.separation() }) : null;
    if (switchback) {
      const path = course.corridor(car, target, switchback.side, 1 + this.candidates.length, {
        ...switchback, secondTarget: target, secondSide: switchback.inside,
        secondClearance: switchback.clearance, returnLength: Math.max(80, car.speed * 1.3)
      });
      path.contactMargin = 0.5;
      const candidate = evaluate(path, car, course, observer, target);
      candidate.kind = 'switchback'; candidate.side = switchback.side;
      candidate.fits = corridorFits(path, base, car, target, switchback.side);
      candidate.preparation = candidate.exit > current.exit + 2 && candidate.finalGap < current.finalGap - 0.75;
      this.candidates.push(candidate);
      if (candidate.risk === 0) chosen = selectCandidate(chosen, candidate, riskLimit);
    }
    const reachable = chosen && (chosen.preparation || chosen.finalGap < 5 || (target.ds < 18 && closing > 1 && chosen.finalGap < target.ds + 2));
    const useful = chosen && ((chosen.cleared && chosen.finalGap < 5) || chosen.score > current.score + 0.5);
    const actionable = chosen && (hazard || committed || (reachable && useful));
    if (actionable && chosen.risk < Math.max(0.8, current.risk + 0.2)) {
      if (!committed) {
        this.target = target.id;
        this.targetWasHazard = Boolean(hazard);
        this.side = chosen.side;
        this.since = now;
        this.state = hazard ? 'EVADE' : 'ATTACK';
        this.moveKind = chosen.kind;
        if (target.eligible) this.outcomes.declare(target, observer, now, this.side);
      }
      this.path = chosen.path;
      if (now - this.since > 8 && target.ds > 35 && this.state !== 'ALONGSIDE') {
        this.state = 'RETURN';
        this.returnReason = 'abort';
        this.clearAt = now;
      }
      return this.path;
    }
    if (committed) {
      this.state = 'RETURN';
      this.returnReason = target.ds < -(HALF_LENGTH + target.along + 0.4) ? 'clear' : 'abort';
      this.clearAt = now;
      return this.path ?? base;
    }
    this.state = target.ds < 35 ? 'FOLLOW' : 'TOW';
    return (this.path = base);
  }
}
