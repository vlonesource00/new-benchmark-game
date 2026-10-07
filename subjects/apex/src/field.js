import { clamp } from './math.js';

export const CAR_LEN = 4.56, CAR_WID = 1.96;     // OBB of every class: half-length 2.28, half-width 0.98

/**
 * Awareness of every car around us, in road coordinates. Updated each call from the public cars only:
 * track distance and lateral offset from the host projections, speed, acceleration from successive
 * snapshots (on the snapshot clock, so a seat worker's coarse dt does not matter), lateral speed and class.
 */
export class Field {
  constructor(track) { this.track = track; this.hist = new Map(); this.list = []; this.byId = new Map(); }
  reset() { this.hist.clear(); this.list = []; this.byId.clear(); }
  update(car, cars, context, now) {
    const L = this.track.length, proj = context?.projections, me = proj?.get(car.id) ?? this.track.nearest(car.x, car.z);
    this.me = { s: me.s, lat: me.lateral };
    const out = [];
    for (const o of cars) {
      if (o === car || o.id === car.id) continue;
      const p = proj?.get(o.id) ?? this.track.nearest(o.x, o.z);
      let ds = ((p.s - me.s + L * 1.5) % L) - L / 2;
      let h = this.hist.get(o.id);
      if (!h || now - h.t > 1.5 || now < h.t) h = { t: now, v: o.speed, lat: p.lateral, a: 0, vl: 0, k: 1, s: p.s };
      const dt = now - h.t;
      if (dt >= 0.04) {
        const a = clamp((o.speed - h.v) / dt, -30, 15), vl = (p.lateral - h.lat) / dt;
        h = { t: now, v: o.speed, lat: p.lateral, a: h.a * 0.6 + a * 0.4, vl: h.vl * 0.6 + vl * 0.4, k: h.k, s: p.s };
      }
      this.hist.set(o.id, h);
      const rec = { id: o.id, car: o, cls: o.classId, ds, s: p.s, lat: p.lateral, v: o.speed, a: h.a, vl: h.vl, ghost: Boolean(o.ghost && car.ghost), done: o.race?.finishTime != null,
        gap: Math.abs(ds) - CAR_LEN, heading: o.yaw, laps: (o.race?.progress ?? 0) };
      rec.ahead = ds > 0; rec.dlat = p.lateral - me.lateral;
      rec.alongside = Math.abs(ds) < CAR_LEN + 0.6 && Math.abs(rec.dlat) < 6;
      out.push(rec);
    }
    this.list = out; this.byId = new Map(out.map((r) => [r.id, r]));
    return out;
  }
  /** Nearest car ahead (by distance) within `range`, optionally only those that overlap our lateral band. */
  ahead(range = 200, pred = null) { let best = null; for (const r of this.list) if (r.ds > 0 && r.ds < range && !r.done && (!pred || pred(r)) && (!best || r.ds < best.ds)) best = r; return best; }
  behind(range = 200, pred = null) { let best = null; for (const r of this.list) if (r.ds < 0 && -r.ds < range && !r.done && (!pred || pred(r)) && (!best || -r.ds < -best.ds)) best = r; return best; }
}
