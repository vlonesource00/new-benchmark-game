// ORACLE's racing line: lateral offsets on a smoothed reference path, a speed profile from the
// measured car envelope, and the minimum-time search that shapes the offsets.
//
// The profile is a friction-ellipse point-mass solution: the cornering limit at each point comes from the
// measured lateral table, the forward pass spends what is left of the ellipse on the measured drive
// acceleration and the backward pass on the measured braking. `grip[i]` is the per-point correction that
// laps on the real physics learn (1 = the pad's envelope holds there).
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { at, VMAX } from './envelope.js';

const DS = 2.5;

export class Line {
  constructor(track, spec, env, data = null, options = {}) {
    this.track = track; this.spec = spec; this.env = env; this.options = options;
    // The pad's steady-state reading sits below what a driven car reaches on the racing line; laps learn the rest.
    this.latScale = options.latScale ?? data?.latScale ?? 1;
    const n = this.n = Math.round(track.length / DS); this.ds = track.length / n;
    this.cx = new Float64Array(n); this.cz = new Float64Array(n); this.nx = new Float64Array(n); this.nz = new Float64Array(n);
    this.lo = new Float64Array(n); this.hi = new Float64Array(n);
    this.reference(data?.lo?.length === n);
    this.w = new Float64Array(n); this.x = new Float64Array(n); this.z = new Float64Array(n);
    this.k = new Float64Array(n); this.v = new Float64Array(n); this.vlim = new Float64Array(n);
    this.grip = new Float64Array(n).fill(1); this.brakeGain = 1;
    this.speedOfK = kTable(env, this.latScale);
    if (data?.w?.length === n) { this.w.set(data.w); if (data.lo?.length === n) { this.lo.set(data.lo); this.hi.set(data.hi); } if (data.grip?.length === n && !options.flatGrip) this.grip.set(data.grip); this.brakeGain = data.brakeGain ?? 1; }
    // A line saved after refinement (fine) is loaded as it is: refining or smoothing it again would move a baked line.
    if (options.fineBounds !== false && !data?.fine) this.refineBounds();
    if (!(data?.w?.length === n) && !options.noSeed) { this.globalSeed(); this.minCurvature(options.polish ?? 0); }
    this.build();
  }
  /**
   * Reference frame: the centreline with its spline kinks smoothed out (~10 m Gaussian; the small inward shift
   * does not matter because the bounds are measured on the real road), and at every point the stretch of its normal that is usable tarmac: the car centre may go wherever
   * the road's own lateral stays inside the tarmac less half a car and a small margin, so the wheels stay off
   * the kerbs. Offsets are measured on this frame.
   */
  reference(skipBounds = false) {
    const n = this.n, track = this.track, x = new Float64Array(n), z = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = track.at(i * this.ds); x[i] = p.x; z[i] = p.z; }
    for (let pass = 0; pass < (this.options.refPasses ?? 40); pass++) for (const lambda of [0.5]) {
      const px = x.slice(), pz = z.slice();
      for (let i = 0; i < n; i++) { const a = wrap(i - 1, n), b = (i + 1) % n; x[i] = px[i] + lambda * ((px[a] + px[b]) / 2 - px[i]); z[i] = pz[i] + lambda * ((pz[a] + pz[b]) / 2 - pz[i]); }
    }
    const limit = this.limit = track.halfWidth - (this.options.edge ?? 0.2), reach = track.halfWidth + 6;
    const ok = (px, pz) => Math.abs(track.nearest(px, pz).lateral) <= limit;
    for (let i = 0; i < n; i++) {
      const a = wrap(i - 2, n), b = (i + 2) % n, tx = x[b] - x[a], tz = z[b] - z[a], len = Math.hypot(tx, tz);
      this.cx[i] = x[i]; this.cz[i] = z[i]; this.nx[i] = tz / len; this.nz[i] = -tx / len;
      if (skipBounds) continue;
      // The feasible stretch nearest the reference point (it can sit just off the tarmac inside a kink).
      let start = 0;
      for (let d = 0; d <= reach && !ok(x[i] + this.nx[i] * start, z[i] + this.nz[i] * start); d += 0.25) start = ok(x[i] + this.nx[i] * d, z[i] + this.nz[i] * d) ? d : ok(x[i] - this.nx[i] * d, z[i] - this.nz[i] * d) ? -d : 0;
      let lo = start, hi = start;
      while (lo - 0.25 > -reach && ok(x[i] + this.nx[i] * (lo - 0.25), z[i] + this.nz[i] * (lo - 0.25))) lo -= 0.25;
      while (hi + 0.25 < reach && ok(x[i] + this.nx[i] * (hi + 0.25), z[i] + this.nz[i] * (hi + 0.25))) hi += 0.25;
      this.lo[i] = lo; this.hi[i] = hi;
    }
  }
  /**
   * The bounds are found on a 0.25 m grid; a line run along the road's edge on that staircase carries a curvature
   * spike at every step (±40/km on a 2.5 m station), and the profile brakes for kinks the car never drives. Each
   * bound is bisected to a centimetre, so the edge is the smooth curve the road really has, and an offset that sat on
   * the old staircase is moved onto it.
   */
  refineBounds() {
    const track = this.track, limit = this.limit ?? track.halfWidth - (this.options.edge ?? 0.2);
    const ok = (i, d) => Math.abs(track.nearest(this.cx[i] + this.nx[i] * d, this.cz[i] + this.nz[i] * d).lateral) <= limit;
    for (let i = 0; i < this.n; i++) {
      const lo0 = this.lo[i], hi0 = this.hi[i];
      let a = lo0, b = lo0 - 0.25; for (let k = 0; k < 5; k++) { const m = (a + b) / 2; if (ok(i, m)) a = m; else b = m; }
      let c = hi0, d = hi0 + 0.25; for (let k = 0; k < 5; k++) { const m = (c + d) / 2; if (ok(i, m)) c = m; else d = m; }
      this.lo[i] = a; this.hi[i] = c;
      if (this.w[i] <= lo0 + 0.01) this.w[i] = a; else if (this.w[i] >= hi0 - 0.01) this.w[i] = c;
    }
    // wSmooth: a [1 2 1] pass per count over the offsets, then back inside the bounds: zigzag shorter than a few
    // stations is no path a car follows, only curvature noise in the profile.
    for (let p = 0, n = this.n, w = this.w; p < (this.options.wSmooth ?? 2); p++) { const c = w.slice(); for (let i = 0; i < n; i++) w[i] = clamp((c[wrap(i - 1, n)] + 2 * c[i] + c[(i + 1) % n]) / 4, this.lo[i], this.hi[i]); }
  }
  /**
   * Global seed: dynamic programming over a lattice of lanes every ~10 m, minimising the summed squared
   * curvature (plus a little length) of the whole lap. The state is the pair of lanes at the last two stations,
   * so the curvature at each station is exact on the lattice; the lap is unrolled twice and the middle lap kept,
   * which closes the loop without fixing the start lane.
   */
  globalSeed() {
    const n = this.n, step = Math.max(2, Math.round((this.options.station ?? 10) / this.ds)), S = Math.floor(n / step), K = this.options.lanes ?? 17, T = 2 * S + 2, timeCost = this.options.seedCost === 'time';
    const lane = (j, q) => { const i = (j % S) * step; return this.lo[i] + (this.hi[i] - this.lo[i]) * q / (K - 1); };
    const px = (j, q) => { const i = (j % S) * step; return this.cx[i] + this.nx[i] * lane(j, q); }, pz = (j, q) => { const i = (j % S) * step; return this.cz[i] + this.nz[i] * lane(j, q); };
    let cost = new Float64Array(K * K).fill(0), next = new Float64Array(K * K);
    const from = new Int16Array(T * K * K);
    for (let j = 2; j < T; j++) {
      next.fill(Infinity);
      for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
        const c0 = cost[a * K + b]; if (c0 === Infinity) continue;
        const ax = px(j - 2, a), az = pz(j - 2, a), bx = px(j - 1, b), bz = pz(j - 1, b);
        for (let c = 0; c < K; c++) {
          const cx = px(j, c), cz = pz(j, c), l1 = Math.hypot(bx - ax, bz - az), l2 = Math.hypot(cx - bx, cz - bz), l3 = Math.hypot(cx - ax, cz - az);
          const k = 2 * ((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / Math.max(1e-9, l1 * l2 * l3);
          const total = c0 + (timeCost ? l2 / this.speedAt(Math.abs(k)) : k * k * l2 * 1e4 + l2 * 0.002);
          if (total < next[b * K + c]) { next[b * K + c] = total; from[j * K * K + b * K + c] = a; }
        }
      }
      [cost, next] = [next, cost];
    }
    let best = 0;
    for (let x = 1; x < K * K; x++) if (cost[x] < cost[best]) best = x;
    const lanes = new Int16Array(T); lanes[T - 1] = best % K; lanes[T - 2] = Math.floor(best / K);
    for (let j = T - 1; j >= 2; j--) lanes[j - 2] = from[j * K * K + lanes[j - 1] * K + lanes[j]];
    // Middle lap, stations S/2 .. S/2 + S, spread to every grid point by linear interpolation.
    const h = Math.floor(S / 2);
    for (let j = h; j < h + S; j++) {
      const i0 = (j % S) * step, w0 = lane(j, lanes[j]), w1 = lane(j + 1, lanes[j + 1]), span = (j + 1) % S === 0 ? n - i0 : step;
      for (let d = 0; d < span; d++) { const i = (i0 + d) % n; this.w[i] = clamp(w0 + (w1 - w0) * d / span, this.lo[i], this.hi[i]); }
    }
  }
  /**
   * Minimum-curvature seed: each point moves (along its normal, inside the tarmac) to where the fourth
   * difference of the path vanishes, coarse stencils first. Unlike plain midpoint smoothing this does not pull
   * the closed lap onto the inside kerb.
   */
  minCurvature(passes = 150) {
    const n = this.n, w = this.w;
    for (const m of [24, 12, 6, 3]) for (let pass = 0; pass < passes; pass++) {
      this.geometry(0, n);
      for (let i = 0; i < n; i++) {
        const a2 = wrap(i - 2 * m, n), a = wrap(i - m, n), b = (i + m) % n, b2 = (i + 2 * m) % n;
        const tx = (-this.x[a2] + 4 * this.x[a] + 4 * this.x[b] - this.x[b2]) / 6, tz = (-this.z[a2] + 4 * this.z[a] + 4 * this.z[b] - this.z[b2]) / 6;
        const target = (tx - this.cx[i]) * this.nx[i] + (tz - this.cz[i]) * this.nz[i];
        w[i] = clamp(w[i] + (target - w[i]) * 0.4, this.lo[i], this.hi[i]);
      }
    }
  }
  /** Positions, curvature, speed profile and lap time from the current offsets. */
  build() { this.geometry(0, this.n); this.profile(); return this.time; }
  geometry(from, to) {
    const n = this.n;
    for (let j = from; j < to; j++) { const i = wrap(j, n); this.x[i] = this.cx[i] + this.nx[i] * this.w[i]; this.z[i] = this.cz[i] + this.nz[i] * this.w[i]; }
    for (let j = from - 2; j < to + 2; j++) { const i = wrap(j, n); this.k[i] = menger(this, wrap(i - 2, n), i, (i + 2) % n); }
    for (let j = from - 5; j < to + 5; j++) { const i = wrap(j, n); this.vlim[i] = this.cornerSpeed(i); }
  }
  /**
   * Steady cornering limit, and a transient one: the lateral force cannot swing faster than the tyres and the
   * yaw inertia let it, and the rate of swing on a path is v³·dκ/ds. A flick in the line costs speed here.
   */
  cornerSpeed(i) {
    const n = this.n, dk = Math.abs(this.k[(i + 3) % n] - this.k[wrap(i - 3, n)]) / (6 * this.ds);
    return Math.min(this.speedAt(Math.abs(this.k[i]) / this.grip[i]), Math.cbrt((this.options.jerk ?? Infinity) * this.grip[i] / Math.max(1e-9, dk)));
  }
  speedAt(k) {
    const t = this.speedOfK;
    if (k <= t.k[0]) return t.v[0];
    const x = Math.log(k / t.k[0]) / t.step, j = Math.min(t.v.length - 2, Math.floor(x)), f = Math.min(1, x - j);
    return t.v[j] * (1 - f) + t.v[j + 1] * f;
  }
  /** Ellipse-limited forward/backward passes around the closed lap; two laps settle the wrap-around. */
  profile() {
    const n = this.n, v = this.v, env = this.env, ds = this.ds;
    v.set(this.vlim);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 1; j <= n; j++) {
        const i = j % n, p = j - 1, vp = v[p], use = ellipse(this, p, vp);
        v[i] = Math.min(v[i], Math.sqrt(vp * vp + 2 * ds * at(env.accel, vp) * use));
      }
      for (let j = n - 1; j >= 0; j--) {
        const nx = (j + 1) % n, vn = v[nx], use = ellipse(this, nx, vn);
        v[j] = Math.min(v[j], Math.sqrt(vn * vn + 2 * ds * at(env.brake, vn) * this.brakeGain * this.grip[nx] * use));
      }
    }
    // The driver's target: corner limits and braking only. Drive is the engine's business; a car that gains more
    // than the model (light tank, a tow) must not lift to wait for the forward pass.
    const vb = this.vb ??= new Float64Array(n);
    vb.set(this.vlim);
    for (let pass = 0; pass < 2; pass++) for (let j = n - 1; j >= 0; j--) {
      const nx = (j + 1) % n, vn = vb[nx], use = ellipse(this, nx, vn);
      vb[j] = Math.min(vb[j], Math.sqrt(vn * vn + 2 * ds * at(env.brake, vn) * this.brakeGain * this.grip[nx] * use));
    }
    let t = 0;
    for (let i = 0; i < n; i++) { const d = Math.hypot(this.x[(i + 1) % n] - this.x[i], this.z[(i + 1) % n] - this.z[i]); t += 2 * d / (v[i] + v[(i + 1) % n]); }
    this.time = t;
  }
  /**
   * Minimum-time search: Gaussian bumps of the offsets, kept when the lap gets quicker. The search anneals from
   * corner-complex bumps (60 m, metres of shift) down to apex trims (8 m, decimetres). Each trial is scored on a
   * local window that reaches back over the longest braking zone and forward over the run to the next one, with
   * the current profile as the boundary; the whole lap is rebuilt at the end.
   */
  optimise(iterations, seed = 1, region = null) {
    const n = this.n, rand = rng(seed), save = new Float64Array(n), back = Math.ceil(260 / this.ds), fwd = Math.ceil(420 / this.ds), wide = Math.ceil(130 * 2.5) + 100;
    const buf = new Float64Array(back + fwd + 2 * wide + 8), lim = buf;
    this.build();
    let kept = 0;
    for (let it = 0; it < iterations; it++) {
      const heat = region ? region.heat * (1 - it / iterations) : 1 - it / iterations, c = region ? wrap(region.from + Math.floor(rand() * region.len), n) : Math.floor(rand() * n);
      // Scales are drawn log-uniform from an apex trim (5 m) up to a whole corner complex (~250 m at full heat).
      // Two kinds of move. A bump: a Gaussian shift, scales drawn log-uniform from an apex trim (5 m) up to a whole
      // corner complex (~250 m at full heat). A crossing (while hot): a stretch of up to ~400 m moved bodily to
      // another lane of the road with smooth ramps, so the search can leave one side of a complex for the other.
      const cross = !region && rand() < (this.options.crossRate ?? 0) * heat;
      const sigma = Math.max(this.options.minSigma ?? 2, 2 * Math.exp(rand() * Math.log(4 + 46 * heat * heat))), amp = (rand() * 2 - 1) * (0.1 + rand() * (0.4 + 3 * heat * heat));
      const core = cross ? Math.floor(10 + rand() * 70) : 0, ramp = cross ? Math.floor(12 + rand() * 40) : 0, q = rand();
      const span = cross ? core + ramp : Math.ceil(sigma * 2.5), a = c - span - back, b = c + span + fwd;
      const before = this.windowTime(a, b, buf, lim, false);
      for (let d = -span; d <= span; d++) {
        const i = wrap(c + d, n); save[i] = this.w[i];
        if (cross) { const x = Math.abs(d) <= core ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (Math.abs(d) - core) / ramp), goal = this.lo[i] + 0.4 + (this.hi[i] - this.lo[i] - 0.8) * q; this.w[i] = clamp(this.w[i] + (goal - this.w[i]) * x, this.lo[i], this.hi[i]); }
        else this.w[i] = clamp(this.w[i] + amp * Math.exp(-0.5 * (d / sigma) ** 2), this.lo[i], this.hi[i]);
      }
      this.geometry(c - span, c + span + 1);
      const after = this.windowTime(a, b, buf, lim, true);
      if (after < before - 1e-7) { kept++; for (let j = a; j <= b; j++) this.v[wrap(j, n)] = buf[j - a]; }
      else { for (let d = -span; d <= span; d++) { const i = wrap(c + d, n); this.w[i] = save[i]; } this.geometry(c - span, c + span + 1); }
    }
    return { time: region ? this.time : this.build(), kept };
  }
  /**
   * Basin hopping: a stretch of the lap (100–450 m) is moved bodily to another lane of the road, the corners in
   * and around it are re-polished, and the whole lap decides: kept when quicker, otherwise put back. A greedy
   * search cannot make this jump, because the half-way states are all slower than either basin.
   */
  hop(hops, polish = 1500, seed = 7) {
    const rand = rng(seed), save = new Float64Array(this.n);
    let base = this.build(), kept = 0;
    for (let h = 0; h < hops; h++) {
      save.set(this.w);
      this.perturb(rand, polish, seed * 1000 + h);
      const t = this.build();
      if (t < base - 1e-4) { base = t; kept++; } else { this.w.set(save); this.build(); }
    }
    return { time: this.build(), kept };
  }
  /** One basin-hopping proposal: a stretch to one lane, mirrored across the road, or shifted; then re-polished. */
  perturb(rand, polish = 1500, seed = 1, at = null) {
    const n = this.n, c = at ?? Math.floor(rand() * n), core = Math.floor(15 + rand() * 75), ramp = Math.floor(10 + rand() * 30), q = rand(), kind = Math.floor(rand() * 3), shift = (rand() < 0.5 ? -1 : 1) * (2 + rand() * 7);
    for (let d = -core - ramp; d <= core + ramp; d++) {
      const i = wrap(c + d, n), x = Math.abs(d) <= core ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (Math.abs(d) - core) / ramp);
      const goal = kind === 0 ? this.lo[i] + 0.4 + (this.hi[i] - this.lo[i] - 0.8) * q : kind === 1 ? this.lo[i] + this.hi[i] - this.w[i] : this.w[i] + shift;
      this.w[i] = clamp(this.w[i] + (goal - this.w[i]) * x, this.lo[i], this.hi[i]);
    }
    this.build();
    const reach = core + ramp + 60;
    this.optimise(polish, seed, { from: c - reach, len: 2 * reach, heat: 0.6 });
    return { c, core, ramp, kind };
  }
  /**
   * Global search: several different starting lines (minimum curvature over the lane lattice at a few station
   * spacings, the plain minimum-curvature polish of the road's middle, the time-costed lattice), each annealed on a
   * share of the budget; the quickest carries on with the rest. Different starts land in different basins of a
   * corner complex, and the lap clock picks between them.
   */
  solve(iterations, seed = 1) {
    const starts = [{ station: 10, seedCost: 'curvature' }, { station: 16, seedCost: 'curvature', lanes: 13 }, { station: 7, seedCost: 'curvature', lanes: 21 }, { seedCost: 'time' }, { middle: true }];
    const share = Math.floor(iterations * (this.options.startShare ?? 0.12)), opts = this.options;
    let best = null;
    starts.forEach((st, k) => {
      this.options = { ...opts, ...st };
      if (st.middle) { this.w.fill(0); for (let i = 0; i < this.n; i++) this.w[i] = clamp(0, this.lo[i], this.hi[i]); this.minCurvature(60); } else this.globalSeed();
      const r = this.optimise(share, seed + k);
      if (!best || r.time < best.time) best = { time: r.time, w: Float64Array.from(this.w), k };
    });
    this.options = opts; this.w.set(best.w);
    this.optimise(Math.max(0, iterations - share * starts.length), seed + 99);
    const h = this.hop(this.options.hops ?? 0, this.options.hopPolish ?? 3000, seed + (this.options.hopSeed ?? 7));
    const r = this.optimise(Math.floor(iterations * 0.15), seed + 199);
    return { ...r, start: best.k, hops: h.kept };
  }
  /** Lap time over [a, b] (unwrapped indices). With `fresh`, the speeds are re-solved inside with the ends held. */
  windowTime(a, b, v, lim, fresh) {
    const n = this.n, env = this.env, ds = this.ds, m = b - a;
    for (let j = 0; j <= m; j++) { const i = wrap(a + j, n); v[j] = fresh ? Math.min(this.vlim[i], j === 0 || j === m ? this.v[i] : Infinity) : this.v[i]; }
    if (fresh) {
      for (let j = 1; j <= m; j++) { const p = wrap(a + j - 1, n), vp = v[j - 1]; v[j] = Math.min(v[j], Math.sqrt(vp * vp + 2 * ds * at(env.accel, vp) * ellipse(this, p, vp))); }
      for (let j = m - 1; j >= 0; j--) { const q = wrap(a + j + 1, n), vq = v[j + 1]; v[j] = Math.min(v[j], Math.sqrt(vq * vq + 2 * ds * at(env.brake, vq) * this.brakeGain * this.grip[q] * ellipse(this, q, vq))); }
    }
    let t = 0;
    for (let j = 0; j < m; j++) { const i = wrap(a + j, n), k = wrap(a + j + 1, n); t += 2 * Math.hypot(this.x[k] - this.x[i], this.z[k] - this.z[i]) / (v[j] + v[j + 1]); }
    return t;
  }
  /** Nearest grid point to (x, z), searched forward from a hint; returns index, fraction and signed lateral error. */
  locate(x, z, hint = -1) {
    const n = this.n;
    let best = Infinity, i0 = 0;
    if (hint < 0) { const p = this.track.nearest(x, z); hint = Math.round(p.s / this.ds); for (let d = -40; d <= 40; d++) { const i = wrap(hint + d, n), q = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2; if (q < best) { best = q; i0 = i; } } }
    else for (let d = -8; d <= 24; d++) { const i = wrap(hint + d, n), q = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2; if (q < best) { best = q; i0 = i; } }
    const i1 = (i0 + 1) % n, tx = this.x[i1] - this.x[i0], tz = this.z[i1] - this.z[i0], len = Math.hypot(tx, tz) || 1;
    let f = ((x - this.x[i0]) * tx + (z - this.z[i0]) * tz) / (len * len), i = i0;
    if (f < 0) { i = wrap(i0 - 1, n); f += 1; }
    f = clamp(f, 0, 1);
    // Right of the path is positive, matching the track's lateral convention.
    const e = ((x - this.x[i0]) * tz - (z - this.z[i0]) * tx) / len;
    return { i, f, e, s: (i + f) * this.ds };
  }
  /** Nearest reference-frame station to (x, z), searched near a hint (a full scan without one). */
  locateRef(x, z, hint = -1) {
    const n = this.n; let best = Infinity, i0 = 0;
    const span = hint < 0 ? n : 30, from = hint < 0 ? 0 : hint - 10;
    for (let d = 0; d < span; d++) { const i = wrap(from + d, n), q = (this.cx[i] - x) ** 2 + (this.cz[i] - z) ** 2; if (q < best) { best = q; i0 = i; } }
    return i0;
  }
  /** Linear sample of an array at grid position i + f + d/ds. */
  sample(arr, i, f, d = 0) {
    const u = i + f + d / this.ds, a = Math.floor(u), t = u - a, n = this.n;
    return arr[wrap(a, n)] * (1 - t) + arr[wrap(a + 1, n)] * t;
  }
  point(i, f, d = 0, lateral = 0) {
    const u = i + f + d / this.ds, a = Math.floor(u), t = u - a, n = this.n, ia = wrap(a, n), ib = wrap(a + 1, n);
    const w = this.laneW(ia, ib, t, lateral);
    const cx = this.cx[ia] * (1 - t) + this.cx[ib] * t, cz = this.cz[ia] * (1 - t) + this.cz[ib] * t;
    const nx = this.nx[ia] * (1 - t) + this.nx[ib] * t, nz = this.nz[ia] * (1 - t) + this.nz[ib] * t;
    return { x: cx + nx * w, z: cz + nz * w, w };
  }
  /** Offset from the line that a lane `lateral` really gets at d ahead: the road ends where it ends. */
  offset(i, f, d, lateral) {
    const u = i + f + d / this.ds, a = Math.floor(u), t = u - a, n = this.n, ia = wrap(a, n), ib = wrap(a + 1, n);
    return this.laneW(ia, ib, t, lateral) - (this.w[ia] * (1 - t) + this.w[ib] * t);
  }
  /**
   * Where a lane `lateral` off the line puts the car between stations ia and ib. The line may use the whole road; a
   * lane keeps o.laneEdge of it in hand at each edge (the car runs a metre or two wide of any path it tracks at the
   * limit, and the kerb past the edge has less grip), except where the line itself already goes.
   */
  laneW(ia, ib, t, lateral) {
    const w = this.w[ia] * (1 - t) + this.w[ib] * t, lo = Math.min(this.lo[ia], this.lo[ib]), hi = Math.max(this.hi[ia], this.hi[ib]);
    if (!lateral) return clamp(w, lo, hi);
    const m = this.options.laneEdge ?? 1.8;
    if (this.options.laneSmooth) {
      // A lane runs along the road's edge as a driver does: on the edge smoothed over a few car lengths, so a kink in
      // the kerb line is cut (a wheel over the kerb, never the car off) instead of traced.
      const E = this.laneEdges(), llo = E.lo[ia] * (1 - t) + E.lo[ib] * t, lhi = E.hi[ia] * (1 - t) + E.hi[ib] * t;
      return clamp(w + lateral, Math.min(w, llo + m), Math.max(w, lhi - m));
    }
    return clamp(w + lateral, Math.min(w, lo + m), Math.max(w, hi - m));
  }
  /** The bounds smoothed (Gaussian, laneSmooth metres), never more than laneCut past the real ones. */
  laneEdges() {
    if (this.edges) return this.edges;
    const n = this.n, sig = this.options.laneSmooth / this.ds, R = Math.ceil(sig * 2.5), cut = this.options.laneCut ?? 1;
    const g = []; let gs = 0; for (let j = -R; j <= R; j++) { g.push(Math.exp(-0.5 * (j / sig) ** 2)); gs += g.at(-1); }
    const lo = new Float64Array(n), hi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0, b = 0;
      for (let j = -R; j <= R; j++) { const k = ((i + j) % n + n) % n, q = g[j + R] / gs; a += this.lo[k] * q; b += this.hi[k] * q; }
      lo[i] = Math.max(a, this.lo[i] - cut); hi[i] = Math.min(b, this.hi[i] + cut);
    }
    return (this.edges = { lo, hi });
  }
  /** Cornering limit of a lane `lateral` off the line at d ahead, from the curvature of the lane's own clamped path. */
  laneSpeed(i, f, d, lateral) {
    const a = this.point(i, f, d - 5, lateral), b = this.point(i, f, d, lateral), c = this.point(i, f, d + 5, lateral);
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x), den = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z);
    const k = den > 1e-9 ? Math.abs(2 * cross / den) : 0;
    return this.speedAt(k / this.sample(this.grip, i, f, d));
  }
  /**
   * Speed of a lane `lateral` off the line, as a share of the line's own speed at d ahead: the ratio of the two
   * paths' radii, both measured over the same chord. The line's small shape bumps are in both paths and cancel, so
   * only what the lane really changes (a tighter or wider arc, a clamp at the road's edge) moves the speed.
   */
  laneFactor(i, f, d, lateral, chord = this.options.laneChord ?? 24) {
    if ((this.options.laneModel ?? 'ratio') === 'parallel') {
      // Parallel lane: radius R + y on the outside of the turn, so speed goes with sqrt(1 + k y), on the line's mean
      // curvature over a few metres (its small shape bumps are in every lane alike).
      let k = 0, y = 0;
      for (let j = -2; j <= 2; j++) { k += this.sample(this.k, i, f, d + j * 5); y += this.offset(i, f, d + j * 5, lateral); }
      return Math.sqrt(clamp(1 + (k / 5) * (y / 5), 0.45, this.options.laneUp ?? 1.04));
    }
    const curv = (lat) => {
      const a = this.point(i, f, d - chord, lat), b = this.point(i, f, d, lat), c = this.point(i, f, d + chord, lat);
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x), den = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z);
      return den > 1e-9 ? Math.abs(2 * cross / den) : 0;
    };
    const floor = 1 / 350;
    return clamp(Math.sqrt(Math.max(floor, curv(0)) / Math.max(floor, curv(lateral))), 0.55, this.options.laneUp ?? 1.04);
  }
  data() { return { n: this.n, fine: true, time: +this.time.toFixed(3), latScale: this.latScale, brakeGain: this.brakeGain, lo: Array.from(this.lo, (x) => +x.toFixed(3)), hi: Array.from(this.hi, (x) => +x.toFixed(3)), w: Array.from(this.w, (x) => +x.toFixed(3)), grip: Array.from(this.grip, (x) => +x.toFixed(4)) }; }
}

function menger(L, a, b, c) {
  const ax = L.x[a], az = L.z[a], bx = L.x[b], bz = L.z[b], cx = L.x[c], cz = L.z[c];
  const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d = Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(cx - ax, cz - az);
  return d > 1e-9 ? 2 * cross / d : 0;
}

/** Share of the tyre left for the long direction after the corner at speed v takes its lateral share. */
function ellipse(L, i, v) {
  const lat = at(L.env.lat, v) * L.latScale * L.grip[i], used = Math.min(1, v * v * Math.abs(L.k[i]) / Math.max(1e-6, lat)), p = L.options.combExp ?? 2;
  return Math.max(L.options.ellFloor ?? 0.2, (1 - used ** p) ** (1 / p));
}

/** Highest speed at which v²·k fits under lat(v), tabulated on a log grid of curvature. */
function kTable(env, scale) {
  const k0 = 2e-5, step = 0.02, count = Math.ceil(Math.log(0.2 / k0) / step) + 1, v = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const k = k0 * Math.exp(j * step);
    let lo = 4, hi = Math.min(VMAX, env.top + 1);
    if (hi * hi * k <= at(env.lat, hi) * scale) { v[j] = hi; continue; }
    for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (mid * mid * k <= at(env.lat, mid) * scale) lo = mid; else hi = mid; }
    v[j] = lo;
  }
  return { k0, step, k: [k0], v };
}

export function rng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
