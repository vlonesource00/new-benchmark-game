/**
 * Racing line as a closed Cartesian polyline of N points. Points are free in
 * the plane and kept inside the corridor the stewards use
 * (|track.nearest().lateral| ≤ halfWidth − margin), so the line can cut
 * straight through centreline kinks where track normals fold over.
 * Curvature is signed three-point (Menger) curvature, positive = right turn.
 */
export class Line {
  constructor(track, { ds = 4, margin = 0.6 } = {}) {
    this.track = track;
    const N = this.N = Math.round(track.length / ds); this.ds = track.length / N;
    this.bound = track.halfWidth - margin;
    this.px = new Float64Array(N); this.pz = new Float64Array(N);
    for (let i = 0; i < N; i++) { const p = track.at(i * this.ds); this.px[i] = p.x; this.pz[i] = p.z; }
    this.len = new Float64Array(N); this.k = new Float64Array(N); this.h = new Float64Array(N);
    this.ks = new Float64Array(N); this.dist = new Float64Array(N); this.st = new Float64Array(N); this.lat = new Float64Array(N);
    this.geometry();
  }
  idx(i) { const N = this.N; return ((i % N) + N) % N; }
  /** Segment lengths, headings, curvature, cumulative distance and track coordinates. */
  geometry(px = this.px, pz = this.pz, full = true) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      const a = this.idx(i - 1), c = this.idx(i + 1);
      const abx = px[i] - px[a], abz = pz[i] - pz[a], bcx = px[c] - px[i], bcz = pz[c] - pz[i];
      const lab = Math.hypot(abx, abz), lbc = Math.hypot(bcx, bcz), lac = Math.hypot(px[c] - px[a], pz[c] - pz[a]);
      this.k[i] = -2 * (abx * bcz - abz * bcx) / Math.max(1e-6, lab * lbc * lac);
      this.len[i] = lbc;
    }
    if (!full) return;
    this.shape();
    for (let i = 0; i < N; i++) { const q = this.track.nearest(px[i], pz[i]); this.st[i] = q.s; this.lat[i] = q.lateral; }
  }
  /** Headings, cumulative distance and smoothed curvature (after geometry(…, false)). */
  shape() {
    const N = this.N, { px, pz } = this;
    let d = 0;
    for (let i = 0; i < N; i++) {
      const a = this.idx(i - 1), c = this.idx(i + 1);
      this.h[i] = Math.atan2(px[c] - px[a], pz[c] - pz[a]);
      this.dist[i] = d; d += this.len[i];
    }
    this.pathLength = d;
    for (let i = 0; i < N; i++) { let t = 0; for (let j = -2; j <= 2; j++) t += this.k[this.idx(i + j)]; this.ks[i] = t / 5; }
  }
  /**
   * A lane: this line moved sideways by `shift[i]` metres (+ right) along its
   * own normals. Shares the station index, so a car can switch between lanes
   * without losing its place. Track coordinates are inherited (st) or shifted (lat).
   */
  lane(shift) {
    const L = Object.create(Line.prototype), N = this.N;
    Object.assign(L, { track: this.track, N, ds: this.ds, bound: this.bound, st: this.st, shift, brakeExp: this.brakeExp, tractionExp: this.tractionExp, trim: this.trim });
    L.px = new Float64Array(N); L.pz = new Float64Array(N); L.lat = new Float64Array(N);
    for (const k of ['len', 'k', 'h', 'ks', 'dist']) L[k] = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const h = this.h[i];
      L.px[i] = this.px[i] + Math.cos(h) * shift[i]; L.pz[i] = this.pz[i] - Math.sin(h) * shift[i];
      L.lat[i] = this.lat[i] + shift[i];
    }
    L.geometry(L.px, L.pz, false);
    // The shift adds curvature that the three-point stencil reads with station-scale noise
    // (clamps, ramps meeting holds): a spike there is a braking point the car never feels.
    // The added curvature is smoothed; with no shift the lane is the line exactly.
    const dk = new Float64Array(N);
    for (let i = 0; i < N; i++) dk[i] = L.k[i] - this.k[i];
    for (let pass = 0; pass < 2; pass++) { const b = dk.slice(); for (let i = 0; i < N; i++) { let t = 0; for (let q = -2; q <= 2; q++) t += (3 - Math.abs(q)) * b[this.idx(i + q)]; dk[i] = t / 9; } }
    for (let i = 0; i < N; i++) L.k[i] = this.k[i] + dk[i];
    L.shape();
    return L;
  }
  /** Moves (x, z) back inside the corridor if needed. */
  project(px, pz, i) {
    const q = this.track.nearest(px[i], pz[i]), B = this.bound;
    if (Math.abs(q.lateral) > B) { const o = Math.sign(q.lateral) * B; px[i] = q.x + q.nx * o; pz[i] = q.z + q.nz * o; }
  }
  /** Even arc-length spacing (keeps the stencils well conditioned). */
  resample() {
    const N = this.N, { px, pz } = this; this.geometry(px, pz, false);
    const cum = new Float64Array(N + 1); for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + this.len[i];
    const L = cum[N], nx = new Float64Array(N), nz = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const d = i * L / N; while (cum[j + 1] < d) j++;
      const t = (d - cum[j]) / Math.max(1e-9, this.len[j]), b = this.idx(j + 1);
      nx[i] = px[j] + (px[b] - px[j]) * t; nz[i] = pz[j] + (pz[b] - pz[j]) * t;
    }
    px.set(nx); pz.set(nz);
  }
  /** Minimum-curvature line: elastic band on the second difference, normal moves only, projected. */
  minCurvature(sweeps = 1500, omega = 1.5) {
    const N = this.N, { px, pz } = this;
    for (let s = 0; s < sweeps; s++) {
      for (let i = 0; i < N; i++) {
        const m2 = this.idx(i - 2), m1 = this.idx(i - 1), p1 = this.idx(i + 1), p2 = this.idx(i + 2);
        const tx = (4 * (px[m1] + px[p1]) - px[m2] - px[p2]) / 6, tz = (4 * (pz[m1] + pz[p1]) - pz[m2] - pz[p2]) / 6;
        let ux = px[p1] - px[m1], uz = pz[p1] - pz[m1]; const m = Math.hypot(ux, uz) || 1; ux /= m; uz /= m;
        const d = ((tx - px[i]) * uz - (tz - pz[i]) * ux) * omega;   // along the right normal (uz, -ux)
        px[i] += uz * d; pz[i] -= ux * d;
        this.project(px, pz, i);
      }
      if (s % 50 === 49) this.resample();
    }
    this.resample(); this.geometry();
  }
  /**
   * Quasi-steady-state speed profile on this line for `model`, with corner
   * usage `lambda` (1 = the identified limit). Returns lap time; speeds in `v`.
   */
  speeds(model, lambda = 1, out = null) {
    const N = this.N, k = this.k, len = this.len;
    const vmax = this.vmax ??= new Float64Array(N), v = out ?? (this.v ??= new Float64Array(N));
    // Corner usage per station: λ times the learnt trim (1 where nothing was learnt).
    const trim = this.trim, lam = (i) => (trim ? lambda * trim[i] : lambda);
    for (let i = 0; i < N; i++) {
      const ak = Math.abs(k[i]); let s = 90;
      if (ak > 1e-5) for (let it = 0; it < 6; it++) s = Math.min(90, Math.sqrt(model.lat(s) * lam(i) / ak));
      vmax[i] = s;
    }
    // Measured on the game tyre: braking and cornering trade almost linearly
    // (a g-g diamond), because ABS-level rear slip leaves no lateral force.
    const pb = this.brakeExp ?? 1;
    const use = (i, s) => { const r = Math.min(1, s * s * Math.abs(k[i]) / (model.lat(s) * lam(i))); return pb === 1 ? 1 - r : (1 - r ** pb) ** (1 / pb); };
    // Traction is a rear-axle job and trades with cornering like a friction ellipse.
    const ell = (i, s) => { const r = Math.min(1, s * s * Math.abs(k[i]) / (model.lat(s) * lam(i))); return Math.sqrt(1 - r ** (this.tractionExp ?? 2)); };
    let start = 0; for (let i = 1; i < N; i++) if (vmax[i] < vmax[start]) start = i;
    v.set(vmax);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < N; j++) {
        const i = this.idx(start + j), nx = this.idx(i + 1), s = v[i];
        v[nx] = Math.min(v[nx], Math.sqrt(s * s + 2 * len[i] * model.drive(s) * ell(i, s)));
      }
      for (let j = 0; j < N; j++) {
        const i = this.idx(start - j), pv = this.idx(i - 1), s = v[i];
        v[pv] = Math.min(v[pv], Math.sqrt(s * s + 2 * len[pv] * model.brake(s) * use(i, s)));
      }
    }
    let t = 0; for (let i = 0; i < N; i++) t += len[i] / Math.max(1, 0.5 * (v[i] + v[this.idx(i + 1)]));
    return t;
  }
  /** Minimum-time refinement: smooth bumps along the path normal, kept when the lap gets faster. */
  minTime(model, lambda, iterations = 4000, seed = 1) {
    let h = seed >>> 0; const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return h / 4294967296; };
    const N = this.N, tx = new Float64Array(N), tz = new Float64Array(N), scratch = new Float64Array(N);
    let best = this.speeds(model, lambda);
    for (let it = 0; it < iterations; it++) {
      tx.set(this.px); tz.set(this.pz);
      const c = Math.floor(rnd() * N), w = 2 + rnd() * 20, a = (rnd() - 0.5) * 2 * (0.1 + rnd() * 0.8);
      for (let d = -Math.ceil(2.5 * w); d <= 2.5 * w; d++) {
        const j = this.idx(c + d), m = this.idx(j - 1), p = this.idx(j + 1);
        let ux = this.px[p] - this.px[m], uz = this.pz[p] - this.pz[m]; const mag = Math.hypot(ux, uz) || 1;
        const g = a * Math.exp(-0.5 * (d / w) ** 2);
        tx[j] += uz / mag * g; tz[j] -= ux / mag * g;
        this.project(tx, tz, j);
      }
      this.geometry(tx, tz, false);
      const t = this.speeds(model, lambda, scratch);
      if (t < best) { best = t; this.px.set(tx); this.pz.set(tz); }
      if (it % 500 === 499) { this.resample(); this.geometry(this.px, this.pz, false); best = this.speeds(model, lambda); }
    }
    this.geometry(this.px, this.pz, false); this.geometry(); this.speeds(model, lambda);
    return this.speeds(model, lambda);
  }
  /**
   * Closest point on the line to (x, z), searched near `hint` (or globally when
   * hint < 0). Returns segment index, fraction, signed lateral error (+ right).
   */
  closest(x, z, hint = -1, span = 12) {
    const N = this.N, { px, pz } = this;
    let best = Infinity, bi = 0;
    const scan = (i) => { const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (d < best) { best = d; bi = i; } };
    if (hint < 0) for (let i = 0; i < N; i++) scan(i); else for (let d = -6; d <= span; d++) scan(this.idx(hint + d));
    // Choose the segment (bi-1→bi or bi→bi+1) the point projects onto.
    let i = bi, j = this.idx(bi + 1);
    let ux = px[j] - px[i], uz = pz[j] - pz[i], L2 = ux * ux + uz * uz;
    let f = ((x - px[i]) * ux + (z - pz[i]) * uz) / Math.max(1e-9, L2);
    if (f < 0) { j = i; i = this.idx(bi - 1); ux = px[j] - px[i]; uz = pz[j] - pz[i]; L2 = ux * ux + uz * uz; f = ((x - px[i]) * ux + (z - pz[i]) * uz) / Math.max(1e-9, L2); }
    f = Math.max(0, Math.min(1, f));
    const L = Math.sqrt(L2) || 1, e = ((x - px[i]) * uz - (z - pz[i]) * ux) / L;
    return { i, f, e, d2: best };
  }
  /** Interpolated value of array `a` at (i, f) advanced by `ahead` metres of path. */
  sample(a, i, f, ahead = 0) {
    let d = f * this.len[i] + ahead;
    while (d >= this.len[i]) { d -= this.len[i]; i = this.idx(i + 1); }
    while (d < 0) { i = this.idx(i - 1); d += this.len[i]; }
    const t = d / Math.max(1e-9, this.len[i]);
    return a[i] * (1 - t) + a[this.idx(i + 1)] * t;
  }
  heading(i, f) { const j = this.idx(i + 1), h0 = this.h[i]; return h0 + Math.atan2(Math.sin(this.h[j] - h0), Math.cos(this.h[j] - h0)) * f; }
  toJSON() { return { ds: this.ds, px: Array.from(this.px, (x) => Math.round(x * 100) / 100), pz: Array.from(this.pz, (x) => Math.round(x * 100) / 100) }; }
}
