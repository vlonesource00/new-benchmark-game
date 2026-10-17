// ORACLE lanes: a way off the racing line that the car can really drive, built as a path of its own.
//
// A lane is an offset y (metres right of the line) at each line station over a window ahead of the car. It starts
// where the car is: its offset and the direction it is already moving across the road, with a quintic join (zero
// lateral acceleration and jerk at both ends) to the goal, so a new lane never asks for a kink the car is not
// already making. The goal is held, then eased back to the line. The goal is kept inside the road (less a margin)
// before the join, and smoothed after that clamp, so the road's edge never folds a kink into the path.
//
// The lane then gets what the line has: positions, curvature from its own points, a corner limit from the
// measured envelope and a braking pass on its own geometry, ending on the line's profile. The driver follows those
// speeds and the planner scores the same ones, so the lane that is chosen is the lane that is driven.
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { at } from './envelope.js';

const PAD = 6;   // stations computed either side of the window, for curvature stencils

/** Quintic easing from 1 to 0 with zero slope and curvature at both ends. */
const ease = (u) => (u <= 0 ? 1 : u >= 1 ? 0 : 1 - u * u * u * (10 - 15 * u + 6 * u * u));

export class Lane {
  /**
   * line: ORACLE's Line. from: { i, f } of the car on the line. d0, m0: the car's offset from the line and its
   * slope dy/ds. goal(j): wanted offset at window station j. entry, hold, back: lengths (m) of the join, the held
   * goal and the return to the line. tag: what the lane is for (shown and logged).
   */
  constructor(line, { i, f }, d0, m0, goal, { entry, hold, back = 60, tag = 'lane', side = 0, target = null, edge } = {}) {
    this.line = line; this.tag = tag; this.side = side; this.target = target;
    const ds = line.ds, n = this.n = Math.max(4, Math.ceil((entry + hold + back) / ds) + 1), N = line.n, m = edge ?? line.options.laneEdge ?? 1.8;
    this.i0 = i; this.f0 = f; this.entry = entry; this.holdEnd = entry + hold;
    // Goal per station, inside the road, then smoothed (clamp first, smooth after: a clamp alone leaves corners).
    const g = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const k = (i + j) % N, x = (j - f) * ds, w = line.w[k];
      const raw = x > this.holdEnd ? goal(j) * ease((x - this.holdEnd) / back) : goal(j);
      g[j] = clamp(raw, Math.min(0, line.lo[k] + m - w), Math.max(0, line.hi[k] - m - w));
    }
    smooth(g, 3, 3);
    // Join from the car's offset and slope to the goal: y = g + e, e a quintic from (d0 - g0, m0 - g0') to zero.
    const L = Math.max(ds * 2, entry), e0 = d0 - g[0], s0 = m0 - (g[Math.min(n, 2)] - g[0]) / (2 * ds);
    const y = this.y = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const u = clamp((j - f) * ds / L, 0, 1);
      const h0 = 1 - u * u * u * (10 - 15 * u + 6 * u * u), h1 = u - u * u * u * (6 - 8 * u + 3 * u * u);
      y[j] = g[j] + (u < 1 ? e0 * h0 + s0 * L * h1 : 0);
    }
    this.geometry();
  }
  /** Positions, curvature, corner limits and the braking profile, all on the lane's own path. */
  geometry() {
    const line = this.line, n = this.n, N = line.n, ds = line.ds, T = n + 1 + 2 * PAD;
    const x = this.x = new Float64Array(T), z = this.z = new Float64Array(T), k = this.k = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const j = t - PAD, i = wrap(this.i0 + j, N), yy = j < 0 ? this.y[0] : j > n ? 0 : this.y[j];
      x[t] = line.cx[i] + line.nx[i] * (line.w[i] + yy); z[t] = line.cz[i] + line.nz[i] * (line.w[i] + yy);
    }
    for (let t = 2; t < T - 2; t++) k[t] = menger(x, z, t - 2, t, t + 2);
    const vlim = new Float64Array(n + 1), up = line.options.laneUp ?? 1.04, jerk = line.options.jerk ?? Infinity;
    // Line metres per lane metre: the outside of a turn is a longer way round for the same progress.
    this.r = new Float64Array(n + 1); this.len = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const t = j + PAD, i = wrap(this.i0 + j, N), g = line.grip[i], dk = Math.abs(k[t + 3] - k[t - 3]) / (6 * ds);
      vlim[j] = Math.min(line.speedAt(Math.abs(k[t]) / g), Math.cbrt(jerk * g / Math.max(1e-9, dk)), line.vlim[i] * up);
      const ln = Math.hypot(x[t + 1] - x[t], z[t + 1] - z[t]), i1 = (i + 1) % N;
      this.len[j] = ln; this.r[j] = Math.hypot(line.x[i1] - line.x[i], line.z[i1] - line.z[i]) / Math.max(1e-6, ln);
    }
    // Braking pass, from the line's own target at the window's end.
    const vb = this.vb = vlim, env = line.env;
    vb[n] = Math.min(vb[n], line.vb[wrap(this.i0 + n, N)]);
    for (let j = n - 1; j >= 0; j--) {
      const i1 = wrap(this.i0 + j + 1, N), vn = vb[j + 1], lat = at(env.lat, vn) * line.latScale * line.grip[i1];
      const used = Math.min(1, vn * vn * Math.abs(k[j + 1 + PAD]) / Math.max(1e-6, lat)), p = line.options.combExp ?? 2, rest = Math.max(line.options.ellFloor ?? 0.2, (1 - used ** p) ** (1 / p));
      vb[j] = Math.min(vb[j], Math.sqrt(vn * vn + 2 * this.len[j] * at(env.brake, vn) * line.brakeGain * line.grip[i1] * rest));
    }
  }
  /** Window position (fractional station) of line position (i, f) plus d metres of line ahead. */
  q(i, f, d = 0) {
    const N = this.line.n; let di = wrap(i - this.i0, N); if (di > N / 2) di -= N;
    return di + f + d / this.line.ds;
  }
  /** Linear sample of a window array at window position q; past the window, the line's own value `out`. */
  sample(arr, q, out) {
    if (q >= this.n) return out;
    const a = Math.max(0, Math.floor(q)), t = clamp(q - a, 0, 1);
    return arr[a] * (1 - t) + arr[Math.min(this.n, a + 1)] * t;
  }
  offset(q) { return this.sample(this.y, q, 0); }
  ratio(q) { return this.sample(this.r, q, 1); }
  /** Braking-profile speed at window position q (before the live grip scale); the line's past the window. */
  speed(q) { if (q >= this.n) { const L = this.line, u = this.i0 + q; return L.sample(L.vb, Math.floor(u) % L.n, u - Math.floor(u)); } return this.sample(this.vb, q); }
  /** World point at window position q. */
  point(q) {
    if (q >= this.n) { const u = this.i0 + q, L = this.line; return L.point(wrap(Math.floor(u), L.n), u - Math.floor(u), 0, 0); }
    const t = Math.max(0, q) + PAD, a = Math.floor(t), u = t - a;
    return { x: this.x[a] * (1 - u) + this.x[a + 1] * u, z: this.z[a] * (1 - u) + this.z[a + 1] * u };
  }
  done(i, f) { return this.q(i, f) >= this.n - 1; }
}

/** The car's offset from the line and the slope it is moving across it at (dy/ds, + is to the right). */
export function pose(line, car, loc) {
  const N = line.n, a = wrap(loc.i - 1, N), b = (loc.i + 2) % N, tx = line.x[b] - line.x[a], tz = line.z[b] - line.z[a], len = Math.hypot(tx, tz) || 1;
  const along = (car.vx * tx + car.vz * tz) / len, across = (car.vx * tz - car.vz * tx) / len;
  return { d0: loc.e, m0: car.speed > 3 ? clamp(across / Math.max(2, along), -0.35, 0.35) : 0 };
}

/**
 * Join length for a lateral move of D metres at speed v: the quintic's peak lateral acceleration (5.77 D v² / L²)
 * held to the grip the corner leaves, and its peak jerk (60 D v³ / L³) to what the tyres build without a slide.
 */
export function joinLength(v, D, spare, jerk = 40, min = 25) {
  return Math.max(min, v * Math.sqrt(5.8 * Math.abs(D) / Math.max(1, spare)), v * Math.cbrt(60 * Math.abs(D) / jerk));
}

function smooth(a, radius, passes) {
  const n = a.length, b = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) { let s = 0, c = 0; for (let d = -radius; d <= radius; d++) { const k = j + d; if (k >= 0 && k < n) { s += a[k]; c++; } } b[j] = s / c; }
    a.set(b);
  }
}

function menger(x, z, a, b, c) {
  const cross = (x[b] - x[a]) * (z[c] - z[a]) - (z[b] - z[a]) * (x[c] - x[a]);
  const d = Math.hypot(x[b] - x[a], z[b] - z[a]) * Math.hypot(x[c] - x[b], z[c] - z[b]) * Math.hypot(x[c] - x[a], z[c] - z[a]);
  return d > 1e-9 ? 2 * cross / d : 0;
}
