import { clamp, angle } from '../../apex/src/math.js';

export const HALF_LEN = 2.28, HALF_WID = 0.98;

/**
 * Every car around us in one road frame: track distance `s`, lateral `d` (+ right), and their rates. Target
 * eligibility (who we race) and occupancy (what we must not hit) are separate: an in-lap car is not a rival
 * but its body is solid until it leaves the road; a pit-lane car is neither.
 */
export class Perception {
  constructor(track) { this.track = track; this.reset(); }
  reset() { this.hist = new Map(); this.list = []; this.byId = new Map(); this.me = null; this.meHist = null; }
  update(car, cars, context, now, state = {}) {
    const track = this.track, L = track.length, edge = track.halfWidth + (track.curbWidth ?? 0);
    const info = new Map((state.rivals ?? []).map((r) => [r.id, r]));
    const p0 = context?.projections?.get(car.id) ?? track.nearest(car.x, car.z);
    // own lateral rate, smoothed the same way as the rivals'
    const mh = this.meHist; let vl = 0;
    if (mh && now > mh.t && now - mh.t < 1) vl = 0.5 * mh.vl + 0.5 * clamp((p0.lateral - mh.d) / (now - mh.t), -10, 10);
    if (!mh || now - mh.t >= 0.02 || now < mh.t) this.meHist = { t: now, d: p0.lateral, vl };
    const myTeam = car.team?.id ?? car.team?.name ?? null, wet = track.wetness ?? 0;
    this.me = { s: p0.s, d: p0.lateral, vl: this.meHist.vl, v: car.speed, cls: car.classId, team: myTeam, halfWidth: car.spec?.halfWidth ?? HALF_WID };
    const out = [];
    for (const other of cars) {
      if (other.id === car.id) continue;
      const meta = info.get(other.id) ?? {}, pit = meta.pit ?? null;
      if (pit === 'lane' || pit === 'service') { this.hist.delete(other.id); continue; }
      const p = context?.projections?.get(other.id) ?? track.nearest(other.x, other.z);
      const ds = ((p.s - p0.s + L * 1.5) % L) - L / 2;
      if (Math.abs(ds) > 400) { this.hist.delete(other.id); continue; }
      const hw = other.spec?.halfWidth ?? HALF_WID, hl = other.spec?.halfLength ?? HALF_LEN;
      const he = angle(other.yaw - p.heading);
      const across = hw * Math.abs(Math.cos(he)) + hl * Math.abs(Math.sin(he));
      const onRoad = Math.abs(p.lateral) - across < edge;
      if ((pit === 'release' || meta.retired) && !onRoad) { this.hist.delete(other.id); continue; }
      if (other.ghost && car.ghost) continue;
      const old = this.hist.get(other.id);
      let a = old?.a ?? 0, rvl = old?.vl ?? 0;
      if (old && now > old.t && now - old.t < 1.5) {
        const dt = now - old.t;
        if (dt >= 0.025) {
          a = 0.55 * a + 0.45 * clamp((other.speed - old.v) / dt, -30, 15);
          rvl = 0.55 * rvl + 0.45 * clamp((p.lateral - old.d) / dt, -10, 10);
          this.hist.set(other.id, { t: now, v: other.speed, d: p.lateral, a, vl: rvl });
        }
      } else this.hist.set(other.id, { t: now, v: other.speed, d: p.lateral, a: 0, vl: 0 });
      const box = pit === 'approach' || Boolean(meta.boxCalled || other.race?.boxThisLap);
      const done = other.race?.finishTime != null;
      const hazard = other.speed < 6 || (Math.abs(he) > 0.8 && other.speed < 30) || Boolean(meta.retired) || Math.abs(other.yawRate ?? 0) > 1.8;
      const team = other.team?.id ?? other.team?.name ?? null, mate = myTeam != null && team === myTeam;
      if (!onRoad && Math.sign(rvl) === Math.sign(p.lateral) && !hazard) continue;   // leaving the road, not coming back
      out.push({
        id: other.id, car: other, cls: other.classId, arch: meta.driver ?? null, s: p.s, d: p.lateral, ds, v: other.speed, a, vl: rvl,
        he, across, halfLength: hl, halfWidth: hw, box, pit, done, hazard, mate, off: !onRoad,
        // a race rival: same class, on the road, racing
        target: !box && !pit && !done && !hazard && other.classId === car.classId,
        // spray: in the wet a car ahead throws water that hides what it does
        spray: wet > 0.15 && ds > 0 && ds < 60 ? wet * clamp(other.speed / 50, 0, 1) * (1 - ds / 60) : 0
      });
    }
    const ids = new Set(out.map((r) => r.id));
    for (const id of this.hist.keys()) if (!ids.has(id)) this.hist.delete(id);
    this.list = out.sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));
    this.byId = new Map(out.map((r) => [r.id, r]));
    return this.list;
  }
}
