// What COUNTERPOINT knows about each rival: where it sits on the racing line of its class, how fast it drives
// against that line's profile, and where it drove at each station on its earlier laps (every car repeats its own
// line lap after lap, so that is the best guess of its lane ahead). Rivals are simulated by a pilot copy fed these.
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { Pilot } from './pilot.js';
import { followCap } from './follow.js';

export class RivalBook {
  constructor(track) { this.track = track; this.pilots = new Map(); this.rivals = new Map(); }
  /** One prepared pilot per car class; rollouts copy it (the line and envelope are shared, never rebuilt). */
  pilotFor(car) {
    let p = this.pilots.get(car.classId);
    if (!p) { p = new Pilot(this.track); p.prepare(car); p.isShadow = true; this.pilots.set(car.classId, p); }
    return p;
  }
  reset() { this.rivals.clear(); }
  observe(car, cars, dt) {
    const length = this.track.length;
    // COUNTERPOINT itself is booked too, so its own pace is measured on the same scale as the rivals'.
    for (const o of cars) {
      if (o.ghost) continue;
      const line = this.pilotFor(o).line, n = line.n;
      let r = this.rivals.get(o.id);
      const loc = line.locate(o.x, o.z, r?.hint ?? -1);
      if (!r) { r = { id: o.id, hint: loc.i, e: loc.e, edot: 0, ratio: 1, path: new Float32Array(n).fill(NaN), at: loc.i }; this.rivals.set(o.id, r); }
      else r.edot += (clamp((loc.e - r.e) / Math.max(dt, 1e-3), -6, 6) - r.edot) * Math.min(1, dt * 8);
      r.hint = loc.i; r.e = loc.e; r.car = o; r.line = line;
      if (loc.i !== r.at && o.speed > 5) {
        for (let j = (r.at + 1) % n, c = 0; c < 8; j = (j + 1) % n, c++) { r.path[j] = Number.isNaN(r.path[j]) ? loc.e : (r.path[j] + loc.e) / 2; if (j === loc.i) break; }
        r.at = loc.i;
      }
      // Pace against the profile, learnt only where the driver picks the speed: off the brakes, not flat out
      // out of a slow corner, and with nobody in front holding it up.
      const p = line.sample(line.v, loc.i, loc.f), pr = clamp(o.speed / Math.max(5, p), 0.75, 1.15), c = o.controls ?? {};
      const free = followCap(o, cars, length, { reach: 45 }) === Infinity;
      if (o.speed > 8 && (c.brake ?? 0) < 0.05 && free && ((c.throttle ?? 0) < 0.95 || pr > r.ratio)) r.ratio += (pr - r.ratio) * Math.min(1, dt * 0.8);
    }
    if (this.rivals.size > cars.length + 4) for (const [id, r] of this.rivals) if (!cars.includes(r.car)) this.rivals.delete(id);
  }
  /** The lane a rival is expected to hold at its current station: its habit there, else where it is now. */
  habit(r, x, z, hint) {
    const loc = r.line.locate(x, z, hint), h = r.path[loc.i];
    return { loc, lane: Number.isNaN(h) ? r.e : h };
  }
  near(car, from = -30, to = 90) {
    const length = this.track.length, out = [];
    for (const r of this.rivals.values()) {
      const ds = wrap(r.car.s - car.s + length / 2, length) - length / 2;
      if (r.car !== car && ds > from && ds < to && !r.car.ghost) out.push({ r, ds });
    }
    return out.sort((a, b) => Math.abs(a.ds) - Math.abs(b.ds));
  }
}
