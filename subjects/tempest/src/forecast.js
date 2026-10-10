import { clamp } from '../../apex/src/math.js';
import { CarModel, liveGrip } from '../../apex/src/model.js';

export const FDT = 0.1, FSTEPS = 101;         // 10 s of forecast: the planner judges passes at its horizon, up to ~8 s out
export const FSPAN = (FSTEPS - 1) * FDT;
const PACE_BIN = 20, PACE_RATE = 0.02, PACE_MIN = 3;

// How much each architecture moves across to cover a car in its tow before a braking zone (metres).
// Read from their documents and code: RAZOR makes one smooth cover, APEX never closes a door, SPEARHEAD keeps
// the fast course unless the catch is inside its reaction window. Unknown code gets a moderate cover.
const COVER = { razor: 1.3, apex: 0, 'next-racer': 0.4, tempest: 0.9, solstice: 0.5, 'claude-revolution': 0.6 };

/**
 * Rival forecasts in the planner's frame: for t = 0 .. 10 s, where the car will be along the road (metres ahead
 * of our present position), across it, how fast, and how unsure we are about where its body is.
 * Speed follows the rival's class line with its present pace ratio fading toward the line; the lateral offset from
 * that line decays; a defender is moved toward an attacker sitting in its tow. Uncertainty grows with time, more for
 * hazards and in spray.
 */
export class Forecast {
  constructor(driver) { this.driver = driver; this.models = new Map(); this.cache = new Map(); this.stamp = -1; this.pace = new Map(); }
  /**
   * Learnt pace: each rival's speed against our class line, per 20 m of road, smoothed over the laps it has been seen.
   * A car that is slow through one corner is forecast slow there again, not back on our pace after a second or two:
   * that is where a pass is made. Cars in the pit lane, boxing or out of the race teach nothing.
   */
  observe(list) {
    const d = this.driver, L = d.track.length, nb = Math.ceil(L / PACE_BIN);
    for (const r of list) {
      if (r.hazard || r.box || r.pit || r.done || !(r.v > 5)) continue;
      const line = d.shadow(r.cls) ?? d.line, st = line.stationOf(r.s), i = Math.floor(st);
      const ratio = clamp(r.v / Math.max(5, line.sample(line.v, i, st - i, 0)), 0.6, 1.2);
      let p = this.pace.get(r.id); if (!p) this.pace.set(r.id, p = { k: new Float32Array(nb).fill(1), n: new Uint16Array(nb) });
      const b = Math.floor((((r.s % L) + L) % L) / PACE_BIN) % nb;
      // the first pass through a bin takes the reading; later ones blend in slowly (a lap is ~60 visits per bin)
      p.k[b] += (ratio - p.k[b]) * (p.n[b] === 0 ? 1 : PACE_RATE); if (p.n[b] < 65535) p.n[b]++;
    }
  }
  /** Learnt pace ratio of a rival at road position s (1 where it has not been seen). */
  paceAt(id, s) {
    const p = this.pace.get(id); if (!p) return 1;
    const L = this.driver.track.length, b = Math.floor((((s % L) + L) % L) / PACE_BIN) % p.k.length;
    return p.n[b] >= PACE_MIN ? p.k[b] : 1;
  }
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
    const learn = d.options.paceLearn === true && !r.box, kl0 = learn ? this.paceAt(r.id, r.s) : 1;
    // the gearbox carried forward from the gear the car is in (it upshifts at 7450 rpm): from the top gear down, an
    // accelerating car would be read lugging a tall gear, at half its real drive above 40 m/s
    const fg = d.options.forecastGear !== false; let g = fg && r.car?.gear > 0 ? r.car.gear : m.gearAt(r.v, 1);
    for (let k = 0; k < n; k++) {
      const t = k * FDT;
      ds[k] = r.ds + x; v[k] = sp;
      const lk = line.sample(line.lat, i0, f0, x), drift = k === 0 ? 0 : clamp(r.vl - (line.sample(line.lat, i0, f0, 5) - line.sample(line.lat, i0, f0, -5)) * r.v / 10, -3, 3) * Math.min(t, 0.5);
      let dl = r.hazard ? r.d + r.vl * Math.min(t, 0.7) : lk + off0 * Math.exp(-t / tau) + drift + cover * clamp(t / 0.8, 0, 1);
      lat[k] = clamp(dl, -track.halfWidth - 1, track.halfWidth + 1);
      sig[k] = Math.min(3, 0.15 + 0.32 * t + 0.08 * t * t + (r.hazard ? 0.8 : 0) + spray * (0.3 + 0.4 * t));
      sigS[k] = Math.min(12, 0.4 + 1.1 * t + 0.25 * t * t + spray * 2 * t);
      if (r.hazard) { const a = Math.min(0, r.a); x += Math.max(0, sp * FDT + 0.5 * a * FDT * FDT); sp = Math.max(0, sp + a * FDT); continue; }
      // the present pace ratio fades toward what this car has shown at that part of the road (or our pace, unseen)
      const kl = learn ? this.paceAt(r.id, r.s + x) : 1, k1 = kl + (k0 - kl0) * Math.exp(-t / 2.5);
      const limit = line.sample(line.v, i0, f0, x + sp * 0.12) * k1;
      g = fg ? m.gearAt(sp, g) : m.gearAt(sp);
      const a = clamp((limit - sp) / FDT, -m.brake(Math.max(8, sp)), m.driveG(sp, g, mass));
      x += Math.max(0, sp * FDT + 0.5 * a * FDT * FDT); sp = Math.max(0, sp + a * FDT);
    }
    f = { r, ds, lat, v, sig, sigS, wrap: L };
    this.cache.set(r.id, f);
    return f;
  }
}

/**
 * Where the forecast puts the rival along the road at time t. Past the span it keeps moving at its last forecast
 * speed: a car is never parked at the end of its forecast, and never gone from the road. Nothing past the span is
 * evidence of a pass (see validAt).
 */
export function atDs(f, t) { return t <= FSPAN ? at(f.ds, t) : f.ds[FSTEPS - 1] + f.v[FSTEPS - 1] * (t - FSPAN); }
/** A pass or a lost place may only be scored where the forecast reaches. */
export const validAt = (t) => t <= FSPAN;

/** Linear sample of a forecast array at time t. */
export function at(arr, t) {
  const x = clamp(t / FDT, 0, FSTEPS - 1.001), k = Math.floor(x), f = x - k;
  return arr[k] * (1 - f) + arr[k + 1] * f;
}
