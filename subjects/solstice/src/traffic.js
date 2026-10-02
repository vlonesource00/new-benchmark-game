// Public-pose traffic prediction. This module never reads another driver's policy.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angle = v => Math.atan2(Math.sin(v), Math.cos(v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
const dimensions = car => ({ w: finite(car.spec?.halfWidth, .99), l: finite(car.spec?.halfLength, 2.3) });

// Positive means separated; negative means actual oriented-body overlap.
function separation(a, b, margin = 0) {
  const ar = [Math.cos(a.yaw), -Math.sin(a.yaw)], af = [Math.sin(a.yaw), Math.cos(a.yaw)];
  const br = [Math.cos(b.yaw), -Math.sin(b.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
  const dx = b.x - a.x, dz = b.z - a.z;
  let gap = -Infinity;
  for (const axis of [ar, af, br, bf]) {
    const dot = v => Math.abs(axis[0] * v[0] + axis[1] * v[1]);
    const radius = a.w * dot(ar) + a.l * dot(af) + b.w * dot(br) + b.l * dot(bf) + margin;
    gap = Math.max(gap, Math.abs(dx * axis[0] + dz * axis[1]) - radius);
  }
  return gap;
}

export class Traffic {
  constructor(track, options = {}) {
    this.track = track;
    this.laneRate = Math.max(.5, finite(options.laneRate, 1.7));
    this.reset();
  }

  reset() {
    this.list = [];
    this.history = new Map();
    this.defended = new Map();
    this.sideMemory = new Map();
    this.cooldown = new Map();
    this.failedSide = new Map();
    this.wideGrid = new Set();
    this.engagement = null;
    this.mode = 'free';
    this.speedCap = Infinity;
    this.time = 0;
    this.self = null;
    this.predictions = new Map();
    this.lastTacticalMode = 'free';
    this.wasCapped = false;
    this.stats = { attackStarts: 0, defendMoves: 0, alongsideEpisodes: 0, completedPasses: 0,
      abortedAttacks: 0, capEpisodes: 0 };
  }

  delta(a, b) {
    const L = this.track.length;
    return ((a - b + L / 2) % L + L) % L - L / 2;
  }

  projection(car, context = {}) {
    return context.projections?.get(car.id) ?? this.track.nearest(car.x, car.z);
  }

  observe(car, cars, context = {}) {
    const now = finite(context.time, this.time), me = this.projection(car, context);
    this.time = now;
    this.predictions.clear();
    this.self = { ...me, ...dimensions(car), yaw: car.yaw, x: car.x, z: car.z,
      speed: finite(car.speed, Math.hypot(car.vx, car.vz)) };
    this.list = [];
    if (now > 4 || this.self.speed >= 15) this.wideGrid.clear();
    for (const other of cars) {
      if (other === car || other.id === car.id || (car.ghost && other.ghost)) continue;
      if (![other.x, other.z, other.yaw].every(Number.isFinite)) continue;
      const p = this.projection(other, context), dims = dimensions(other);
      const vx = finite(other.vx), vz = finite(other.vz);
      const speed = vx * p.tx + vz * p.tz;
      const latRate = clamp(vx * p.nx + vz * p.nz, -7, 7);
      const ds = this.delta(p.s, me.s), distance = Math.hypot(other.x - car.x, other.z - car.z);
      if (now < .25 && this.self.speed < 2 && Math.abs(speed) < 2
        && Math.abs(ds) < this.self.l + dims.l
        && Math.abs(p.lateral - me.lateral) > this.self.w + dims.w + 3)
        this.wideGrid.add(other.id);
      // One defensive move per approach, not one per opponent for the race.
      const defense = this.defended.get(other.id);
      if (defense) {
        const separated = ds < -55 || ds > 25;
        if (separated) defense.clearSince ??= now;
        else defense.clearSince = null;
        if (defense.clearSince != null && now - defense.clearSince >= 2) this.defended.delete(other.id);
      }
      const previous = this.history.get(other.id), elapsed = previous ? now - previous.time : 0;
      const continuous = elapsed > .005 && elapsed < 2 && Math.hypot(other.x - previous.x, other.z - previous.z) < Math.max(15, elapsed * 150);
      const measured = continuous ? clamp((speed - previous.speed) / elapsed, -12, 8) : 0;
      const acc = continuous ? previous.acc * .55 + measured * .45 : 0;
      this.history.set(other.id, { time: now, speed, acc, x: other.x, z: other.z });
      // Finished, wrecked, single-ghost and pit cars remain physical obstacles.
      if ((ds < -65 || ds > Math.max(180, this.self.speed * 3)) && distance > 45) continue;
      const outside = Math.abs(p.lateral) - (this.track.halfWidth + dims.l + 2);
      if (distance > 35 && outside > Math.abs(latRate) * 2.5 + 3) continue;
      const headingOffset = angle(other.yaw - p.heading);
      this.list.push({ id: other.id, x: other.x, z: other.z, yaw: other.yaw, vx, vz,
        s: p.s, lateral: p.lateral, heading: p.heading, curvature: finite(p.curvature),
        tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, ds, speed, acc, latRate, ...dims,
        headingOffset,
        irregular: speed < -2 || Math.abs(angle(Math.atan2(vx, vz) - p.heading)) > .7 || outside > 0 });
    }
    for (const [id, h] of this.history) if (now - h.time > 10) {
      this.history.delete(id); this.defended.delete(id); this.sideMemory.delete(id); this.cooldown.delete(id);
    }
    if (this.engagement && !this.list.some(o => o.id === this.engagement.id)) this.engagement = null;
    this.mode = this.engagement?.type ?? (this.list.length ? 'traffic' : 'free');
  }

  predict(o, t) {
    t = Math.max(0, t);
    const key = `${o.id}:${t.toFixed(7)}`;
    if (this.predictions.has(key)) return this.predictions.get(key);
    const movingTime = o.speed > 0 && o.acc < 0 ? Math.min(t, -o.speed / o.acc) : t;
    const travel = o.speed * movingTime + .5 * o.acc * movingTime * movingTime;
    const metric = clamp(1 - o.curvature * o.lateral, .35, 2.5);
    const q = o.lateral + o.latRate * Math.min(t, 1.25);
    const p = this.track.at(o.s + travel / metric, q), origin = this.track.at(o.s, o.lateral);
    const road = { x: o.x + p.x - origin.x, z: o.z + p.z - origin.z,
      yaw: p.heading + o.headingOffset * (o.irregular ? 1 : Math.exp(-t * 1.2)), w: o.w, l: o.l };
    const world = { x: o.x + o.vx * t + o.tx * (travel - o.speed * t),
      z: o.z + o.vz * t + o.tz * (travel - o.speed * t),
      yaw: o.yaw, w: o.w, l: o.l };
    // Tangent extrapolation validates immediate motion and preserves irregular
    // cars that are crossing/rejoining rather than following the road.
    const wp = this.track.nearest(world.x, world.z);
    const disagreement = Math.hypot(world.x - road.x, world.z - road.z);
    const crossing = o.irregular || (t < .55 && Math.abs(wp.lateral - q) > 2.5);
    const prediction = { road, world, crossing, disagreement,
      margin: .30 + .40 * t + Math.min(.6, Math.abs(o.latRate) * .08) * t,
      s: o.s + travel / metric, lateral: q, speed: Math.max(0, o.speed + o.acc * movingTime) };
    this.predictions.set(key, prediction);
    return prediction;
  }

  risk(shadow, t, leading = false) {
    const body = { x: shadow.x, z: shadow.z, yaw: shadow.yaw, ...dimensions(shadow) };
    let total = 0;
    for (const o of this.list) {
      const p = this.predict(o, t);
      const poses = p.crossing ? [p.road, p.world] : [p.road];
      let worst = 0;
      for (const pose of poses) {
        if (Math.hypot(pose.x - body.x, pose.z - body.z) > body.l + pose.l + p.margin + 6) continue;
        const physical = separation(body, pose);
        // Do not brake a clear leading car for a steady rear car's expanding
        // uncertainty bubble. Actual overlaps and lateral/rejoining threats
        // retain their full collision and uncertainty costs.
        const margin = leading && o.ds < -.5 && Math.abs(o.latRate) < 1.5 && !o.irregular
          ? Math.min(p.margin, .35) : p.margin;
        const reserved = physical - margin;
        const immediate = t <= .4 ? 3 : 1;
        const collision = physical <= 0 ? immediate * (5000 + 2000 * -physical) : 0;
        const reserve = reserved < 0 ? immediate * 180 * reserved * reserved / (1 + t) : 0;
        const proximity = physical > 0 && physical < .65 ? 3 * (.65 - physical) ** 2 / (1 + t) : 0;
        worst = Math.max(worst, collision + reserve + proximity);
      }
      total += worst;
    }
    return total;
  }

  baseline(path, s) {
    if (typeof path?.at === 'function') return finite(path.at(s).offset);
    if (typeof path?.sample === 'function' && path.q) return finite(path.sample(path.q, s));
    return 0;
  }

  turnSide(s, speed) {
    // Use road curvature: the racing line's entry/exit lane changes can have
    // the opposite sign to the actual bend, especially in a shallow corner.
    let curve = 0;
    for (const ahead of [12, 24, 40, 65]) {
      const k = finite(this.track.at(s + Math.min(ahead, Math.max(25, speed * 1.5))).curvature);
      if (Math.abs(k) > Math.abs(curve)) curve = k;
    }
    return Math.abs(curve) > .001 ? Math.sign(curve) : 0;
  }

  accept(proposal) {
    const e = this.engagement;
    if (e?.type === 'attack' && proposal.tactic === 'attack' && proposal.rivalId === e.id) {
      e.side = proposal.side; e.committed = true;
      this.sideMemory.set(e.id, { side: e.side, time: this.time });
    }
  }

  continuationCost(shadow, t, point) {
    if (this.engagement?.type !== 'attack') return 0;
    const me = this.track.nearest(shadow.x, shadow.z), body = dimensions(shadow);
    const rival = this.list.find(o => o.id === this.engagement.id);
    if (!rival) return 0;
    const p = this.predict(rival, t), gap = this.delta(p.s, me.s) - body.l - rival.l;
    const closing = shadow.speed - p.speed;
    if (gap <= 0 || closing <= .5) return 0;
    const catchTime = gap / closing;
    if (catchTime > 4) return 0;
    const target = point(me.s + shadow.speed * catchTime), future = this.predict(rival, t + catchTime);
    const ownAngle = angle(target.heading - this.track.at(target.s).heading);
    const ownWidth = body.w * Math.abs(Math.cos(ownAngle)) + body.l * Math.abs(Math.sin(ownAngle));
    const rivalWidth = rival.w * Math.abs(Math.cos(rival.headingOffset)) + rival.l * Math.abs(Math.sin(rival.headingOffset));
    const clearance = Math.abs(target.offset - future.lateral) - ownWidth - rivalWidth - .4;
    // Price the blocked continuation beyond the short physics rollout. An
    // early feasible passing lane then wins before emergency braking is needed.
    return 2 * clamp((4 - catchTime) / 3, 0, 1) * clamp(-clearance / 1.5, 0, 1);
  }

  hasForwardThreat() {
    return this.list.some(o => o.ds > -(this.self.l + o.l + 1)
      || Math.hypot(o.x - this.self.x, o.z - this.self.z) < this.self.l + o.l + 1);
  }

  laneClear(q, car, targetId, horizon = 1.3) {
    const me = this.self, future = me.s + Math.max(0, me.speed) * horizon;
    let room = Infinity;
    for (const o of this.list) {
      if (o.id === targetId) continue;
      const p = this.predict(o, horizon), ds = this.delta(p.s, future);
      if (Math.abs(ds) > me.l + o.l + 9) continue;
      room = Math.min(room, Math.abs(q - p.lateral) - me.w - o.w - .35);
    }
    return room >= 0;
  }

  finishProposals(mode, proposals) {
    this.mode = mode;
    if (mode === 'alongside' && this.lastTacticalMode !== 'alongside') this.stats.alongsideEpisodes++;
    this.lastTacticalMode = mode;
    const capped = Number.isFinite(this.speedCap);
    if (capped && !this.wasCapped) this.stats.capEpisodes++;
    this.wasCapped = capped;
    return proposals;
  }

  proposals(car, path, now = this.time) {
    const me = this.self ?? this.projection(car);
    const body = dimensions(car), misalignment = angle(car.yaw - me.heading);
    const projectedWidth = body.w * Math.abs(Math.cos(misalignment)) + body.l * Math.abs(Math.sin(misalignment));
    const reserve = Math.max(1.65, projectedWidth + .45);
    const edge = Math.max(0, this.track.halfWidth - reserve);
    const current = clamp(me.lateral, -edge, edge), speed = Math.max(0, finite(car.speed));
    const targetS = me.s + Math.max(15, speed * .8), base = clamp(this.baseline(path, targetS), -edge, edge);
    const closingOn = o => Math.max(speed - o.speed, speed - this.predict(o, .8).speed);
    const separationFor = o => projectedWidth
      + o.w * Math.abs(Math.cos(o.headingOffset)) + o.l * Math.abs(Math.sin(o.headingOffset)) + .65;
    const sideBounds = (o, side, horizon = .6) => {
      const q = this.predict(o, horizon).lateral, separation = separationFor(o) + .12;
      const overlapping = Math.abs(o.ds) < (me.l ?? body.l) + o.l + 3;
      return side > 0 ? { min: Math.max(-edge, (overlapping ? Math.max(o.lateral, q) : q) + separation), max: edge }
        : { min: -edge, max: Math.min(edge, (overlapping ? Math.min(o.lateral, q) : q) - separation) };
    };
    const legal = bounds => bounds.min <= bounds.max;
    const immediate = o => Math.abs(o.ds) < (me.l ?? body.l) + o.l + 3;
    const sidesFor = o => {
      if (this.engagement?.id === o.id && this.engagement.committed) {
        const side = this.engagement.side, bounds = sideBounds(o, side);
        const q = clamp(base, bounds.min, Math.max(bounds.min, bounds.max));
        const closingDoor = side * o.latRate > .5
          && (!legal(bounds) || Math.abs(q - current) > Math.max(1.5, this.laneRate * .6));
        if (immediate(o) || !closingDoor) return [side];
      }
      const remembered = this.sideMemory.get(o.id);
      if (remembered && now - remembered.time < 8 && immediate(o)) return [remembered.side];
      return [1, -1];
    };
    const sideChoices = (o, preferInside = false) => {
      const turn = this.turnSide(me.s, speed);
      const catchTime = Math.max(0, o.ds - body.l - o.l) / Math.max(.5, closingOn(o));
      const horizon = clamp(catchTime + .6, .6, 1.25);
      const choices = sidesFor(o).map(side => {
        // A lane must survive the rival's observed turn-in until the bodies
        // meet, rather than merely being open at the instant of the decision.
        const bounds = sideBounds(o, side, horizon), q = clamp(base, bounds.min, Math.max(bounds.min, bounds.max));
        const failed = this.failedSide.get(o.id);
        return { side, bounds, q, cost: Math.abs(q - current) + .55 * Math.abs(q - base)
          + (preferInside && turn && side !== turn ? 1.5 : 0)
          + (failed?.side === side && now < failed.until ? 2 : 0) };
      }).filter(c => legal(c.bounds) && this.laneClear(c.q, car, o.id));
      choices.sort((a, b) => a.cost - b.cost);
      return choices;
    };
    const chooseSide = (o, preferInside = false) => sideChoices(o, preferInside)[0] ?? null;
    this.speedCap = Infinity;
    const blocked = [];
    // Only an occupied current corridor can impose a following speed. A car
    // alongside in another lane never caps speed merely because it is close.
    for (const o of this.list) {
      if (o.ds <= 0 || o.ds > Math.max(65, speed * 2.5)) continue;
      const look = Math.min(1.2, o.ds / Math.max(10, speed)), p = this.predict(o, look);
      const ownExtent = (me.w ?? .99) + Math.abs(Math.sin(angle(car.yaw - me.heading))) * (me.l ?? 2.3);
      const otherExtent = o.w + Math.abs(Math.sin(o.headingOffset)) * o.l;
      if (Math.abs(o.lateral - me.lateral) > ownExtent + otherExtent + .2 && Math.abs(p.lateral - me.lateral) > ownExtent + otherExtent + .2) continue;
      const gap = o.ds - (me.l ?? 2.3) - o.l, reserve = .6;
      const lead = Math.max(0, Math.min(o.speed, p.speed)), room = Math.max(0, gap - reserve);
      let cap = Math.sqrt(lead * lead + 2 * 9 * room);
      if (gap < reserve && speed > lead) cap = Math.min(cap, Math.max(0, lead + (gap - reserve) * .8));
      // Draft freely while stopping remains feasible. This is a collision
      // reachability limit, without a generic time-headway pace penalty.
      if (cap < speed + .5) blocked.push({ o, cap, gap, closing: speed - lead });
    }

    // At launch, a widely separated parallel grid car needs no lane fence.
    // It remains in the full oriented-body prediction and collision cost.
    const alongside = this.list.filter(o => Math.abs(o.ds) < (me.l ?? body.l) + o.l + 2
      && Math.abs(o.lateral) < this.track.halfWidth + (this.track.curbWidth ?? 0)
      && (!this.wideGrid.has(o.id) || Math.abs(o.lateral - me.lateral) < (me.w ?? .99) + o.w + 1.2)
      && (Math.abs(o.lateral - me.lateral) > .8 || Math.abs(o.ds) < (me.l ?? 2.3) + o.l));
    this.followCap = blocked.reduce((cap, b) => Math.min(cap, b.cap), Infinity);
    if (this.engagement) {
      const rival = this.list.find(o => o.id === this.engagement.id);
      const e = this.engagement;
      const clearDistance = (me.l ?? body.l) + (rival?.l ?? body.l) + 1.25;
      const cleared = !rival || (e.type === 'attack' ? rival.ds < -clearDistance : rival.ds > 10);
      if (cleared) {
        if (e.type === 'attack' && rival?.ds < -clearDistance) this.stats.completedPasses++;
        this.sideMemory.set(e.id, { side: e.side, time: now });
        this.engagement = null;
      } else {
        const advantage = e.type === 'attack' ? closingOn(rival) : rival.speed - speed;
        if (advantage < .3) e.noAdvantageSince ??= now;
        else e.noAdvantageSince = null;
        e.bestGap = Math.min(e.bestGap ?? e.startGap, rival.ds);
        if (rival.ds < (e.progressGap ?? e.startGap) - .75) {
          e.progressGap = rival.ds; e.lastGain = now;
        }
        const stalledAttack = e.type === 'attack' && now > e.until && e.startGap - e.bestGap < 2;
        const expiredDefense = e.type === 'defend' && now > e.until;
        const lostCorridor = !legal(sideBounds(rival, e.side));
        if (!immediate(rival) && ((e.noAdvantageSince != null && now - e.noAdvantageSince > 1.5
          && now - (e.lastGain ?? e.until - 5) > 1.5) || stalledAttack || expiredDefense || lostCorridor)) {
          if (e.type === 'attack') {
            this.stats.abortedAttacks++;
            this.failedSide.set(e.id, { side: e.side, until: now + 10 });
          }
          this.sideMemory.set(e.id, { side: e.side, time: now });
          this.cooldown.set(e.id, now + 1);
          this.engagement = null;
        }
      }
    }

    if (!this.engagement && !alongside.length) {
      // A nearby faster lead is a draft opportunity, not an attack trigger.
      const front = this.list.filter(o => o.ds > 0 && o.ds < 95 && closingOn(o) > .5
        && now >= (this.cooldown.get(o.id) ?? -Infinity))
        .sort((a, b) => a.ds - b.ds)[0];
      if (front && (front.ds - front.l - body.l) / closingOn(front) < 4) {
        const choice = chooseSide(front);
        if (choice) {
          this.engagement = { id: front.id, type: 'attack', side: choice.side, startGap: front.ds,
            until: now + 5, noAdvantageSince: null };
          this.sideMemory.set(front.id, { side: choice.side, time: now });
          this.stats.attackStarts++;
        }
      }
      if (!this.engagement) {
        const rear = this.list.filter(o => o.ds < -12 && o.ds > -45 && o.speed - speed > .8 && !this.defended.has(o.id))
          .sort((a, b) => b.ds - a.ds)[0];
        if (rear) {
          const catchTime = (-rear.ds - rear.l - (me.l ?? 2.3)) / (rear.speed - speed);
          const turn = this.turnSide(me.s, speed);
          const direction = turn || Math.sign(rear.lateral - base);
          const q = clamp(base + direction * .9, -edge, edge);
          const bounds = direction > 0 ? { min: q - .2, max: edge }
            : direction < 0 ? { min: -edge, max: q + .2 } : null;
          const choice = { side: direction || 1, bounds, q };
          const shiftTime = Math.abs(q - current) / this.laneRate;
          if (choice && catchTime < 3 && catchTime > shiftTime + .6) {
            this.engagement = { id: rear.id, type: 'defend', side: choice.side, startGap: rear.ds,
              bounds: choice.bounds, until: now + 3, noAdvantageSince: null };
            this.sideMemory.set(rear.id, { side: choice.side, time: now });
            this.defended.set(rear.id, { clearSince: null });
            this.stats.defendMoves++;
          }
        }
      }
    }
    // Reserve a side of each actual alongside body, intersecting both sides
    // when sandwiched. Within that corridor the racing line remains optimal.
    let bounds = { min: -edge, max: edge }, constrained = false;
    const reserveSide = (o, side) => {
      const b = sideBounds(o, side);
      bounds.min = Math.max(bounds.min, b.min); bounds.max = Math.min(bounds.max, b.max); constrained = true;
    };
    const physicalRival = alongside.find(o => o.id === this.engagement?.id);
    if (physicalRival && this.engagement?.type === 'attack' && Math.abs(current - physicalRival.lateral) > .25) {
      // Once bodies overlap longitudinally, their actual sides take priority
      // over an earlier passing proposal that may have been abandoned.
      this.engagement.side = Math.sign(current - physicalRival.lateral);
      this.engagement.committed = true;
    }
    if (this.engagement) {
      const rival = this.list.find(o => o.id === this.engagement.id);
      if (rival && this.engagement.type === 'attack' && !physicalRival) reserveSide(rival, this.engagement.side);
      else if (rival && this.engagement.type === 'defend' && !alongside.length && this.engagement.bounds) {
        bounds = { ...this.engagement.bounds }; constrained = true;
      }
    }
    for (const o of alongside) {
      const difference = current - o.lateral;
      const side = Math.abs(difference) > .25 ? Math.sign(difference)
        : this.engagement?.id === o.id ? this.engagement.side : this.sideMemory.get(o.id)?.side;
      if (!side) { bounds.min = 1; bounds.max = 0; constrained = true; break; }
      this.sideMemory.set(o.id, { side, time: now });
      reserveSide(o, side);
    }
    if (constrained && !legal(bounds)) {
      for (const b of blocked) this.speedCap = Math.min(this.speedCap, b.cap);
      if (!alongside.length) {
        this.engagement = null;
        return this.finishProposals('follow', [{ extra: 0, hold: null, bounds: null, factor: 1 }]);
      }
      // On the outside, hold the wider road radius instead of following a
      // hotlap transition across the neighbour. On the inside, retain the
      // native-tested racing-line continuation rather than tightening radius.
      const outside = current * this.turnSide(me.s, speed) < 0;
      const proposals = [{ extra: outside ? 0 : current - this.baseline(path, me.s),
        hold: outside ? current : null, bounds: null, factor: 1, yield: true }];
      if (alongside.every(o => this.defended.has(o.id) && o.ds < -.5 && separation(this.self, o) > .35))
        proposals.push({ extra: 0, hold: null, bounds: null, factor: 1, tactic: 'clearance' });
      if (alongside.every(o => o.ds < -(body.l + o.l) - .25 && separation(this.self, o) > .6))
        proposals.push({ extra: 0, hold: null, bounds: null, factor: 1, tactic: 'escape', speedCap: this.followCap });
      return this.finishProposals('alongside', proposals);
    }
    const capFor = (corridor, attacking = false, side = this.engagement?.side) => {
      const q = corridor ? clamp(base, corridor.min, corridor.max) : base;
      let cap = Infinity;
      for (const b of blocked) {
        const clearanceShift = Math.max(0, (me.w ?? .99) + b.o.w + .25 - Math.abs(b.o.lateral - current));
        const separationRate = this.laneRate + Math.max(0, -(side ?? Math.sign(q - b.o.lateral)) * b.o.latRate);
        const exitTime = clearanceShift / separationRate + .25;
        const catchTime = b.closing > .1 ? Math.max(0, b.gap) / b.closing : Infinity;
        const passable = attacking && this.engagement?.id === b.o.id
          && Math.abs(q - b.o.lateral) > separationFor(b.o)
          && this.laneClear(q, car, b.o.id) && catchTime > exitTime;
        if (!passable) cap = Math.min(cap, b.cap);
      }
      return cap;
    };
    if (!alongside.length && this.engagement?.type === 'attack') {
      const rival = this.list.find(o => o.id === this.engagement.id);
      const alternatives = rival ? sideChoices(rival, true) : [];
      if (alternatives.length) {
        const proposals = alternatives.flatMap(choice => {
          const common = { extra: 0, hold: null, bounds: choice.bounds, factor: 1,
            tactic: 'attack', rivalId: rival.id, side: choice.side,
            speedCap: capFor(choice.bounds, true, choice.side) };
          const lane = clamp(current, choice.bounds.min + .15, Math.max(choice.bounds.min + .15, choice.bounds.max - .15));
          const offset = rival.lateral - this.baseline(path, rival.s) + choice.side * (separationFor(rival) + .2);
          return [{ ...common, route: 'line' }, { ...common, hold: lane, route: 'parallel' },
            { ...common, bounds: null, extra: offset, route: 'offset' }];
        });
        this.speedCap = Math.max(...proposals.map(p => p.speedCap));
        return this.finishProposals('attack', proposals);
      }
    }
    this.speedCap = capFor(constrained ? bounds : null, this.engagement?.type === 'attack');
    const mode = alongside.length ? 'alongside' : this.engagement?.type ?? (Number.isFinite(this.speedCap) ? 'follow' : 'free');
    const proposals = [{ extra: 0, hold: null, bounds: constrained ? bounds : null, factor: 1,
      ...(this.engagement?.type === 'attack' ? { tactic: 'attack', rivalId: this.engagement.id,
        side: this.engagement.side, speedCap: this.speedCap } : {}),
      ...(mode === 'defend' ? { tactic: 'defend', rivalId: this.engagement.id, maxPaceLoss: .04 } : {}) }];
    if (mode === 'alongside' && constrained) {
      const lane = clamp(current, bounds.min + .15, Math.max(bounds.min + .15, bounds.max - .15));
      proposals.push({ ...proposals[0], hold: lane, route: 'parallel' });
      proposals.push({ ...proposals[0], extra: current - this.baseline(path, me.s), route: 'offset' });
      if (alongside.every(o => o.ds < -(body.l + o.l) - .25 && separation(this.self, o) > .6))
        proposals.push({ extra: 0, hold: null, bounds: null, factor: 1, tactic: 'escape', speedCap: this.followCap });
    }
    if (mode === 'alongside' && alongside.every(o => this.defended.has(o.id) && o.ds < -.5
      && separation(this.self, o) > .35)) {
      // A clear leading car may keep its racing trajectory. The native
      // rollout still rejects a cut across any predicted opponent body.
      proposals.push({ extra: 0, hold: null, bounds: null, factor: 1, tactic: 'clearance' });
    }
    return this.finishProposals(mode, proposals);
  }
}
