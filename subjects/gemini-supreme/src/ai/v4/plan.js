/**
 * Gemini Supreme v4 — the offline plan: racing line + base envelope.
 * Built once per track (cached at module level) and shared by all v4 cars.
 */

import { Envelope } from './envelope.js';
import { LineGeometry, minCurvature, minTime, relaxLine } from './line.js';
import { SpeedProfile } from './profile.js';

const cache = new Map();
const wrap = (x, m) => ((x % m) + m) % m;

export class RacePlan {
  constructor(track, spec, options) {
    this.track = track;
    this.options = options;
    this.envelope = new Envelope(spec, options.envelope);
    const geo = this.geo = new LineGeometry(track, options.ds);
    this.n = geo.n; this.ds = geo.ds;
    let q1 = minCurvature(geo, options.qMax);
    if (options.relax !== false) q1 = relaxLine(geo, q1, options.qMax);
    this.q = minTime(geo, q1, this.envelope, options.qMax, { budgetMs: options.lineBudgetMs }).q;
    const g = geo.evaluate(this.q);
    this.k = g.k; this.seg = g.seg; this.px = g.px; this.pz = g.pz;
    // Path heading at each node (centred difference).
    const n = this.n;
    this.heading = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n;
      this.heading[i] = Math.atan2(this.px[b] - this.px[a], this.pz[b] - this.pz[a]);
    }
    this.baseProfile = new SpeedProfile(n).solve(this.k, this.seg, this.envelope, { grip: 1 });
  }

  static get(track, spec, options) {
    const key = `${track.id}:${track.length.toFixed(3)}:${JSON.stringify(options)}`;
    if (!cache.has(key)) cache.set(key, new RacePlan(track, spec, options));
    return cache.get(key);
  }

  /** Fractional node index for centreline distance s. */
  index(s) { return wrap(s, this.track.length) / this.ds; }

  sample(arr, s) {
    const f = this.index(s), i = Math.floor(f) % this.n, t = f - Math.floor(f);
    return arr[i] + (arr[(i + 1) % this.n] - arr[i]) * t;
  }

  sampleAngle(arr, s) {
    const f = this.index(s), i = Math.floor(f) % this.n, t = f - Math.floor(f);
    const a = arr[i], b = arr[(i + 1) % this.n];
    return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
  }
}
