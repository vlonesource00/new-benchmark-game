/**
 * Gemini Supreme v4 — racing line on the host track.
 *
 * The line is a lateral offset field q(s) on a uniform ds grid of the host
 * centreline. It is fitted in two stages, both with the multi-scale
 * raised-cosine bump descent inherited from v3's GlobalTimeOptimalEngine:
 *   1. minimum curvature (local, cheap) to get the right topology;
 *   2. minimum lap time against the g-g-v envelope (global objective).
 */

import { SpeedProfile } from './profile.js';

const wrap = (i, n) => ((i % n) + n) % n;

export class LineGeometry {
  constructor(track, ds = 2) {
    this.track = track;
    this.n = Math.round(track.length / ds);
    this.ds = track.length / this.n;
    const n = this.n;
    this.cx = new Float64Array(n); this.cz = new Float64Array(n);
    this.nx = new Float64Array(n); this.nz = new Float64Array(n);
    this.ck = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = track.at(i * this.ds);
      this.cx[i] = p.x; this.cz[i] = p.z; this.nx[i] = p.nx; this.nz[i] = p.nz; this.ck[i] = p.curvature;
    }
  }

  /** Path geometry for offsets q: signed Menger curvature and segment lengths. */
  evaluate(q, out = {}) {
    const n = this.n;
    const k = out.k ?? new Float64Array(n), seg = out.seg ?? new Float64Array(n);
    const px = out.px ?? new Float64Array(n), pz = out.pz ?? new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = this.cx[i] + this.nx[i] * q[i]; pz[i] = this.cz[i] + this.nz[i] * q[i]; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      seg[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
    }
    // Curvature over a 3-node (~6 m) chord: the car filters anything shorter, and
    // a 1-node stencil turns resampling noise near centreline kinks into fake corners.
    for (let i = 0; i < n; i++) k[i] = this.menger(px, pz, i, 3);
    Object.assign(out, { k, seg, px, pz });
    return out;
  }

  menger(px, pz, i, h = 1) {
    const n = this.n, a = wrap(i - h, n), c = (i + h) % n;
    const x1 = px[i] - px[a], z1 = pz[i] - pz[a], x2 = px[c] - px[i], z2 = pz[c] - pz[i];
    const x3 = px[c] - px[a], z3 = pz[c] - pz[a];
    const cross = x1 * z2 - z1 * x2; // >0 when turning left in (x,z) → heading decreasing
    const d = Math.hypot(x1, z1) * Math.hypot(x2, z2) * Math.hypot(x3, z3);
    return d > 1e-9 ? -2 * cross / d : 0; // host sign: positive = turning to +lateral
  }
}

function bumpShape(w) {
  const shape = new Float64Array(2 * w + 1);
  for (let j = -w; j <= w; j++) shape[j + w] = 0.5 * (1 + Math.cos(Math.PI * j / (w + 1)));
  return shape;
}

/** Stage 1: minimise Σ κ² (+ small smoothness) with local span evaluation. */
export function minCurvature(geo, qMax, { scales = [40, 20, 10, 5, 2], passes = 3 } = {}) {
  const n = geo.n, q = new Float64Array(n);
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = geo.cx[i]; pz[i] = geo.cz[i]; }
  const setPoint = (i) => { px[i] = geo.cx[i] + geo.nx[i] * q[i]; pz[i] = geo.cz[i] + geo.nz[i] * q[i]; };
  const spanCost = (lo, hi) => {
    let c = 0;
    for (let t = lo; t <= hi; t++) {
      const i = wrap(t, n), k = geo.menger(px, pz, i);
      const dq = q[(i + 1) % n] - q[i];
      c += k * k + 1e-6 * dq * dq;
    }
    return c;
  };
  for (const w of scales) {
    const shape = bumpShape(w);
    const step = Math.max(1, Math.floor(w / 2));
    for (let pass = 0; pass < passes; pass++) {
      for (let amp of [2.0, 0.6, 0.2].map((a) => a * Math.min(1, w / 10))) {
        for (let c0 = 0; c0 < n; c0 += step) {
          for (const sign of [1, -1]) {
            const before = spanCost(c0 - w - 1, c0 + w + 1);
            const old = new Float64Array(2 * w + 1);
            for (let j = -w; j <= w; j++) {
              const i = wrap(c0 + j, n); old[j + w] = q[i];
              q[i] = Math.max(-qMax, Math.min(qMax, q[i] + sign * amp * shape[j + w])); setPoint(i);
            }
            if (spanCost(c0 - w - 1, c0 + w + 1) < before - 1e-12) break;
            for (let j = -w; j <= w; j++) { const i = wrap(c0 + j, n); q[i] = old[j + w]; setPoint(i); }
          }
        }
      }
    }
  }
  return q;
}

/** Stage 2: minimise lap time of the envelope's speed profile. */
export function minTime(geo, q0, envelope, qMax, { scales = [24, 12, 6], passes = 2, budgetMs = 4000 } = {}) {
  const n = geo.n, q = Float64Array.from(q0);
  const profile = new SpeedProfile(n);
  const buf = {};
  const lapTime = () => { geo.evaluate(q, buf); return profile.solve(buf.k, buf.seg, envelope).time; };
  let best = lapTime();
  const t0 = Date.now();
  for (const w of scales) {
    const shape = bumpShape(w), step = Math.max(1, Math.floor(w / 2));
    for (let pass = 0; pass < passes; pass++) {
      for (const amp of [0.8, 0.25]) {
        for (let c0 = 0; c0 < n; c0 += step) {
          if (Date.now() - t0 > budgetMs) return { q, time: best };
          for (const sign of [1, -1]) {
            const old = new Float64Array(2 * w + 1);
            for (let j = -w; j <= w; j++) {
              const i = wrap(c0 + j, n); old[j + w] = q[i];
              q[i] = Math.max(-qMax, Math.min(qMax, q[i] + sign * amp * shape[j + w]));
            }
            const t = lapTime();
            if (t < best - 1e-5) { best = t; break; }
            for (let j = -w; j <= w; j++) q[wrap(c0 + j, n)] = old[j + w];
          }
        }
      }
    }
  }
  return { q, time: best };
}

/**
 * Stage 1b: elastic-band relaxation in Cartesian space. Each point moves down
 * the bending-energy gradient (bi-Laplacian) and is projected back into the
 * corridor with the host's own nearest-point query, so tight centreline kinks
 * (where normal offsets fan out and bump descent stalls) are straightened
 * exactly as far as the legal corridor allows. Returns offsets on geo's grid.
 */
export function relaxLine(geo, q0, qMax, { iters = 1200, w = 0.06, budgetMs = 1500 } = {}) {
  const n = geo.n, track = geo.track, L = track.length;
  let x = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = geo.cx[i] + geo.nx[i] * q0[i]; z[i] = geo.cz[i] + geo.nz[i] * q0[i]; }
  let nx = new Float64Array(n), nz = new Float64Array(n);
  const ps = new Float64Array(n), pl = new Float64Array(n);
  const t0 = Date.now();
  for (let it = 0; it < iters && Date.now() - t0 < budgetMs; it++) {
    for (let i = 0; i < n; i++) {
      const a = (i + n - 2) % n, b = (i + n - 1) % n, c = (i + 1) % n, d = (i + 2) % n;
      const bx = x[a] - 4 * x[b] + 6 * x[i] - 4 * x[c] + x[d];
      const bz = z[a] - 4 * z[b] + 6 * z[i] - 4 * z[c] + z[d];
      // small Laplacian term keeps spacing even along the band
      const lx = 0.5 * (x[b] + x[c]) - x[i], lz = 0.5 * (z[b] + z[c]) - z[i];
      nx[i] = x[i] - w * bx + 0.02 * lx; nz[i] = z[i] - w * bz + 0.02 * lz;
    }
    for (let i = 0; i < n; i++) {
      const p = track.nearest(nx[i], nz[i]);
      const lat = Math.max(-qMax, Math.min(qMax, p.lateral));
      if (lat !== p.lateral) { const c = track.at(p.s); nx[i] = c.x + c.nx * lat; nz[i] = c.z + c.nz * lat; }
      ps[i] = p.s; pl[i] = lat;
    }
    [x, nx] = [nx, x]; [z, nz] = [nz, z];
  }
  // Resample (s, lateral) of the band onto the centreline grid.
  const q = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => ps[i] - ps[j]);
  for (let g = 0, k = 0; g < n; g++) {
    const s = g * geo.ds;
    while (k < n && ps[order[k]] < s) k++;
    const i1 = order[k % n], i0 = order[(k + n - 1) % n];
    let s0 = ps[i0], s1 = ps[i1];
    if (k === 0) s0 -= L; if (k === n) s1 += L;
    const t = s1 - s0 > 1e-6 ? (s - s0) / (s1 - s0) : 0;
    q[g] = pl[i0] + (pl[i1] - pl[i0]) * Math.max(0, Math.min(1, t));
  }
  return q;
}
