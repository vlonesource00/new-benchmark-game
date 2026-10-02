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
  constructor(track) {
    this.track = track;
    this.reset();
  }

  reset() {
    this.list = [];
    this.history = new Map();
    this.defended = new Set();
    this.sideMemory = new Map();
    this.cooldown = new Map();
    this.engagement = null;
    this.mode = 'free';
    this.speedCap = Infinity;
    this.time = 0;
    this.self = null;
    this.predictions = new Map();
    this.lastTacticalMode = 'free';
    this.wasCapped = false;
    this.stats = { attackStarts: 0, defendMoves: 0, alongsideEpisodes: 0, completedPasses: 0, capEpisodes: 0 };
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
    for (const other of cars) {
      if (other === car || other.id === car.id || (car.ghost && other.ghost)) continue;
      if (![other.x, other.z, other.yaw].every(Number.isFinite)) continue;
      const p = this.projection(other, context), dims = dimensions(other);
      const vx = finite(other.vx), vz = finite(other.vz);
      const speed = vx * p.tx + vz * p.tz;
      const latRate = clamp(vx * p.nx + vz * p.nz, -7, 7);
      const ds = this.delta(p.s, me.s), distance = Math.hypot(other.x - car.x, other.z - car.z);
      const previous = this.history.get(other.id), elapsed = previous ? now - previous.time : 0;
      const continuous = elapsed > .005 && elapsed < 2 && Math.hypot(other.x - previous.x, other.z - previous.z) < Math.max(15, elapsed * 150);
      const measured = continuous ? clamp((speed - previous.speed) / elapsed, -12, 8) : 0;
      const acc = continuous ? previous.acc * .55 + measured * .45 : 0;
      this.history.set(other.id, { time: now, speed, acc, x: other.x, z: other.z });
      // Finished, wrecked, single-ghost and pit cars remain physical obstacles.
      if ((ds < -65 || ds > Math.max(180, this.self.speed * 3)) && distance > 45) continue;
      const outside = Math.abs(p.lateral) - (this.track.halfWidth + dims.l + 2);
      if (distance > 35 && outside > Math.abs(latRate) * 2.5 + 3) continue;
      this.list.push({ id: other.id, x: other.x, z: other.z, yaw: other.yaw, vx, vz,
        s: p.s, lateral: p.lateral, heading: p.heading, curvature: finite(p.curvature),
        tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, ds, speed, acc, latRate, ...dims,
        headingOffset: angle(other.yaw - p.heading),
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

  risk(shadow, t) {
    const body = { x: shadow.x, z: shadow.z, yaw: shadow.yaw, ...dimensions(shadow) };
    let total = 0;
    for (const o of this.list) {
      const p = this.predict(o, t);
      const poses = p.crossing ? [p.road, p.world] : [p.road];
      let worst = 0;
      for (const pose of poses) {
        if (Math.hypot(pose.x - body.x, pose.z - body.z) > body.l + pose.l + p.margin + 6) continue;
        const physical = separation(body, pose), reserved = physical - p.margin;
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
    const sideBounds = (o, side) => {
      const q = this.predict(o, .6).lateral, separation = separationFor(o) + .12;
      return side > 0 ? { min: Math.max(-edge, Math.max(o.lateral, q) + separation), max: edge }
        : { min: -edge, max: Math.min(edge, Math.min(o.lateral, q) - separation) };
    };
    const legal = bounds => bounds.min <= bounds.max;
    const immediate = o => Math.abs(o.ds) < (me.l ?? body.l) + o.l + 3;
    const sidesFor = o => {
      const remembered = this.sideMemory.get(o.id);
      if (remembered && now - remembered.time < 8) return [remembered.side];
      return [1, -1];
    };
    const chooseSide = (o, preferInside = false) => {
      const turn = Math.sign(finite(path?.at?.(targetS)?.curvature));
      const choices = sidesFor(o).map(side => {
        const bounds = sideBounds(o, side), q = clamp(base, bounds.min, Math.max(bounds.min, bounds.max));
        return { side, bounds, q, cost: Math.abs(q - current) + .55 * Math.abs(q - base)
          + (preferInside && turn && side !== turn ? 1.5 : 0) };
      }).filter(c => legal(c.bounds) && this.laneClear(c.q, car, o.id));
      choices.sort((a, b) => a.cost - b.cost);
      return choices[0] ?? null;
    };
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

    const alongside = this.list.filter(o => Math.abs(o.ds) < (me.l ?? body.l) + o.l + 2
      && Math.abs(o.lateral - me.lateral) < (me.w ?? .99) + o.w + 3
      && (Math.abs(o.lateral - me.lateral) > .8 || Math.abs(o.ds) < (me.l ?? 2.3) + o.l));
    this.followCap = blocked.reduce((cap, b) => Math.min(cap, b.cap), Infinity);
    if (this.engagement) {
      const rival = this.list.find(o => o.id === this.engagement.id);
      const e = this.engagement;
      const cleared = !rival || (e.type === 'attack' ? rival.ds < -12 : rival.ds > 10);
      if (cleared) {
        if (e.type === 'attack' && rival?.ds < -12) this.stats.completedPasses++;
        this.sideMemory.set(e.id, { side: e.side, time: now });
        this.engagement = null;
      } else {
        const advantage = e.type === 'attack' ? closingOn(rival) : rival.speed - speed;
        if (advantage < .3) e.noAdvantageSince ??= now;
        else e.noAdvantageSince = null;
        const stalledAttack = e.type === 'attack' && now > e.until && e.startGap - rival.ds < 2;
        const expiredDefense = e.type === 'defend' && now > e.until;
        const lostCorridor = !legal(sideBounds(rival, e.side));
        if (!immediate(rival) && ((e.noAdvantageSince != null && now - e.noAdvantageSince > 1) || stalledAttack || expiredDefense || lostCorridor)) {
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
      if (front && (front.ds - front.l - body.l) / closingOn(front) < 3.2) {
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
          const choice = chooseSide(rear, true), shiftTime = choice ? Math.abs(choice.q - current) / 1.7 : Infinity;
          if (choice && catchTime < 3 && catchTime > shiftTime + .6) {
            this.engagement = { id: rear.id, type: 'defend', side: choice.side, startGap: rear.ds,
              until: now + 3, noAdvantageSince: null };
            this.sideMemory.set(rear.id, { side: choice.side, time: now });
            this.defended.add(rear.id);
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
    if (this.engagement) {
      const rival = this.list.find(o => o.id === this.engagement.id);
      if (rival) reserveSide(rival, this.engagement.side);
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
      return this.finishProposals(alongside.length ? 'alongside' : 'follow',
        [{ extra: 0, hold: current, bounds: null, factor: 1 }]);
    }
    const q = constrained ? clamp(base, bounds.min, bounds.max) : base;
    for (const b of blocked) {
        const clearanceShift = Math.max(0, (me.w ?? .99) + b.o.w + .25 - Math.abs(b.o.lateral - current));
        const exitTime = clearanceShift / 1.7 + .25;
        const catchTime = b.closing > .1 ? Math.max(0, b.gap) / b.closing : Infinity;
        const passable = this.engagement?.type === 'attack' && this.engagement.id === b.o.id
          && Math.abs(q - b.o.lateral) > separationFor(b.o)
          && this.laneClear(q, car, b.o.id) && catchTime > exitTime;
        if (!passable) this.speedCap = Math.min(this.speedCap, b.cap);
    }
    const mode = alongside.length ? 'alongside' : this.engagement?.type ?? (Number.isFinite(this.speedCap) ? 'follow' : 'free');
    return this.finishProposals(mode, [{ extra: 0, hold: null, bounds: constrained ? bounds : null, factor: 1 }]);
  }
}
