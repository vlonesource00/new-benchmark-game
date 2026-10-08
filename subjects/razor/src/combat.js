import { clamp } from '../../apex/src/math.js';
import { Corridors } from './corridor.js';

const wrap = (s, L) => ((s + L * 1.5) % L) - L / 2;
const sampleAt = (line, a, s) => { const j = line.stationOf(s); return line.sample(a, Math.floor(j), j % 1); };

// Bounded road-space planning. There are no native-vehicle rollouts or elapsed
// time cutoffs: identical observations produce identical decisions at any FPS.
export class RazorCombat {
  constructor(driver) {
    this.driver = driver; this.corridors = new Corridors(driver);
    const L = driver.line; this.arc = new Float64Array(L.N + 1);
    for (let i = 0; i < L.N; i++) this.arc[i + 1] = this.arc[i] + L.len[i];
    this.length = this.arc[L.N]; this.maps = new Map(); this.reset();
  }
  reset() {
    this.state = 'FREE'; this.plan = null; this.focus = null; this.cap = Infinity;
    this.next = -1; this.events = []; this.visCands = []; this.passed = new Set();
    this.stats = { plans: 0, attempts: 0, associatedPasses: 0, aborts: 0, recovers: 0, blockedNose: 0, evasions: 0 };
    this.encounters = new Map(); this.clearAt = null; this.blockedAt = null;
    this.hints = new Map();
  }
  event(now, kind, id) { this.events.push({ t: +now.toFixed(2), kind, id }); if (this.events.length > 30) this.events.shift(); }
  forecast(r, t) {
    const base = this.driver.line, map = r.map;
    if (r.hazard) return { ds: r.ds + Math.max(0, r.v * t + 0.5 * Math.min(0, r.a) * t * t), lat: r.offset + r.vl * Math.min(t, 0.7), v: Math.max(0, r.v + Math.min(0, r.a) * t) };
    const vv = base.sample(map.speed, r.bi, r.bf), ahead = r.v * t + clamp(r.a, -12, 6) * t * t * 0.15;
    const future = base.sample(map.speed, r.bi, r.bf, ahead);
    const speed = Math.max(0, r.v + (future - vv) * Math.min(1, t / 0.8));
    const correction = r.offset - base.sample(map.offset, r.bi, r.bf);
    const profileDrift = (base.sample(map.offset, r.bi, r.bf, 5) - base.sample(map.offset, r.bi, r.bf, -5)) * r.v / 10;
    const residual = clamp(r.vl - profileDrift, -3, 3);
    const lat = base.sample(map.offset, r.bi, r.bf, ahead) + correction * Math.exp(-t * 0.2) + residual * Math.min(t, 0.5);
    return { ds: r.ds + Math.max(0, 0.5 * (r.v + speed) * t), lat, v: speed };
  }
  targetOffset(r, i) {
    if (r.hazard) return r.offset;
    const base = this.driver.line, j = base.idx(i);
    const distance = Math.max(0, wrap(this.arc[j] - this.arc[r.bi] - r.bf * base.len[r.bi], this.length));
    return r.map.offset[j] + (r.offset - base.sample(r.map.offset, r.bi, r.bf)) * Math.exp(-distance / 180);
  }
  reference(cls) {
    if (this.maps.has(cls)) {
      const map = this.maps.get(cls); if (cls === this.driver.classId) map.speed = this.driver.line.v;
      return map;
    }
    const d = this.driver, base = d.line, ref = d.shadow(cls) ?? base;
    const offset = new Float64Array(base.N), speed = ref === base ? base.v : new Float64Array(base.N);
    if (ref !== base) {
      let hint = -1;
      for (let i = 0; i < base.N; i++) {
        const c = ref.closest(base.px[i], base.pz[i], hint); hint = c.i;
        const x = ref.sample(ref.px, c.i, c.f), z = ref.sample(ref.pz, c.i, c.f);
        offset[i] = (x - base.px[i]) * Math.cos(base.h[i]) - (z - base.pz[i]) * Math.sin(base.h[i]);
        speed[i] = ref.sample(ref.v, c.i, c.f);
      }
    }
    const map = { offset, speed }; this.maps.set(cls, map); return map;
  }
  observe(car, c, field) {
    const base = this.driver.line, me = base.closest(car.x, car.z, c.i);
    this.me = me;
    const s0 = this.arc[me.i] + me.f * base.len[me.i];
    const ownAngle = car.yaw - base.heading(me.i, me.f);
    this.ownWidth = car.spec.halfWidth * Math.abs(Math.cos(ownAngle)) + car.spec.halfLength * Math.abs(Math.sin(ownAngle));
    for (const r of field.list) {
      let p = base.closest(r.car.x, r.car.z, this.hints.get(r.id) ?? -1);
      if (p.d2 > 400) p = base.closest(r.car.x, r.car.z);
      this.hints.set(r.id, p.i);
      const h = base.heading(p.i, p.f), error = r.car.yaw - h;
      r.bi = p.i; r.bf = p.f; r.offset = p.e; r.dlat = p.e - me.e;
      r.ds = wrap(this.arc[p.i] + p.f * base.len[p.i] - s0, this.length);
      r.width = r.halfWidth * Math.abs(Math.cos(error)) + r.halfLength * Math.abs(Math.sin(error));
      r.along = r.halfLength * Math.abs(Math.cos(error)) + r.halfWidth * Math.abs(Math.sin(error));
      r.vl = r.car.vx * Math.cos(h) - r.car.vz * Math.sin(h);
      r.alongside = Math.abs(r.ds) < r.along + car.spec.halfLength + 0.5;
      r.map = this.reference(r.cls);
    }
    for (const id of this.hints.keys()) if (!field.byId.has(id)) this.hints.delete(id);
  }
  bounded(i, offset) {
    const d = this.driver, base = d.line, edge = d.track.halfWidth - 0.3;
    const h = this.corridors.normalH[i];
    const lateral = o => d.track.nearest(base.px[i] + Math.cos(h) * o, base.pz[i] - Math.sin(h) * o).lateral;
    if (Math.abs(lateral(offset)) <= edge) return offset;
    // Keep the proven base geometry. Road-coordinate lateral offsets jump at
    // polygonal corner joins; using them as a trajectory creates false kinks.
    let lo = 0, hi = 1;
    for (let k = 0; k < 10; k++) { const m = (lo + hi) * 0.5; if (Math.abs(lateral(offset * m)) <= edge) lo = m; else hi = m; }
    return offset * lo;
  }
  blockedRoad(field) {
    const first = field.list.find(r => r.hazard && r.v < 3 && r.ds > 0 && r.ds < Math.max(60, this.car.speed * 2.5));
    if (!first) return false;
    const row = field.list.filter(r => r.hazard && r.v < 3 && Math.abs(r.ds - first.ds) < 5);
    if (row.length < 3) return false;
    const half = this.ownWidth ?? this.car.spec.halfWidth;
    const lo = this.bounded(first.bi, -this.driver.track.halfWidth * 2), hi = this.bounded(first.bi, this.driver.track.halfWidth * 2);
    const bands = row.map(r => [r.offset - r.width - half + 0.06, r.offset + r.width + half - 0.06]).sort((a, b) => a[0] - b[0]);
    let end = lo;
    for (const [a, b] of bands) { if (a > end + 0.08) return false; end = Math.max(end, b); }
    return end >= hi - 0.08;
  }
  reach(car, r) {
    const closing = car.speed - r.v;
    if (Math.abs(r.ds) < 12) return true;
    if (r.ds < 0) return false;
    const d = this.driver, ahead = Math.min(120, r.ds + car.speed * 1.8);
    const j = d.line.stationOf(r.s + ahead), own = d.line.sample(d.line.vbrk, Math.floor(j), j % 1);
    return r.ds < Math.max(26, closing * 3.2 + 14) || (r.ds < 48 && own > r.v + 4);
  }
  chooseFocus(car, field) {
    const old = this.plan && field.byId.get(this.plan.target);
    if (old?.target && old.ds > -16 && old.ds < 90 && ['ATTACK', 'ALONGSIDE', 'CLEAR'].includes(this.state)) return old;
    if (old?.target && old.ds > -35 && old.ds < 3 && ['cover', 'hold'].includes(this.plan.kind)) return old;
    const ahead = field.list.filter(r => r.ds > -4 && r.ds < (this.driver.options.towRange ?? 110) && r.target);
    return ahead.sort((a, b) => a.ds - b.ds)[0] ?? null;
  }
  goal(car, r, side, kind) {
    const d = this.driver, half = this.ownWidth ?? car.spec.halfWidth ?? 0.98;
    return (s, i) => {
      if (kind === 'return') return 0;
      if (kind === 'cover') return this.bounded(i, side * 1.1);
      const lat = this.targetOffset(r, i);
      const gap = kind === 'tow' ? 0 : half + r.width + (r.hazard ? 1 : 0.14);
      return this.bounded(i, lat + side * gap);
    };
  }
  make(car, c, r, side, kind, active) {
    const d = this.driver, gap = (this.ownWidth ?? car.spec.halfWidth ?? 0.98) + r.width + (r.hazard ? 1 : 0.14);
    const offset = kind === 'return' ? -c.e : kind === 'cover' ? side * 1.1 - c.e : kind === 'tow' ? r.dlat : r.dlat + side * gap;
    const v = Math.max(12, car.speed);
    const latBudget = Math.max(2.5, d.model.lat(v) - Math.abs(car.ay ?? 0) * 0.55);
    const entry = clamp(Math.max(v * Math.sqrt(5.8 * Math.abs(offset) / latBudget),
      v * Math.cbrt(60 * Math.abs(offset) / Math.max(20, d.options.jerk ?? 40)), kind === 'return' ? v * 1.6 : 0), 28, 190);
    const hold = kind === 'return' ? 0 : Math.max(70, v * 2.3, Math.max(0, r.ds) + v);
    const q = this.corridors.build(car, c, this.goal(car, r, side, kind), entry, hold, active);
    return { ...q, kind, side, target: r.id, A: Math.abs(offset), tag: kind, risk: 0, score: 0, clear: false,
      born: this.now, rebuildAt: this.now + Math.max(1.4, (entry + hold * 0.45) / v), rivalLat: r.lat };
  }
  evaluate(q, car, field, focus) {
    const d = this.driver, path = q.path, dt = 0.2, horizon = 3.4;
    let progress = 0, v = car.speed, risk = 0, overlap = 0, clear = false, front = 0;
    const half = this.ownWidth ?? car.spec.halfWidth ?? 0.98, length = car.spec.halfLength ?? 2.28;
    for (let t = dt; t <= horizon + 0.01; t += dt) {
      const limit = path.sample(path.vbrk, q.i, q.f, progress + v * 0.12);
      const a = limit > v ? d.model.driveG(v, d.model.gearAt(v), car.spec.mass + car.fuel * 0.75) : -d.model.brake(v);
      v = Math.max(3, Math.min(limit, v + a * dt));
      if (q.kind === 'tow') v += d.model.towGain(v, 0.6) * dt;
      const next = progress + v * dt, lat = path.offset ? path.sample(path.offset, q.i, q.f, next) : 0;
      for (const r of field.list) {
        if (r.ds > 160 || r.ds < -35) continue;
        const f = this.forecast(r, t), dx = f.ds - next, dy = f.lat - lat;
        const width = half + r.width, span = length + r.along;
        if (dx >= span - 0.8 && dx < span + Math.max(15, v * 1.1) && Math.abs(dy) < width - 0.06) {
          const stopSpeed = Math.sqrt(f.v * f.v + 2 * d.model.brake(Math.max(8, v)) * Math.max(0, dx - span - 0.3));
          if (stopSpeed < v) { v = Math.max(stopSpeed, v - d.model.brake(Math.max(8, v)) * dt); front += dt; }
        }
        if (Math.abs(dx) < span + 0.2) {
          const penetration = width - Math.abs(dy);
          if (penetration > (d.options.rubAllowance ?? 0.06)) {
            // Side rubbing and a fast lateral strike have different costs.
            const oldLat = path.offset ? path.sample(path.offset, q.i, q.f, progress) : 0;
            const closingLat = Math.abs((lat - oldLat) / dt - r.vl);
            risk += (penetration - 0.06) ** 2 * dt * (1 + closingLat * closingLat * 0.15);
            if (dx > 0.3 && dx > span - 1.5) {
              v = Math.min(v, Math.max(2, f.v)); front += dt;
            }
          }
          if (r.id === focus?.id && Math.abs(dy) > width - 0.15) overlap += dt;
        }
        if (r.id === focus?.id && dx < -span - 1) clear = true;
      }
      progress += v * dt;
    }
    q.risk = risk; q.clear = clear; q.overlap = overlap; q.progress = progress;
    q.endGap = focus ? this.forecast(focus, horizon).ds - progress : null;
    const commitment = this.plan && this.plan.target === q.target && this.plan.side === q.side && q.kind !== 'tow' ? 1.6 : 0;
    q.score = progress - risk * 14 - front * 4 + (clear ? 4 : 0) + Math.min(2, overlap) + commitment;
    return q;
  }
  decide(now, car, c, field, r, hazard, defender) {
    const d = this.driver, active = this.plan?.path, candidates = [];
    this.corridors.release();
    const own = { path: d.line, i: c.i, f: c.f, side: 0, kind: 'fast line', target: r?.id, tag: 'fast line' };
    candidates.push(this.evaluate(own, car, field, r));
    if (this.fullBlock) {
      this.plan = { ...own, kind: 'blocked', tag: 'road blocked' }; this.visCands = [];
      this.next = now + (d.options.combatPeriod ?? 0.12); this.stats.plans++; return;
    }
    if (r && (hazard || defender || this.reach(car, r) || Math.abs(r.ds) < 10) && (hazard || defender || d.options.attacks !== false)) {
      for (const side of [-1, 1]) {
        if (!hazard && !defender && this.plan?.kind === 'return' && Math.abs(this.me.e) > 0.45) continue;
        if (defender) {
          const curve = d.line.sample(d.line.ks, c.i, c.f, Math.max(30, car.speed));
          const coverSide = Math.abs(curve) > 0.001 ? Math.sign(curve) : Math.sign(r.dlat);
          if (side !== coverSide) continue;
        }
        let q;
        if (this.plan?.target === r.id && this.plan.side === side && now < this.plan.rebuildAt
          && (!hazard || Math.abs(r.lat - this.plan.rivalLat) < 0.8)) {
          const cur = active.closest(car.x, car.z, c.i);
          q = { ...this.plan, i: cur.i, f: cur.f };
        } else q = this.make(car, c, r, side, hazard ? 'evade' : defender ? 'cover' : 'attack', active);
        candidates.push(this.evaluate(q, car, field, r));
      }
    }
    if (r?.target && r.ds > 12 && r.ds < (d.options.towRange ?? 110) && !hazard && !defender && Math.abs(r.dlat) > 0.35) {
      candidates.push(this.evaluate(this.make(car, c, r, 0, 'tow', active), car, field, r));
    }
    // A committed side owns its corridor through overlap. Small prediction
    // fluctuations cannot send it across the rival's body to the other side.
    const committed = this.plan && this.plan.target === r?.id && this.plan.side !== 0;
    const useful = candidates.filter(q => q.kind !== 'attack' || q.overlap > 0.15 || q.clear || q.endGap < 8);
    let best = useful.reduce((a, b) => b.score > a.score ? b : a);
    if (defender) {
      const cover = candidates.find(q => q.kind === 'cover');
      if (cover && cover.progress >= own.progress - 3 && cover.risk < 0.15) best = cover;
      else best = { ...own, kind: 'hold', tag: 'defend exit speed' };
    }
    if (committed) {
      const hold = candidates.find(q => q.side === this.plan.side && q.kind !== 'fast line');
      const wanted = r.offset + this.plan.side * ((car.spec.halfWidth ?? 0.98) + r.width - 0.06);
      const closed = Math.abs(this.bounded(r.bi, wanted) - wanted) > 0.45;
      if (closed) this.blockedAt ??= now; else this.blockedAt = null;
      // Forecast uncertainty cannot uncommit a physically open side. A side
      // change while overlapping would cross the opponent's occupied body.
      const viable = hold && (hold.progress >= own.progress - 14 || r.alongside || hold.endGap < 8);
      if (viable && (!closed || now - this.blockedAt < 0.5 || r.alongside)) best = hold;
    }
    if (best.kind === 'fast line' && this.plan?.path !== d.line && Math.abs(c.e) > 0.25) {
      if (this.plan?.kind === 'return' && now < this.plan.rebuildAt) {
        const cur = active.closest(car.x, car.z, c.i); best = { ...this.plan, i: cur.i, f: cur.f };
      } else {
        const dummy = r ?? { id: null, ds: 0, dlat: 0, width: 1 };
        best = this.make(car, c, dummy, 0, 'return', active);
      }
      this.evaluate(best, car, field, r); candidates.push(best);
    }
    if (best.kind === 'attack' && (!this.plan || this.plan.target !== r.id || this.plan.kind !== 'attack')) {
      this.stats.attempts++; this.event(now, 'committed attack', r.id);
      if (r.ds > 5) this.passed.delete(r.id);
      this.encounters.set(r.id, { started: now, side: best.side, maxOffset: 0, hadOverlap: false });
    }
    if (best.kind === 'evade' && this.plan?.kind !== 'evade') { this.stats.evasions++; this.event(now, 'evade', r.id); }
    if (this.plan?.kind === 'attack' && best.kind !== 'attack' && r?.ds > 0) {
      this.stats.aborts++; this.event(now, 'attack no longer viable', r.id);
    }
    if (best.kind === 'attack') {
      const curve = d.line.sample(d.line.ks, c.i, c.f, Math.max(15, car.speed * 0.7));
      best.tag = Math.abs(curve) < 0.001 ? 'straight separation' : best.side === Math.sign(curve) ? 'inside attack' : 'outside attack';
    }
    this.plan = best; this.stats.plans++;
    this.visCands = candidates.map(q => ({ kind: q.kind, side: q.side, score: +q.score.toFixed(2), risk: +q.risk.toFixed(3), endGap: q.endGap, chosen: q === best, clear: q.clear,
      points: Array.from({ length: 31 }, (_, k) => { const i = q.path.idx(q.i + k * 2); return { x: q.path.px[i], z: q.path.pz[i], v: q.path.vbrk[i] }; }) }));
    this.next = now + (d.options.combatPeriod ?? 0.12);
  }
  noseCap(car, field) {
    const d = this.driver, length = car.spec.halfLength ?? 2.28, half = car.spec.halfWidth ?? 0.98;
    let cap = Infinity, blocked = null; this.noseBrake = 0;
    for (const r of field.list) {
      // The rival's rear must be ahead of our nose; a genuine side-by-side
      // overlap receives no longitudinal collision cap.
      const dx = r.car.x - car.x, dz = r.car.z - car.z;
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw), rx = fz, rz = -fx;
      const cos = Math.cos(r.car.yaw - car.yaw), sin = Math.sin(r.car.yaw - car.yaw);
      const extent = r.halfLength * Math.abs(cos) + r.halfWidth * Math.abs(sin);
      const across = r.halfWidth * Math.abs(cos) + r.halfLength * Math.abs(sin);
      const gap = dx * fx + dz * fz - extent - length;
      if (gap < -1.4 || gap > Math.max(18, car.speed * 1.4)) continue;
      const relative = car.speed - r.v, ttc = Math.max(0, gap) / Math.max(0.5, relative);
      const dy = dx * rx + dz * rz, width = half + r.width - 0.06;
      // A corner-to-side rub is not a stopped/rear-ended car across the nose.
      if (Math.abs(dy) >= across + half * (r.hazard || r.box ? 1 : 0.35) + (r.hazard ? 0.15 : 0)) continue;
      if (this.plan?.path && this.plan.path !== d.line && relative > 0.5) {
        const ahead = car.speed * Math.min(1.8, Math.max(0.08, ttc - 0.12));
        const q = this.plan.path.closest(car.x, car.z, this.plan.i);
        const nextLat = this.plan.path.offset ? this.plan.path.sample(this.plan.path.offset, q.i, q.f, ahead) : 0;
        const future = this.forecast(r, Math.min(1.8, Math.max(0.08, ttc - 0.12)));
        if (Math.abs(future.lat - nextLat) >= width + 0.12 + Math.min(0.7, Math.abs(q.e))) continue;
      }
      const lateralUse = Math.min(0.95, Math.abs(car.ay ?? 0) / Math.max(1, d.model.lat(Math.max(8, car.speed))));
      const brake = Math.max(2.5, d.model.brake(Math.max(8, car.speed)) * Math.sqrt(1 - lateralUse * lateralUse));
      const safe = Math.sqrt(Math.max(0, r.v * r.v + 2 * brake * Math.max(0, gap - 0.3)));
      if (this.fullBlock && r.hazard && r.v < 6 && car.speed > 6) {
        // A scalar speed cap has no braking gradient; the pace controller's
        // coasting band cannot stop a car against a fully blocked road. Use
        // the same verified nose constraint to request the required braking.
        const reserve = car.speed * (0.12 + (d.controlDelay ?? 0));
        const required = Math.max(0, (car.speed * car.speed - r.v * r.v) / (2 * Math.max(0.5, gap - reserve)));
        const demand = required / Math.max(2.5, brake * (this.fullBlock ? 0.65 : 0.85));
        if (demand > 0.45) this.noseBrake = Math.max(this.noseBrake, clamp(demand, 0, 1));
      }
      if (safe < cap) { cap = safe; blocked = r.id; }
    }
    this.contact = blocked ? { type: 'nose blocked', id: blocked } : null;
    if (blocked) this.stats.blockedNose++;
    return cap;
  }
  update(now, car, c, v, field) {
    this.field = field; this.car = car; this.now = now;
    this.observe(car, c, field);
    const wasBlocked = this.fullBlock; this.fullBlock = this.blockedRoad(field);
    if (wasBlocked !== this.fullBlock) this.next = -1;
    for (const [id, e] of this.encounters) {
      const r = field.byId.get(id);
      if (!r?.target) { this.encounters.delete(id); continue; }
      e.maxOffset = Math.max(e.maxOffset, Math.abs(c.e)); e.hadOverlap ||= r.alongside;
      if (r.ds < -(car.spec.halfLength + r.along + 1.2) && e.hadOverlap && e.maxOffset > 0.7 && !this.passed.has(id)) {
        this.stats.associatedPasses++; this.passed.add(id); this.event(now, 'pass associated with move', id); this.encounters.delete(id);
      } else if (now - e.started > 25) this.encounters.delete(id);
    }
    let r = this.chooseFocus(car, field), hazard = false, defender = false;
    const obstacle = field.list.find(q => (q.hazard || q.box || q.pit || q.done) && q.ds > -2
      && q.ds < (q.hazard ? Math.max(45, v * 2.5) : Math.max(22, (v - q.v) * 3.5)) && Math.abs(q.dlat) < q.width + 2.5);
    if (obstacle) { r = obstacle; hazard = true; }
    if (!r) {
      const behind = field.list.find(q => q.target && q.cls === car.classId && q.ds < -5 && q.ds > -30 && q.v > v + 0.4);
      if (behind && this.driver.options.defend !== false) { r = behind; defender = true; }
    }
    if (!hazard && r?.target && r.ds < 0 && r.cls === car.classId && this.plan?.kind !== 'attack') defender = this.driver.options.defend !== false;
    this.focus = r ? { id: r.id, kind: hazard ? 'obstacle' : defender ? 'threat' : 'rival', ds: r.ds } : null;
    // Do not retain a target or its corridor after it boxes. Physical evasion
    // above is a separate action and never supplies a drafting reward.
    if (this.plan?.target != null && !field.byId.get(this.plan.target)?.target && !hazard) this.next = -1;
    if (now >= this.next || (hazard && this.plan?.target !== r.id) || (r?.alongside && this.plan?.kind === 'tow')) this.decide(now, car, c, field, r, hazard, defender);
    const kind = this.plan?.kind;
    this.state = kind === 'blocked' ? 'BLOCKED' : kind === 'evade' ? 'EVADE' : kind === 'cover' || kind === 'hold' ? 'DEFEND' : kind === 'attack' ? (r?.alongside ? 'ALONGSIDE' : r?.ds < -5 ? 'CLEAR' : 'ATTACK') : kind === 'tow' ? 'TOW' : r?.target && kind === 'fast line' ? 'PURSUE' : 'FREE';
    this.cap = this.noseCap(car, field);
    return { path: this.plan?.path ?? this.driver.line, cap: this.cap };
  }
  neighbor(v) {
    if (!this.field || !this.car) return null;
    const width = this.car.spec.halfWidth ?? 0.98;
    const r = this.field.list.find(q => q.alongside && Math.abs(q.dlat) < width + q.width + 0.8);
    if (!r) return null;
    const gap = Math.abs(r.dlat) - width - r.width;
    // The shared controller subtracts a road-lateral path slope. RAZOR's
    // observations instead use the smooth base-line normal; road coordinates
    // jump at polygon joins. Translate the physical corridor sweep into that
    // interface, without turning a coordinate jump into a steering correction.
    const d = this.driver, path = d.path ?? d.line, pose = d.controlPose ?? this.car;
    const q = path.closest(pose.x, pose.z, d.cur?.i ?? this.me.i);
    const b = d.line.closest(pose.x, pose.z, d.cursor);
    const legacySlope = clamp((path.sample(path.lat, path.idx(q.i + 2), q.f) - path.sample(path.lat, path.idx(q.i - 2), q.f)) / (4 * path.ds), -0.6, 0.6);
    const sweep = Math.sin(path.heading(q.i, q.f) - d.line.heading(b.i, b.f)), dir = Math.sign(r.dlat);
    // Permit controlled rubbing; constrain lateral closing, not the pedals.
    return { id: r.id, dir, gap, rate: Math.max(-0.25, (gap + 0.06) / 0.35) + dir * (r.vl + v * (legacySlope - sweep)) };
  }
  vis() {
    return { field: (this.field?.list ?? []).slice(0, 12).map(r => ({ id: r.id, ds: r.ds, l: r.lat, v: r.v, target: r.target, box: r.box, hazard: r.hazard })),
      decision: this.plan?.kind ?? 'fast line', latency: this.driver.options.combatPeriod ?? 0.12 };
  }
}
