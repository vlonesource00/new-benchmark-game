/**
 * Gemini Supreme v4 — Frenet traffic layer (racecraft).
 *
 * Works only from what the bridge observes: every other car's pose and speed,
 * projected onto the host track. Each nearby car ahead (or alongside) becomes a
 * forbidden band of lateral offsets around the racing line at the point where we
 * would meet it. The layer picks the cheapest free offset (0 = racing line).
 *
 * Attack: any car within `attackRange` ahead is a target even at equal speed. The
 * pass side is biased to the inside of the next corner so the move is made before
 * the braking zone, and once alongside the car holds its ground (side-by-side
 * spacing `sideSep` allows light rubbing) instead of backing out.
 * Defence: one covering move to the inside before a braking zone when a car is
 * close behind; the side is then locked (no weaving) and never steered into a
 * car that is already overlapping.
 * Following cap only when the reachable offset is still inside a band:
 * v ≤ v_o + √(2·a·(gap − margin)).
 */

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrapD = (d, L) => { d = ((d % L) + L) % L; return d > L / 2 ? d - L : d; };

export const TRAFFIC_DEFAULTS = Object.freeze({
  latSep: 2.5,       // centre-to-centre lateral clearance when planning a pass (cars ~2 m wide)
  sideSep: 2.15,     // clearance once overlapping: wheel-to-wheel, rubbing allowed
  carLen: 4.8,       // bumper-to-bumper length used for gaps
  gapMargin: 1.6,    // metres kept behind a car we cannot pass
  headway: 0.07,     // s of extra following distance per m/s of our speed
  followDecel: 11,   // braking assumed for the following cap
  horizon: 3.5,      // s: cars we reach within this time are planned around
  attackRange: 45,   // m: cars this close ahead are attacked even at equal speed
  insideBias: 1.6,   // cost bonus for passing on the inside of the next corner
  offRate: 2.2,      // m/s: the driver's reference slew limit (kept in sync)
  startCaution: 8,   // s after the green: bigger margins through the first corner
  sideHold: 1.5,     // s: minimum time before a committed side may flip
  defend: true,      // cover the inside before braking zones
  defendRange: 16,   // m: attacker distance behind that triggers a cover
  defendMax: 2.6,    // m: largest covering offset toward the inside
  pass: true,        // false: never leave the line, only the following cap
  squeeze: true,     // alongside and pinned at the road edge: drop back
  quickFlip: false,  // committed side shut, other side open, nobody alongside: flip now
  twoCorner: false,  // outside of T1 counts as an attack side when T2 turns the other way
  edgeHold: false,   // at the edge only drop back when clearly behind (nose short of their middle)
  cutback: false,    // defender covers the inside: wide entry, attack on the exit
  tow: false,        // stay in the slipstream on straights, pull out late before braking
  towPull: 1.0       // s before the braking zone (plus the gap) to pull out of the tow
});

export class TrafficLayer {
  constructor(driver, options) {
    this.driver = driver;
    this.o = { ...TRAFFIC_DEFAULTS, ...options };
    this.track = driver.track;
    this.plan = driver.plan;
    this.memo = new Map();
    this.side = 0; this.sideAt = -Infinity;
    this.cover = 0; this.coverAt = -Infinity;
    this.t0 = null;
    this.intent = 'line';
  }

  /** Inside sign of the next significant corner within `range` m (0 if none),
   *  whether a braking zone (profile drop > 6 m/s) starts within it and where,
   *  and the sign of a following corner that turns the other way (0 if none). */
  lookAhead(s, v, range) {
    const plan = this.plan, prof = this.driver.profile.v;
    let kSum = 0, brake = false, brakeAt = Infinity, vMin = Infinity;
    for (let d = 10; d <= range; d += 6) {
      const k = plan.sample(plan.k, s + d);
      if (Math.abs(k) > 0.004) kSum += k * (1 - d / (range + 30));
      const vp = plan.sample(prof, s + d);
      vMin = Math.min(vMin, vp);
      if (vp < v - 6 && brakeAt === Infinity) brakeAt = d;
    }
    if (vMin < v - 6) brake = true;
    const inside = Math.abs(kSum) > 0.01 ? Math.sign(kSum) : 0;
    // Second corner: walk through the first one, then look for the opposite turn.
    let next = 0;
    if (inside && this.o.twoCorner) {
      let inFirst = false, left = false, gap = 0;
      for (let d = 6; d <= range + 120; d += 4) {
        const k = plan.sample(plan.k, s + d), sg = Math.abs(k) > 0.006 ? Math.sign(k) : 0;
        if (!left) { if (sg === inside) inFirst = true; else if (inFirst && sg !== inside) left = true; }
        if (left) {
          if (sg === -inside) { next = sg; break; }
          if (sg === inside || (gap += 4) > 70) break;
        }
      }
    }
    return { inside, brake, brakeAt, next };
  }

  update(car, cars, proj, context) {
    const o = this.o, L = this.track.length, plan = this.plan;
    const time = context.time ?? 0;
    this.t0 ??= time;
    const early = time - this.t0 < o.startCaution;
    const sep = o.latSep + (early ? 0.4 : 0);
    const margin = o.gapMargin + (early ? 2 : 0);
    const v = Math.max(1, car.speed);
    const cur = this.driver.offset;
    const ahead = this.lookAhead(proj.s, v, Math.max(90, v * 2.2));

    // Observe: relative station, lateral, lateral velocity (finite difference).
    const obs = [], behind = [];
    for (const c of cars) {
      if (!c || c === car || c.id === car.id) continue;
      const p = context.projections?.get(c.id) ?? this.track.nearest(c.x, c.z);
      const m = this.memo.get(c.id);
      let vLat = 0, acc = 0;
      if (m && time > m.t) {
        vLat = clamp((p.lateral - m.lat) / (time - m.t), -6, 6) * 0.5 + m.vLat * 0.5;
        acc = clamp((c.speed - m.v) / (time - m.t), -20, 10) * 0.3 + m.acc * 0.7;
      }
      this.memo.set(c.id, { lat: p.lateral, v: c.speed, t: time, vLat, acc });
      const ds = wrapD(p.s - proj.s, L);
      if (ds < -o.carLen - 1.5) {
        if (ds > -o.defendRange - o.carLen) behind.push({ id: c.id, ds, lat: p.lateral, v: c.speed });
        continue;
      }
      if (ds > 150) continue;
      const closing = v - c.speed;
      // Time until our nose reaches its tail (0 if already overlapping).
      const gap = ds - o.carLen;
      const tm = gap <= 0 ? 0 : closing > 0.2 ? gap / closing : Infinity;
      if (tm > o.horizon && gap > o.attackRange) continue;
      const tp = Math.min(Number.isFinite(tm) ? tm : 1.2, 1.2);
      const lat = p.lateral + vLat * tp;
      const qo = plan.sample(plan.q, p.s);
      // Overlapping cars: wheel-to-wheel spacing and no prediction of their drift
      // (we hold our line; they must too).
      const over = gap <= 0.5;
      const w = over ? o.sideSep : sep;
      const latU = over ? p.lateral : lat;
      obs.push({ id: c.id, ds, gap, v: c.speed, acc, vLat, tm, over, lo: latU - w - qo, hi: latU + w - qo, qo, lat: p.lateral });
    }

    // Allowed offsets: stay on the road at every relevant station.
    const qHere = plan.sample(plan.q, proj.s);
    let bLo = -o.passMax - qHere, bHi = o.passMax - qHere;
    for (const b of obs) { bLo = Math.max(bLo, -o.passMax - b.qo); bHi = Math.min(bHi, o.passMax - b.qo); }
    const free = (x) => x >= bLo && x <= bHi && obs.every((b) => x <= b.lo || x >= b.hi);

    let target = 0, mode = null;
    if (obs.length && o.pass) {
      const cands = [0, cur];
      for (const b of obs) cands.push(b.lo - 0.05, b.hi + 0.05);
      let holdSide = time - this.sideAt < o.sideHold;
      // The committed side has shut, nobody is alongside: switch now instead of waiting it out.
      if (holdSide && o.quickFlip && !obs.some((b) => b.over)
        && !cands.some((x) => Math.abs(x) > 0.3 && Math.sign(x) === this.side && free(x))) holdSide = false;
      // Cutback: the car we are closing on has dived to the inside before the braking
      // zone. Do not chase it there: wide entry, square the corner, attack on the exit.
      const lead = obs.reduce((m, b) => (!b.over && b.gap > 0 && b.gap < 30 && (!m || b.gap < m.gap) ? b : m), null);
      const cut = o.cutback && ahead.brake && ahead.inside && lead && (lead.lat - lead.qo) * ahead.inside > 1.0 ? -ahead.inside : 0;
      if (cut) mode = 'cut';
      let best = null, bestCost = Infinity;
      for (const x of cands) {
        if (!free(x)) continue;
        const sgn = Math.abs(x) > 0.3 ? Math.sign(x) : 0;
        let cost = Math.abs(x) + 0.6 * Math.abs(x - cur);
        if (this.side && sgn && sgn !== this.side) cost += holdSide ? 1e6 : 4;
        // Inside of the next corner: the move that sticks under braking.
        if (ahead.inside && sgn === ahead.inside && !cut) cost -= o.insideBias;
        // Outside of this corner is the inside of the next one when they alternate.
        if (ahead.next && sgn === ahead.next) cost -= 0.8 * o.insideBias;
        if (cut && sgn !== ahead.inside) cost -= 0.5 * o.insideBias;
        // Never cross a car that is overlapping us.
        for (const b of obs) if (b.over) {
          const myRel = proj.lateral - b.lat, newRel = qHere + x - b.lat;
          if (Math.sign(myRel) !== Math.sign(newRel)) cost += 1e6;
        }
        if (cost < bestCost) { bestCost = cost; best = x; }
      }
      if (best === null || bestCost >= 1e6) {
        // Nowhere free: hold the current offset (no swerve) and follow.
        target = clamp(cur, bLo, bHi);
      } else target = best;
      // Slipstream: on a straight, sitting in the tow of the car ahead, stay there
      // and pull out only shortly before the braking zone (or when we would have to lift).
      if (o.tow && !early && lead && !cut && cur > lead.lo && cur < lead.hi && Math.abs(target - cur) > 0.3) {
        const room = lead.gap - margin - o.headway * v, closing = v - lead.v;
        const noLift = room > 3 && closing * Math.abs(closing) < o.followDecel * room;
        if (noLift && ahead.brakeAt > v * o.towPull + lead.gap) { target = clamp(cur, bLo, bHi); mode = 'tow'; }
      }
    }
    // Commit to a side while anyone is being passed; release once clear.
    const sg = Math.abs(target) > 0.3 ? Math.sign(target) : 0;
    if (sg && sg !== this.side) { this.side = sg; this.sideAt = time; }
    if (!obs.length) this.side = 0;

    // Defence: nobody to pass, a car close behind, braking zone ahead → one
    // covering move to the inside; locked until the corner is done.
    let defending = false;
    if (o.defend && !early && Math.abs(target) < 0.3 && behind.length && ahead.brake && ahead.inside) {
      const threat = behind.some((b) => b.v > v - 4 && b.ds > -o.defendRange - o.carLen);
      if (threat) {
        if (!this.cover) { this.cover = ahead.inside; this.coverAt = time; }
        // Room to the edge on the inside, never into an overlapping car.
        const want = clamp(this.cover * o.defendMax, bLo, bHi);
        const blocked = obs.some((b) => b.over && Math.sign(b.lat - proj.lateral) === this.cover);
        if (!blocked) { target = want; defending = true; }
      }
    }
    if (!defending && !ahead.brake && time - this.coverAt > 2) this.cover = 0;

    // Following cap for every car whose band our *reachable* offset still hits.
    let vCap = Infinity, capId = null;
    for (const b of obs) {
      if (b.ds < o.carLen - 0.5) continue; // overlapping: lateral rule only
      const t = Number.isFinite(b.tm) ? b.tm : o.horizon;
      const reach = cur + clamp(target - cur, -o.offRate * t, o.offRate * t);
      if (reach <= b.lo || reach >= b.hi) continue;
      // Where the car ahead will be shortly if it keeps decelerating.
      const vo = Math.max(0, b.v + Math.min(0, b.acc) * 0.35);
      const room = b.gap - margin - o.headway * v;
      const cap = vo + Math.sqrt(2 * o.followDecel * Math.max(0, room)) - (room < 0 ? Math.min(4, -room * 0.5) : 0);
      if (cap < vCap) { vCap = cap; capId = b.id; }
    }
    // Alongside, behind their front and pinned at the road edge: drop back.
    for (const b of (o.squeeze ? obs : [])) {
      if (!b.over || b.ds < (o.edgeHold ? 0.5 * o.carLen : 1.0)) continue;
      const myLat = proj.lateral, dl = myLat - b.lat;
      const atEdge = Math.abs(myLat) > o.passMax + 0.6 && Math.sign(myLat) === Math.sign(dl);
      if (Math.abs(dl) < o.sideSep + 0.3 && atEdge) {
        const cap = Math.max(0, b.v - 2);
        if (cap < vCap) { vCap = cap; capId = b.id; }
      }
    }
    this.intent = vCap < Infinity ? `follow ${capId}` : defending ? `cover ${this.cover > 0 ? '+' : '-'}`
      : mode === 'tow' ? 'tow' : mode === 'cut' ? 'cutback'
      : Math.abs(target) > 0.3 ? `pass ${target > 0 ? '+' : '-'}` : 'line';
    return { vCap: Math.max(0, vCap), offset: target };
  }
}
