import { clamp, angle } from './math.js';

/**
 * A closed racing line on fixed stations along the track. Station i sits at track distance i·ds, and the
 * line passes through it at lateral offset q[i] from the centreline (+ right). The path is the polyline of
 * those points, so geometry (headings, signed curvature, arc length) comes from the points themselves
 * and a bump in q is a bump in the path.
 */
export class Line {
  constructor(track, { ds = 3, edge = -0.5 } = {}) {
    this.track = track;
    const N = this.N = Math.max(64, Math.round(track.length / ds)); this.ds = track.length / N;
    this.edge = edge; this.bound = track.halfWidth + edge;
    this.px = new Float64Array(N); this.pz = new Float64Array(N); this.len = new Float64Array(N);
    this.h = new Float64Array(N); this.k = new Float64Array(N); this.ks = new Float64Array(N); this.dk = new Float64Array(N);
    this.st = new Float64Array(N); this.lat = new Float64Array(N);
    for (let i = 0; i < N; i++) { const p = track.at(i * this.ds); this.px[i] = p.x; this.pz[i] = p.z; }
    this.trim = new Float64Array(N).fill(1);
    this.vmax = new Float64Array(N); this.v = new Float64Array(N);
    this.geometry(); this.locate();
  }
  idx(i) { const N = this.N; return ((i % N) + N) % N; }
  /** Track coordinates (distance and lateral offset) of every point. */
  locate() { for (let i = 0; i < this.N; i++) { const q = this.track.nearest(this.px[i], this.pz[i]); this.st[i] = q.s; this.lat[i] = q.lateral; } }
  /** Segment lengths, headings and signed curvature (+ right turn) of the polyline (px, pz). */
  geometry(px = this.px, pz = this.pz, out = this) {
    const N = this.N, { len, h, k, ks } = out, dk = out.dk;
    for (let i = 0; i < N; i++) {
      const j = i + 1 === N ? 0 : i + 1, a = i === 0 ? N - 1 : i - 1;
      const abx = px[i] - px[a], abz = pz[i] - pz[a], bcx = px[j] - px[i], bcz = pz[j] - pz[i];
      const lab = Math.hypot(abx, abz), lbc = Math.hypot(bcx, bcz), lac = Math.hypot(px[j] - px[a], pz[j] - pz[a]);
      len[i] = lbc; h[i] = Math.atan2(px[j] - px[a], pz[j] - pz[a]);
      // heading = atan2(dx, dz): a right turn raises it, so right turns are positive.
      k[i] = 2 * (abz * bcx - abx * bcz) / Math.max(1e-9, lab * lbc * lac);
    }
    for (let i = 0; i < N; i++) {
      const a = i === 0 ? N - 1 : i - 1, j = i + 1 === N ? 0 : i + 1;
      ks[i] = 0.25 * k[a] + 0.5 * k[i] + 0.25 * k[j];
    }
    const R = 3;
    for (let i = 0; i < N; i++) { const a = (i - R + N) % N, b = (i + R) % N; dk[i] = Math.abs(ks[b] - ks[a]) / Math.max(1e-6, 2 * R * len[i]); }
    return out;
  }
  /** Quasi-steady-state lap on this line for `model`; fills this.v and returns the lap time. */
  speeds(model, o = {}) {
    const N = this.N, ks = this.ks, len = this.len, vmax = this.vmax, v = o.out ?? this.v, trim = this.trim, dk = this.dk, J = o.jerk ?? model.jerk;
    const pb = o.brakeExp ?? 2, pd = o.driveExp ?? 2, top = o.top ?? 95, m0 = model.margin;
    const lat = (s, i) => { model.margin = m0 * trim[i]; const a = model.lat(s); model.margin = m0; return a; };
    for (let i = 0; i < N; i++) {
      const ak = Math.abs(ks[i]); let s = top;
      if (ak > 1e-6) { s = Math.min(top, Math.sqrt(lat(40, i) / ak)); for (let it = 0; it < 5; it++) s = Math.min(top, Math.sqrt(lat(s, i) / ak)); }
      if (J > 0 && dk[i] > 1e-7) s = Math.min(s, Math.cbrt(J / dk[i]));
      vmax[i] = s;
    }
    let start = 0; for (let i = 1; i < N; i++) if (vmax[i] < vmax[start]) start = i;
    v.set(vmax);
    const util = (i, s) => Math.min(1, s * s * Math.abs(ks[i]) / lat(s, i));
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < N; j++) {
        const i = (start + j) % N, nx = i + 1 === N ? 0 : i + 1, s = v[i], r = util(i, s);
        const a = model.drive(s, o.mass) * Math.pow(1 - Math.pow(r, pd), 1 / pd);
        const t = Math.sqrt(s * s + 2 * len[i] * Math.max(0, a));
        if (t < v[nx]) v[nx] = t;
      }
      for (let j = 0; j < N; j++) {
        const i = ((start - j) % N + N) % N, pv = i === 0 ? N - 1 : i - 1, s = v[i], r = util(i, s);
        model.margin = m0 * trim[i]; const b = model.brake(s) * Math.pow(1 - Math.pow(r, pb), 1 / pb); model.margin = m0;
        const t = Math.sqrt(s * s + 2 * len[pv] * Math.max(0.5, b));
        if (t < v[pv]) v[pv] = t;
      }
    }
    let T = 0; for (let i = 0; i < N; i++) T += len[i] / Math.max(1, 0.5 * (v[i] + v[i + 1 === N ? 0 : i + 1]));
    return T;
  }
  /** Moves point i back inside the corridor the stewards use (|track lateral| <= bound). */
  project(px, pz, i) {
    const q = this.track.nearest(px[i], pz[i]), B = this.bound;
    if (Math.abs(q.lateral) > B) { const o = Math.sign(q.lateral) * B; px[i] = q.x + q.nx * o; pz[i] = q.z + q.nz * o; }
  }
  /** Even arc-length spacing keeps the curvature stencils well conditioned. */
  resample() {
    const N = this.N, { px, pz } = this; this.geometry();
    const cum = new Float64Array(N + 1); for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + this.len[i];
    const L = cum[N], nx = new Float64Array(N), nz = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const d = i * L / N; while (cum[j + 1] < d) j++;
      const t = (d - cum[j]) / Math.max(1e-9, this.len[j]), b = this.idx(j + 1);
      nx[i] = px[j] + (px[b] - px[j]) * t; nz[i] = pz[j] + (pz[b] - pz[j]) * t;
    }
    px.set(nx); pz.set(nz); this.geometry();
  }
  /** Minimum-curvature seed: elastic band on the second difference, normal moves only, projected into the corridor. */
  seed(sweeps = 1500, omega = 1.5) {
    const N = this.N, { px, pz } = this;
    for (let s = 0; s < sweeps; s++) {
      for (let i = 0; i < N; i++) {
        const m2 = this.idx(i - 2), m1 = this.idx(i - 1), p1 = this.idx(i + 1), p2 = this.idx(i + 2);
        const tx = (4 * (px[m1] + px[p1]) - px[m2] - px[p2]) / 6, tz = (4 * (pz[m1] + pz[p1]) - pz[m2] - pz[p2]) / 6;
        let ux = px[p1] - px[m1], uz = pz[p1] - pz[m1]; const m = Math.hypot(ux, uz) || 1; ux /= m; uz /= m;
        const d = ((tx - px[i]) * uz - (tz - pz[i]) * ux) * omega;
        px[i] += uz * d; pz[i] -= ux * d;
        this.project(px, pz, i);
      }
      if (s % 50 === 49) this.resample();
    }
    this.resample(); this.locate();
  }
  /** Smooth bumps along the path normal, kept when the QSS lap gets faster. */
  optimise(model, { iterations = 20000, seed = 1, log = null, ...o } = {}) {
    let hh = seed >>> 0; const rnd = () => { hh = (Math.imul(hh ^ (hh >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return hh / 4294967296; };
    const N = this.N, tx = new Float64Array(N), tz = new Float64Array(N), scratch = new Float64Array(N);
    const trial = { len: new Float64Array(N), h: new Float64Array(N), k: new Float64Array(N), ks: new Float64Array(N), dk: new Float64Array(N) };
    let best = this.speeds(model, o);
    for (let it = 0; it < iterations; it++) {
      tx.set(this.px); tz.set(this.pz);
      const c = Math.floor(rnd() * N), w = (3 + rnd() * rnd() * 22) * 3 / this.ds, a = (rnd() - 0.5) * 2 * (0.05 + rnd() * rnd() * 1.6);
      const span = Math.ceil(2.5 * w);
      for (let d = -span; d <= span; d++) {
        const j = this.idx(c + d), m = this.idx(j - 1), p = this.idx(j + 1);
        const ux = this.px[p] - this.px[m], uz = this.pz[p] - this.pz[m], mag = Math.hypot(ux, uz) || 1, g = a * Math.exp(-0.5 * (d / w) ** 2);
        tx[j] += uz / mag * g; tz[j] -= ux / mag * g;
        this.project(tx, tz, j);
      }
      const saved = { len: this.len, h: this.h, k: this.k, ks: this.ks, dk: this.dk };
      Object.assign(this, trial);
      this.geometry(tx, tz, this);
      const t = this.speeds(model, { ...o, out: scratch });
      Object.assign(this, saved);
      if (t < best - 1e-7) { best = t; this.px.set(tx); this.pz.set(tz); }
      if (it % 500 === 499) { this.resample(); best = this.speeds(model, o); }
      if (log && it % log === log - 1) console.log(`  it ${it + 1} qss ${best.toFixed(3)}`);
    }
    this.resample(); this.locate();
    return this.speeds(model, o);
  }
  /** Index and interpolation of the closest segment to (x, z) near `hint` (global search when hint < 0). */
  closest(x, z, hint = -1, span = 14) {
    const N = this.N, { px, pz } = this;
    let best = Infinity, bi = 0;
    if (hint < 0) for (let i = 0; i < N; i++) { const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (d < best) { best = d; bi = i; } }
    else for (let d = -6; d <= span; d++) { const i = this.idx(hint + d), dd = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (dd < best) { best = dd; bi = i; } }
    let i = bi, j = this.idx(bi + 1);
    let ux = px[j] - px[i], uz = pz[j] - pz[i], L2 = ux * ux + uz * uz, f = ((x - px[i]) * ux + (z - pz[i]) * uz) / Math.max(1e-9, L2);
    if (f < 0) { j = i; i = this.idx(bi - 1); ux = px[j] - px[i]; uz = pz[j] - pz[i]; L2 = ux * ux + uz * uz; f = ((x - px[i]) * ux + (z - pz[i]) * uz) / Math.max(1e-9, L2); }
    f = clamp(f, 0, 1);
    const L = Math.sqrt(L2) || 1, e = ((x - px[i]) * uz - (z - pz[i]) * ux) / L;   // signed lateral error, + right of the path
    return { i, f, e, d2: best };
  }
  /** Array value at station i + f, advanced by `ahead` metres of path. */
  sample(a, i, f, ahead = 0) {
    let d = f * this.len[i] + ahead;
    while (d >= this.len[i]) { d -= this.len[i]; i = this.idx(i + 1); }
    while (d < 0) { i = this.idx(i - 1); d += this.len[i]; }
    const t = d / Math.max(1e-9, this.len[i]);
    return a[i] * (1 - t) + a[this.idx(i + 1)] * t;
  }
  heading(i, f) { const j = this.idx(i + 1), h0 = this.h[i]; return h0 + angle(this.h[j] - h0) * f; }
  toJSON() { return { ds: this.ds, edge: this.edge, px: Array.from(this.px, (x) => Math.round(x * 100) / 100), pz: Array.from(this.pz, (x) => Math.round(x * 100) / 100) }; }
  load(data) {
    if (data?.px?.length !== this.N) return false;
    this.px.set(data.px); this.pz.set(data.pz); this.geometry(); this.locate();
    if (data.trim?.length === this.N) this.trim.set(data.trim);
    return true;
  }
}
