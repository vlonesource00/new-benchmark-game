import { Weather } from './weather.js';
import { LANES, wetFrac } from '../engine/sim/water.js';

// Road outlook: what the teams' weather radar and track reports say the road will be like over the next minutes.
// The sky is seeded, so the same Weather stepped ahead of the race gives the fronts' timing, strength and where
// each edge is (one row per second). The road is a copy of the live water field (every few nodes) stepped
// forward under that sky with the field's own fill/drain rules, plus the traffic: each cell's clearing rate is
// learnt online by comparing the live road with where the copy said it would be without cars, so the dry line
// the field is cutting keeps drying in the prediction. Strategists read the wetness along the racing line (what
// a car on the line feels, the quantity scripts/strategy/wet-rig.mjs calibrates lap times against).
const STEP = 5;          // s per prediction step
const LEARN = 10;        // s between traffic-clearing updates
export const OUTLOOK_S = 1200; // how far ahead the radar is trusted; past it conditions are held

export class RoadOutlook {
  constructor({ track, weather, line }) {
    this.track = track; this.live = weather;
    const n = track.nodes.length, stride = Math.max(1, Math.ceil(n / 600));
    this.nodes = []; for (let i = 0; i < n; i += stride) this.nodes.push(i);
    const m = this.nodes.length;
    this.basin = new Float32Array(m * LANES); this.rate = new Float32Array(m * LANES);
    this.lineLanes = new Int8Array(m);
    for (let j = 0; j < m; j++) {
      const i = this.nodes[j];
      for (let l = 0; l < LANES; l++) this.basin[j * LANES + l] = track.water.basin[i * LANES + l];
      this.lineLanes[j] = Math.max(1, Math.min(LANES - 2, track.laneAt(line ? line.offset[i] : 0)));
    }
    this.rainK = new Float32Array(m);    // scratch: inflow (mm/s) per sampled node this step
    this.sky = null; this.prev = null; this.cache = null;
    this.spec = { id: weather.id, seed: weather.seed, span: weather.span };
  }
  /** One row per second of the race's sky: everything Weather.rainAt and the evaporation need. */
  buildSky(until) {
    const s = this.spec, w = new Weather(s.id, s.seed, { span: s.span }); w.bind(this.track);
    const rows = Math.ceil(until) + 2, f = { cloud: new Float32Array(rows), intensity: new Float32Array(rows), edge: new Float32Array(rows), tail: new Float32Array(rows), clock: new Float32Array(rows), evap: new Float32Array(rows) };
    for (let t = 0; t < rows; t++) {
      f.cloud[t] = w.cloud; f.intensity[t] = w.intensity; f.edge[t] = w.edge; f.tail[t] = Number.isFinite(w.tail) ? w.tail : -1e9; f.clock[t] = w.clock; f.evap[t] = w.evaporation();
      w.step(1);
    }
    this.probe = Object.assign(Object.create(Weather.prototype), { centre: w.centre, wind: w.wind, extent: w.extent, phase: w.phase, preset: w.preset });
    this.sky = { rows, ...f };
  }
  /** Inflow (mm/s) at each sampled node at race time t, and the evaporation ratio to the live sky's now. */
  skyAt(t) {
    const r = Math.max(0, Math.min(this.sky.rows - 1, Math.round(t))), p = this.probe, s = this.sky;
    p.cloud = s.cloud[r]; p.intensity = s.intensity[r]; p.edge = s.edge[r]; p.tail = s.tail[r]; p.clock = s.clock[r];
    for (let j = 0; j < this.nodes.length; j++) { const q = this.track.nodes[this.nodes[j]]; this.rainK[j] = Math.max(0, p.rainAt(q.x, q.z)) / 3600; }
    return s.evap[r];
  }
  /** Steps a sampled depth array d from time t0 for `secs`, with (traffic) or without the learnt clearing. */
  advance(d, t0, secs, evapScale, traffic) {
    const b = this.basin, c = this.rate;
    for (let t = 0; t < secs - 1e-6; t += STEP) {
      const h = Math.min(STEP, secs - t), ev = this.skyAt(t0 + t + h / 2) * evapScale;
      for (let j = 0; j < this.nodes.length; j++) {
        const inflow = this.rainK[j];
        for (let l = 0; l < LANES; l++) {
          const k = j * LANES + l, bk = b[k];
          let w = d[k] + (inflow * (1 + 2 * bk) - 0.0045 * (1 - 0.85 * bk) * d[k] - ev * (1 - 0.6 * bk)) * h;
          if (traffic && c[k] > 0) w *= Math.exp(-c[k] * h);
          d[k] = Math.min(Math.max(w, 0), 1.6 + 5 * bk);
        }
      }
    }
  }
  sample() {
    const d = new Float32Array(this.nodes.length * LANES), src = this.track.water.depth;
    for (let j = 0; j < this.nodes.length; j++) { const i = this.nodes[j] * LANES; for (let l = 0; l < LANES; l++) d[j * LANES + l] = src[i + l]; }
    return d;
  }
  lineWet(d) {
    let s = 0;
    for (let j = 0; j < this.nodes.length; j++) { const k = j * LANES + this.lineLanes[j]; s += (wetFrac(d[k - 1]) + 2 * wetFrac(d[k]) + wetFrac(d[k + 1])) / 4; }
    return s / this.nodes.length;
  }
  /** Learns the traffic clearing; called from the race step. */
  update(time) {
    if (!this.track.water?.live) return;
    this.sky ??= (this.buildSky(Math.max(this.spec.span ?? 900, time) * 1.6 + OUTLOOK_S), this.sky);
    if (this.prev && time - this.prev.t < LEARN) return;
    const now = this.sample();
    if (this.prev) {
      const dt = time - this.prev.t, q = this.prev.d;
      this.advance(q, this.prev.t, dt, this.evapScale(this.prev.t), false);
      for (let k = 0; k < q.length; k++) {
        if (q[k] < 0.03) continue;
        const r = Math.max(0, Math.log(q[k] / Math.max(now[k], 1e-3))) / dt;
        this.rate[k] = this.rate[k] * 0.6 + Math.min(r, 0.05) * 0.4;
      }
    }
    this.prev = { t: time, d: now }; this.cache = null;
  }
  evapScale(t) { const s = this.sky.evap[Math.max(0, Math.min(this.sky.rows - 1, Math.round(t)))]; return s > 0 ? this.live.evaporation() / s : 1; }
  /**
   * Predicted racing-line wetness from `time`: { t0, step, wet: Float32Array } every STEP s up to OUTLOOK_S ahead
   * (shared by every strategist until the next learning update).
   */
  forecast(time) {
    if (!this.track.water?.live) return null;
    this.sky ??= (this.buildSky(Math.max(this.spec.span ?? 900, time) * 1.6 + OUTLOOK_S), this.sky);
    if (this.cache && Math.abs(this.cache.t0 - time) < LEARN) return this.cache;
    const d = this.sample(), n = Math.ceil(OUTLOOK_S / STEP), wet = new Float32Array(n + 1), es = this.evapScale(time);
    wet[0] = this.lineWet(d);
    for (let q = 1; q <= n; q++) { this.advance(d, time + (q - 1) * STEP, STEP, es, true); wet[q] = this.lineWet(d); }
    return this.cache = { t0: time, step: STEP, wet, now: wet[0] };
  }
  /** Mean predicted line wetness over [a, b] seconds from the forecast's start (held past the horizon). */
  static mean(f, a, b) {
    const n = f.wet.length - 1, ia = Math.min(n, Math.max(0, a / f.step)), ib = Math.min(n, Math.max(ia, b / f.step));
    if (ib - ia < 1e-6) return f.wet[Math.round(ia)];
    let s = 0, c = 0; for (let x = Math.floor(ia); x <= Math.ceil(ib); x++) { s += f.wet[Math.min(n, x)]; c++; }
    return s / c;
  }
}
