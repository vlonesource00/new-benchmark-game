/**
 * Gemini Supreme v4 — Frenet traffic layer.
 *
 * Works only from what the bridge observes: every other car's pose and speed,
 * projected onto the host track. Each nearby car ahead (or alongside) becomes a
 * forbidden band of lateral offsets around the racing line at the point where we
 * would meet it. The layer picks the cheapest free offset (0 = racing line),
 * commits to a side for the whole pass, and — if our reachable offset is still
 * inside a band — caps our speed so that we could stop behind that car
 * (v ≤ v_o + √(2·a·(gap − margin))). No defensive moves: holding the line is the
 * only defence, so there is never a weave or a late swerve.
 */

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrapD = (d, L) => { d = ((d % L) + L) % L; return d > L / 2 ? d - L : d; };

export const TRAFFIC_DEFAULTS = Object.freeze({
  latSep: 2.9,       // centre-to-centre lateral clearance (cars are ~2 m wide)
  carLen: 4.8,       // bumper-to-bumper length used for gaps
  gapMargin: 3.5,    // metres kept behind a car we cannot pass
  headway: 0.25,     // s of extra following distance per m/s of our speed
  followDecel: 7.5,  // braking assumed for the following cap (well under the limit)
  horizon: 3.5,      // s: cars we reach within this time are planned around
  passMax: 6.5,      // |line + offset| allowed while passing: keeps ~1.7 m escape to the 8.2 m offtrack line
  offRate: 2.2,      // m/s: the driver's reference slew limit (kept in sync)
  startCaution: 14,  // s after the green: bigger margins through the first corners
  sideHold: 1.5,     // s: minimum time before a committed side may flip
  pass: true,        // false: never leave the line, only the following cap
  squeeze: true      // drop back when alongside and being squeezed
});

export class TrafficLayer {
  constructor(driver, options) {
    this.driver = driver;
    this.o = { ...TRAFFIC_DEFAULTS, ...options };
    this.track = driver.track;
    this.plan = driver.plan;
    this.memo = new Map();
    this.side = 0; this.sideAt = -Infinity;
    this.t0 = null;
    this.intent = 'line';
  }

  update(car, cars, proj, context) {
    const o = this.o, L = this.track.length, plan = this.plan;
    const time = context.time ?? 0;
    this.t0 ??= time;
    const early = time - this.t0 < o.startCaution;
    const sep = o.latSep + (early ? 0.5 : 0);
    const margin = o.gapMargin + (early ? 3 : 0);
    const v = Math.max(1, car.speed);
    const cur = this.driver.offset;

    // Observe: relative station, lateral, lateral velocity (finite difference).
    const obs = [];
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
      if (ds < -o.carLen - 1.5 || ds > 150) continue;
      const closing = v - c.speed;
      // Time until our nose reaches its tail (0 if already overlapping).
      const gap = ds - o.carLen;
      const tm = gap <= 0 ? 0 : closing > 0.2 ? gap / closing : Infinity;
      if (tm > o.horizon && gap > 8) continue;
      const tp = Math.min(tm, 1.2);
      const lat = p.lateral + vLat * tp;
      const qo = plan.sample(plan.q, p.s);
      obs.push({ id: c.id, ds, gap, v: c.speed, acc, vLat, tm, lo: lat - sep - qo, hi: lat + sep - qo, qo, lat: p.lateral });
    }

    // Allowed offsets: stay on the road at every relevant station.
    const qHere = plan.sample(plan.q, proj.s);
    let bLo = -o.passMax - qHere, bHi = o.passMax - qHere;
    for (const b of obs) { bLo = Math.max(bLo, -o.passMax - b.qo); bHi = Math.min(bHi, o.passMax - b.qo); }
    const free = (x) => x >= bLo && x <= bHi && obs.every((b) => x <= b.lo || x >= b.hi);

    let target = 0;
    if (obs.length && o.pass) {
      const cands = [0, cur];
      for (const b of obs) cands.push(b.lo - 0.05, b.hi + 0.05);
      const holdSide = time - this.sideAt < o.sideHold;
      let best = null, bestCost = Infinity;
      for (const x of cands) {
        if (!free(x)) continue;
        const sgn = Math.sign(x);
        let cost = Math.abs(x) + 0.6 * Math.abs(x - cur);
        if (this.side && sgn && sgn !== this.side) cost += holdSide ? 1e6 : 4;
        if (cost < bestCost) { bestCost = cost; best = x; }
      }
      if (best === null) {
        // Nowhere free: hold the current offset (no swerve) and follow.
        target = clamp(cur, bLo, bHi);
      } else target = best;
    }
    // Commit to a side while anyone is being passed; release once clear.
    const sg = Math.abs(target) > 0.3 ? Math.sign(target) : 0;
    if (sg && sg !== this.side) { this.side = sg; this.sideAt = time; }
    if (!obs.length) this.side = 0;

    // Following cap for every car whose band our *reachable* offset still hits.
    let vCap = Infinity, capId = null;
    for (const b of obs) {
      if (b.ds < -o.carLen + 0.5) continue; // beside/behind: lateral rule only
      const t = Number.isFinite(b.tm) ? b.tm : o.horizon;
      const reach = cur + clamp(target - cur, -o.offRate * t, o.offRate * t);
      if (reach <= b.lo || reach >= b.hi) continue;
      // Where the car ahead will be in half a second if it keeps decelerating,
      // plus a speed-proportional headway: a braking car is the usual rear-ender.
      const vo = Math.max(0, b.v + Math.min(0, b.acc) * 0.5);
      const room = b.gap - margin - o.headway * v;
      const cap = vo + Math.sqrt(2 * o.followDecel * Math.max(0, room)) - (room < 0 ? Math.min(4, -room * 0.5) : 0);
      if (cap < vCap) { vCap = cap; capId = b.id; }
    }
    // Alongside and being squeezed toward the edge: drop back rather than hold on.
    for (const b of (o.squeeze ? obs : [])) {
      if (b.ds < -o.carLen || b.ds > o.carLen + 1) continue;
      const myLat = proj.lateral, dl = myLat - b.lat;
      const closingLat = -Math.sign(dl) * b.vLat;
      const atEdge = Math.abs(myLat) > o.passMax - 0.8 && Math.sign(myLat) === Math.sign(dl);
      if (Math.abs(dl) < sep + 0.6 && (closingLat > 0.4 || atEdge)) {
        const cap = Math.max(0, b.v - 3);
        if (cap < vCap) { vCap = cap; capId = b.id; }
      }
    }
    this.intent = vCap < Infinity ? `follow ${capId}` : Math.abs(target) > 0.3 ? `pass ${target > 0 ? '+' : '-'}` : 'line';
    return { vCap: Math.max(0, vCap), offset: target };
  }
}
