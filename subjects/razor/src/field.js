import { clamp, angle } from '../../apex/src/math.js';

// Target eligibility and physical occupancy are deliberately separate. An
// in-lap car cannot earn a tow/attack, but its body is solid until off the road.
export class TrafficField {
  constructor(track) { this.track = track; this.reset(); }
  reset() { this.hist = new Map(); this.list = []; this.byId = new Map(); this.me = null; }
  update(car, cars, context, now, state = {}) {
    const info = new Map((state.rivals ?? []).map(r => [r.id, r]));
    const track = this.track, edge = track.halfWidth + (track.curbWidth ?? 0);
    const p0 = context?.projections?.get(car.id) ?? track.nearest(car.x, car.z);
    this.me = { s: p0.s, lat: p0.lateral };
    const out = [];
    for (const other of cars) {
      if (other.id === car.id) continue;
      const p = context?.projections?.get(other.id) ?? track.nearest(other.x, other.z);
      const meta = info.get(other.id) ?? {}, pit = meta.pit ?? null;
      const width = other.spec?.halfWidth ?? 0.98, length = other.spec?.halfLength ?? 2.28;
      const headingError = angle(other.yaw - p.heading);
      const across = width * Math.abs(Math.cos(headingError)) + length * Math.abs(Math.sin(headingError));
      if (pit === 'lane' || pit === 'service') { this.hist.delete(other.id); continue; }
      const onRoad = Math.abs(p.lateral) - across < edge;
      if (pit === 'release' && !onRoad) { this.hist.delete(other.id); continue; }
      if (meta.retired && !onRoad) { this.hist.delete(other.id); continue; }
      if (other.ghost && car.ghost) { this.hist.delete(other.id); continue; }
      const old = this.hist.get(other.id);
      let a = old?.a ?? 0, vl = old?.vl ?? 0;
      if (old && now > old.t && now - old.t < 1.5) {
        const dt = now - old.t;
        if (dt >= 0.025) {
          a = 0.55 * a + 0.45 * clamp((other.speed - old.v) / dt, -30, 15);
          vl = 0.55 * vl + 0.45 * clamp((p.lateral - old.lat) / dt, -10, 10);
          this.hist.set(other.id, { t: now, v: other.speed, lat: p.lateral, a, vl });
        }
      } else this.hist.set(other.id, { t: now, v: other.speed, lat: p.lateral, a: 0, vl: 0 });
      const box = pit === 'approach' || Boolean(meta.boxCalled || other.race?.boxThisLap);
      const done = other.race?.finishTime != null;
      const ds = ((p.s - p0.s + track.length * 1.5) % track.length) - track.length / 2;
      const hazard = other.speed < 6 || (Math.abs(headingError) > 0.8 && other.speed < 30)
        || Boolean(meta.retired) || Math.abs(other.yawRate ?? 0) > 1.8;
      const r = { id: other.id, car: other, cls: other.classId, s: p.s, lat: p.lateral,
        ds, dlat: p.lateral - p0.lateral, v: other.speed, a, vl, heading: other.yaw,
        headingError, width: across, halfWidth: width, halfLength: length,
        along: length * Math.abs(Math.cos(headingError)) + width * Math.abs(Math.sin(headingError)),
        box, pit, done, hazard, off: !onRoad, target: !box && !pit && !done && !hazard,
        ghost: false, alongside: Math.abs(ds) < length + (car.spec?.halfLength ?? 2.28) + 0.6 };
      // Off-road cars matter when moving toward the road, not as phantom targets.
      if (!onRoad && Math.sign(vl) === Math.sign(p.lateral) && !hazard) continue;
      out.push(r);
    }
    const ids = new Set(out.map(r => r.id));
    for (const id of this.hist.keys()) if (!ids.has(id)) this.hist.delete(id);
    this.list = out.sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));
    this.byId = new Map(out.map(r => [r.id, r]));
    return this.list;
  }
}
