import { clamp } from '../../apex/src/math.js';
import { CarModel, liveGrip } from '../../apex/src/model.js';

export const FDT = 0.1, FSTEPS = 46;          // 4.5 s of forecast

// How much each architecture moves across to cover a car in its tow before a braking zone (metres).
// Read from their documents and code: RAZOR makes one smooth cover, APEX never closes a door, SPEARHEAD keeps
// the fast course unless the catch is inside its reaction window. Unknown code gets a moderate cover.
const COVER = { razor: 1.3, apex: 0, 'next-racer': 0.4, tempest: 0.9, solstice: 0.5, 'claude-revolution': 0.6 };

/**
 * Rival forecasts in the planner's frame: for t = 0 .. 4.5 s, where the car will be along the road (metres ahead
 * of our present position), across it, how fast, and how unsure we are about where its body is.
 * Speed follows the rival's class line with its present pace ratio fading toward the line; the lateral offset from
 * that line decays; a defender is moved toward an attacker sitting in its tow. Uncertainty grows with time, more for
 * hazards and in spray.
 */
export class Forecast {
  constructor(driver) { this.driver = driver; this.models = new Map(); this.cache = new Map(); this.stamp = -1; }
  model(cls) {
    if (!this.models.has(cls)) this.models.set(cls, new CarModel(cls));
    return this.models.get(cls);
  }
  begin(now) { if (now !== this.stamp) { this.stamp = now; this.cache.clear(); } }
  of(r, me) {
    let f = this.cache.get(r.id);
    if (f) return f;
    const d = this.driver, line = d.shadow(r.cls) ?? d.line, track = d.track, L = track.length;
    const n = FSTEPS, ds = new Float64Array(n), lat = new Float64Array(n), v = new Float64Array(n), sig = new Float64Array(n), sigS = new Float64Array(n);
    const m = this.model(r.cls);
    m.grip = liveGrip(r.car).grip * (d.wetGrip?.(r.car) ?? 1) * (track.tempGrip ?? 1); m.margin = 1;
    const mass = (r.car.spec?.mass ?? 1100) + (r.car.fuel ?? 0) * 0.75;
    const st0 = line.stationOf(r.s), i0 = Math.floor(st0), f0 = st0 - i0;
    const vLine0 = Math.max(5, line.sample(line.v, i0, f0, 0));
    const k0 = r.hazard ? 1 : clamp(r.v / vLine0, 0.6, 1.2);
    const latLine0 = line.sample(line.lat, i0, f0, 0), off0 = r.d - latLine0;
    const tau = r.hazard ? 99 : r.box ? 99 : 1.6;
    // defender reaction: an attacker (us) in the tow of a same-class rival that covers
    let cover = 0;
    if (r.target && me && r.ds > 3 && r.ds < 28 && !r.mate) {
      const amount = COVER[r.arch] ?? 0.6, side = Math.sign(me.d - r.d) || 1;
      cover = side * amount;
    }
    const spray = r.spray ?? 0;
    let x = 0, sp = r.v;
    for (let k = 0; k < n; k++) {
      const t = k * FDT;
      ds[k] = r.ds + x; v[k] = sp;
      const lk = line.sample(line.lat, i0, f0, x), drift = k === 0 ? 0 : clamp(r.vl - (line.sample(line.lat, i0, f0, 5) - line.sample(line.lat, i0, f0, -5)) * r.v / 10, -3, 3) * Math.min(t, 0.5);
      let dl = r.hazard ? r.d + r.vl * Math.min(t, 0.7) : lk + off0 * Math.exp(-t / tau) + drift + cover * clamp(t / 0.8, 0, 1);
      lat[k] = clamp(dl, -track.halfWidth - 1, track.halfWidth + 1);
      sig[k] = Math.min(3, 0.15 + 0.32 * t + 0.08 * t * t + (r.hazard ? 0.8 : 0) + spray * (0.3 + 0.4 * t));
      sigS[k] = Math.min(12, 0.4 + 1.1 * t + 0.25 * t * t + spray * 2 * t);
      if (r.hazard) { const a = Math.min(0, r.a); x += Math.max(0, sp * FDT + 0.5 * a * FDT * FDT); sp = Math.max(0, sp + a * FDT); continue; }
      const k1 = 1 + (k0 - 1) * Math.exp(-t / 2.5);
      const limit = line.sample(line.v, i0, f0, x + sp * 0.12) * k1;
      const a = clamp((limit - sp) / FDT, -m.brake(Math.max(8, sp)), m.driveG(sp, m.gearAt(sp), mass));
      x += Math.max(0, sp * FDT + 0.5 * a * FDT * FDT); sp = Math.max(0, sp + a * FDT);
    }
    f = { r, ds, lat, v, sig, sigS, wrap: L };
    this.cache.set(r.id, f);
    return f;
  }
}

/** Linear sample of a forecast array at time t. */
export function at(arr, t) {
  const x = clamp(t / FDT, 0, FSTEPS - 1.001), k = Math.floor(x), f = x - k;
  return arr[k] * (1 - f) + arr[k + 1] * f;
}
