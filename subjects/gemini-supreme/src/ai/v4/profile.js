/**
 * Gemini Supreme v4 — forward/backward speed profile on a friction ellipse.
 *
 * v[i] is the target speed at node i. `util` < 1 runs below the envelope,
 * which is how v4 trades pace for tyre temperature (slip power ∝ utilisation).
 */

export class SpeedProfile {
  constructor(n) {
    this.n = n;
    this.v = new Float64Array(n);
    this.vCorner = new Float64Array(n);
    this.a = new Float64Array(n); // planned longitudinal accel, for feed-forward
  }

  solve(k, seg, env, { util = 1, latUtil = util, scale = null, cap = null, grip = env.grip } = {}) {
    const n = this.n, v = this.v, vc = this.vCorner;
    const gLat = grip * latUtil;
    let vmin = Infinity, imin = 0;
    for (let i = 0; i < n; i++) {
      // Smooth curvature over 3 nodes: the car cannot follow 2 m spikes.
      const kk = Math.max(Math.abs(k[i]), (Math.abs(k[(i + n - 1) % n]) + Math.abs(k[(i + 1) % n])) * 0.5 * 0.9);
      let s = env.cornerSpeed(kk, gLat);
      if (scale) s *= scale[i];
      if (cap) s = Math.min(s, cap[i]); // absolute ceiling (learned slip map)
      vc[i] = s; v[i] = s;
      if (s < vmin) { vmin = s; imin = i; }
    }
    const ellipse = (vi, i, p = 1) => {
      const lat = vi * vi * Math.abs(k[i]), cap = env.lat(vi, gLat);
      const r = Math.min(1, lat / Math.max(1e-6, cap));
      return Math.max(0, 1 - r * r) ** (0.5 * p);
    };
    // Braking while cornering unloads the (aero-biased) rear: the usable
    // combined region is narrower than a circle on the brake side.
    const pB = env.p.trail ?? 1;
    // Forward (acceleration) pass, starting from the slowest node, twice around.
    for (let t = 1; t <= n; t++) {
      const i = (imin + t - 1) % n, j = (imin + t) % n;
      const vi = v[i];
      const acc = env.drive(vi, grip) * util * ellipse(vi, i) - env.drag(vi);
      const lim = Math.sqrt(Math.max(0, vi * vi + 2 * seg[i] * acc));
      if (lim < v[j]) v[j] = lim;
    }
    // Backward (braking) pass.
    for (let t = 1; t <= n; t++) {
      const j = (imin - t + 1 + n) % n, i = (imin - t + n) % n;
      const vj = v[j];
      const dec = env.brake(vj, grip) * util * ellipse(vj, j, pB) + env.drag(vj);
      const lim = Math.sqrt(vj * vj + 2 * seg[i] * dec);
      if (lim < v[i]) v[i] = lim;
    }
    let time = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, vm = Math.max(1, 0.5 * (v[i] + v[j]));
      time += seg[i] / vm;
      this.a[i] = (v[j] * v[j] - v[i] * v[i]) / (2 * Math.max(0.1, seg[i]));
    }
    this.time = time;
    return this;
  }
}
