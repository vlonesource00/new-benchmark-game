import { clamp, angle } from './math.js';

/**
 * A closed racing line on fixed stations along the track. Station i sits at track distance i·ds, and the
 * line passes through it at lateral offset q[i] from the centreline (+ right). The path is the polyline of
 * those points, so geometry (headings, signed curvature, arc length) comes from the points themselves
 * and a bump in q is a bump in the path.
 */
const LANE_KEYS = ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'vmax', 'v', 'vbrk'];

export class Line {
  constructor(track, { ds = 3, edge = -0.5 } = {}) {
    this.track = track;
    const N = this.N = Math.max(64, Math.round(track.length / ds)); this.ds = track.length / N;
    this.edge = edge; this.bound = track.halfWidth + edge;
    this.px = new Float64Array(N); this.pz = new Float64Array(N); this.len = new Float64Array(N);
    this.h = new Float64Array(N); this.k = new Float64Array(N); this.ks = new Float64Array(N); this.dk = new Float64Array(N);
    this.st = new Float64Array(N); this.lat = new Float64Array(N);
    for (let i = 0; i < N; i++) { const p = track.at(i * this.ds); this.px[i] = p.x; this.pz[i] = p.z; }
    this.trim = new Float64Array(N).fill(1); this.btrim = new Float64Array(N).fill(1);
    this.vmax = new Float64Array(N); this.v = new Float64Array(N); this.vbrk = new Float64Array(N);
    this.cap = new Float64Array(N).fill(Infinity); this.gearSeen = new Uint8Array(N); this.vfree = new Float64Array(N); this.kept = []; this.notches = 0;
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
    const N = this.N, ks = this.ks, len = this.len, vmax = this.vmax, v = o.out ?? this.v, trim = this.trim, btrim = this.btrim, dk = this.dk, J = o.jerk ?? model.jerk;
    const pb = o.brakeExp ?? 2, pd = o.driveExp ?? 2, top = o.top ?? 95, m0 = model.margin;
    const lat = (s, i) => { model.margin = m0 * trim[i]; const a = model.lat(s); model.margin = m0; return a; };
    for (let i = 0; i < N; i++) {
      const ak = Math.abs(ks[i]); let s = top;
      if (ak > 1e-6) { s = Math.min(top, Math.sqrt(lat(40, i) / ak)); for (let it = 0; it < 5; it++) s = Math.min(top, Math.sqrt(lat(s, i) / ak)); }
      if (J > 0 && dk[i] > 1e-7) s = Math.min(s, Math.cbrt(J / dk[i]));
      vmax[i] = s;
    }
    const util = (i, s) => Math.min(1, s * s * Math.abs(ks[i]) / lat(s, i));
    const gearOn = model.gearAware && o.gears !== false, useNotch = gearOn && !o.out && o.notch !== false;
    // gearbox notches decided at the last rebuild stay in force; they are re-decided below on this rebuild's profile
    if (useNotch) { this.vfree.set(vmax); this.applyNotches(); }
    const run = () => {
      let start = 0; for (let i = 1; i < N; i++) if (vmax[i] < vmax[start]) start = i;
      v.set(vmax);
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < N; j++) {
          const i = (start + j) % N, nx = i + 1 === N ? 0 : i + 1, s = v[i], r = util(i, s);
          const a = model.drive(s, o.mass) * Math.pow(1 - Math.pow(r, pd), 1 / pd);
          const t = Math.sqrt(s * s + 2 * len[i] * Math.max(0, a));
          if (t < v[nx]) v[nx] = t;
        }
        for (let j = 0; j < N; j++) {
          const i = ((start - j) % N + N) % N, pv = i === 0 ? N - 1 : i - 1, s = v[i], r = util(i, s);
          model.margin = m0 * btrim[i]; const b = model.brake(s) * Math.pow(1 - Math.pow(r, pb), 1 / pb); model.margin = m0;
          const t = Math.sqrt(s * s + 2 * len[pv] * Math.max(0.5, b));
          if (t < v[pv]) v[pv] = t;
        }
      }
      // braking envelope alone (no forward acceleration limit): what a car with more thrust than the table may still carry
      const vb = this.vbrk; vb.set(vmax);
      for (let pass = 0; pass < 2; pass++) for (let j = 0; j < N; j++) {
        const i = ((start - j) % N + N) % N, pv = i === 0 ? N - 1 : i - 1, sp = vb[i], r = util(i, sp);
        model.margin = m0 * btrim[i]; const b = model.brake(sp) * Math.pow(1 - Math.pow(r, pb), 1 / pb); model.margin = m0;
        const t = Math.sqrt(sp * sp + 2 * len[pv] * Math.max(0.5, b));
        if (t < vb[pv]) vb[pv] = t;
      }
    };
    run();
    // The profile is an upper bound for the tracker (the acceleration table is the best gear), never a limit the car cannot meet.
    // The automatic box only drops a gear below 3450 rpm: a corner taken just above that speed leaves the car a gear too tall for the whole exit.
    if (useNotch && this.gearNotches(model, o, util)) { this.applyNotches(); run(); }
    let T = 0; for (let i = 0; i < N; i++) T += len[i] / Math.max(1, 0.5 * (v[i] + v[i + 1 === N ? 0 : i + 1]));
    return T;
  }
  /**
   * Gearbox notches. The host's automatic box drops a gear only below 3450 rpm, so a corner taken a little above that speed
   * is left in a gear too tall for the whole exit (a 25 % thrust loss in the cases measured). Where lowering the apex speed to
   * just under the threshold buys more on the exit run than it costs in the corner, cap the apex there. Returns whether any cap was set.
   */
  applyNotches() {
    const cap = this.cap, vmax = this.vmax; cap.fill(Infinity);
    for (const n of this.kept) for (let c = -n.k; c <= n.k; c++) { const i = this.idx(n.p + c); cap[i] = n.vc; if (vmax[i] > n.vc) vmax[i] = n.vc; }
  }
  /** Corner apexes of a speed array: minima over +-6 stations that sit at least `prom` m/s under the fastest speed within `reach` stations on both sides. */
  apexes(arr, prom = 4, reach = 130) {
    const N = this.N, out = [];
    for (let i = 0; i < N; i++) {
      const x = arr[i]; let low = true;
      for (let d = -6; d <= 6; d++) if (arr[this.idx(i + d)] < x - 1e-9) { low = false; break; }
      if (!low) continue;
      let l = x, r = x; for (let d = 1; d <= reach; d++) { l = Math.max(l, arr[this.idx(i - d)]); r = Math.max(r, arr[this.idx(i + d)]); }
      if (Math.min(l, r) - x >= prom && (!out.length || i - out[out.length - 1] > 6)) out.push(i);
    }
    return out;
  }
  gearNotches(model, o, util) {
    const N = this.N, v = this.v, vfree = this.vfree, vbrk = this.vbrk, len = this.len;
    const band = o.notchBand ?? 3, margin = o.notchMargin ?? 0.6, minGain = o.notchGain ?? 0.15, costK = o.notchCost ?? 2, k = o.notchHalf ?? 5, mass = o.mass ?? 1100, pd = o.driveExp ?? 2;
    const prev = this.kept, next = [];
    const apex = this.apexes(v, o.notchProm ?? 4);
    for (let zi = 0; zi < apex.length; zi++) {
      const p = apex[zi], va = vfree[p], ga = model.gearAt(va);
      if (ga <= 1) continue;
      // The profile says the car leaves this corner in ga; only a car seen there in ga (not already a gear lower because it is slower than the profile) gains from a notch.
      if (o.notchSeen !== false && !prev.some((q) => Math.abs(q.p - p) <= 6)) {
        let seen = 0; for (let d = -6; d <= 6; d++) { const g = this.gearSeen[this.idx(p + d)]; if (g && (!seen || g < seen)) seen = g; }
        if (!seen || seen < ga) continue;
      }
      const vd = model.vDown(ga);
      if (va - vd > band || va < vd) continue;
      const vc = vd - margin;
      // the exit run ends at the speed maximum before the next apex
      let e = p, top = v[p]; const span = ((apex[(zi + 1) % apex.length] - p + N) % N) || N;
      for (let d = 1; d <= span; d++) { const x = v[this.idx(p + d)]; if (x >= top) { top = x; e = p + d; } }
      if (e - p < 4) continue;
      // Time over the exit run with the real gearbox: the car as it will be (stuck in ga) against the car that dropped a gear.
      const exitTime = (v0, g0) => {
        let vb = v0, g = g0, T = 0;
        for (let i = p; i < e; i++) {
          const ii = this.idx(i), nx = this.idx(i + 1);
          g = model.gearAt(vb, g);
          const a = model.driveG(vb, g, mass) * Math.pow(1 - Math.pow(util(ii, vb), pd), 1 / pd);
          const t = Math.min(Math.sqrt(vb * vb + 2 * len[ii] * Math.max(0, a)), vfree[nx], vbrk[nx]);
          T += len[ii] / Math.max(1, 0.5 * (vb + t)); vb = t;
        }
        return T;
      };
      const TA = exitTime(va, ga), TB = exitTime(vc, model.gearAt(vc, ga));
      const cost = costK * (2 * k + 3) * this.ds * (1 / vc - 1 / va);
      if (o.notchLog) o.notchLog.push({ s: Math.round(p * this.ds), va: +va.toFixed(1), ga, vc: +vc.toFixed(1), run: Math.round((e - p) * this.ds), TA: +TA.toFixed(3), TB: +TB.toFixed(3), cost: +cost.toFixed(3) });
      if (TA - TB - cost <= minGain) continue;
      next.push({ p, vc, k });
    }
    const same = next.length === prev.length && next.every((n, j) => n.p === prev[j].p && Math.abs(n.vc - prev[j].vc) < 0.05);
    this.kept = next; this.notches = next.length;
    return !same;
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
  /**
   * A lane: this line moved sideways by `shift[i]` metres (+ right) along its own normals. It shares the station
   * index (and trims), so a car can change between lanes without losing its place.
   */
  lane(shift) {
    const L = Object.create(Line.prototype), N = this.N;
    Object.assign(L, { track: this.track, N, ds: this.ds, edge: this.edge, bound: this.bound, st: this.st, trim: this.trim, btrim: this.btrim, shift });
    for (const key of ['px', 'pz', 'len', 'h', 'k', 'ks', 'dk', 'lat', 'vmax', 'v', 'vbrk']) L[key] = new Float64Array(N);
    L.cap = this.cap;
    for (let i = 0; i < N; i++) {
      const h = this.h[i];
      L.px[i] = this.px[i] + Math.cos(h) * shift[i]; L.pz[i] = this.pz[i] - Math.sin(h) * shift[i]; L.lat[i] = this.lat[i] + shift[i];
    }
    L.geometry();
    // the shift adds curvature that the three-point stencil reads with station-scale noise; smooth that part only
    const dk = new Float64Array(N);
    for (let i = 0; i < N; i++) dk[i] = L.k[i] - this.k[i];
    for (let pass = 0; pass < 2; pass++) { const b = dk.slice(); for (let i = 0; i < N; i++) { let t = 0; for (let q = -2; q <= 2; q++) t += (3 - Math.abs(q)) * b[this.idx(i + q)]; dk[i] = t / 9; } }
    for (let i = 0; i < N; i++) L.k[i] = this.k[i] + dk[i];
    for (let i = 0; i < N; i++) { const a = i === 0 ? N - 1 : i - 1, j = i + 1 === N ? 0 : i + 1; L.ks[i] = 0.25 * L.k[a] + 0.5 * L.k[i] + 0.25 * L.k[j]; }
    const R = 3;
    for (let i = 0; i < N; i++) { const a = (i - R + N) % N, b = (i + R) % N; L.dk[i] = Math.abs(L.ks[b] - L.ks[a]) / Math.max(1e-6, 2 * R * L.len[i]); }
    return L;
  }
  /** Curvature stencils over stations [a, a + count) after their points changed. */
  geometryRange(a, count) {
    const N = this.N, { px, pz, len, h, k, ks, dk } = this;
    for (let c = -1; c <= count + 1; c++) {
      const i = this.idx(a + c), j = i + 1 === N ? 0 : i + 1, p = i === 0 ? N - 1 : i - 1;
      const abx = px[i] - px[p], abz = pz[i] - pz[p], bcx = px[j] - px[i], bcz = pz[j] - pz[i];
      const lab = Math.hypot(abx, abz), lbc = Math.hypot(bcx, bcz), lac = Math.hypot(px[j] - px[p], pz[j] - pz[p]);
      len[i] = lbc; h[i] = Math.atan2(px[j] - px[p], pz[j] - pz[p]);
      k[i] = 2 * (abz * bcx - abx * bcz) / Math.max(1e-9, lab * lbc * lac);
    }
    for (let c = 0; c <= count; c++) { const i = this.idx(a + c), p = i === 0 ? N - 1 : i - 1, j = i + 1 === N ? 0 : i + 1; ks[i] = 0.25 * k[p] + 0.5 * k[i] + 0.25 * k[j]; }
    for (let c = 1; c < count; c++) { const i = this.idx(a + c), p = (i - 3 + N) % N, q = (i + 3) % N; dk[i] = Math.abs(ks[q] - ks[p]) / Math.max(1e-6, 6 * len[i]); }
  }
  /**
   * A lane over a window: this line moved sideways by shift[j] metres (+ right) at stations i0 + j (j = 0..n), and
   * identical elsewhere. The arrays are copies, so the lane is a full Line a tracker can follow, built in O(window).
   */
  blankLane() {
    const L = Object.create(Line.prototype), N = this.N;
    Object.assign(L, { track: this.track, N, ds: this.ds, edge: this.edge, bound: this.bound, st: this.st, trim: this.trim, btrim: this.btrim });
    for (const key of LANE_KEYS) L[key] = this[key].slice();
    L.cap = this.cap;
    return L;
  }
  laneWindow(shift, i0, n, into = null) {
    // `into` is a lane from blankLane() that held an earlier window: only the stations this window uses are refreshed from the line
    const L = into ?? this.blankLane();
    if (into) for (const key of LANE_KEYS) { const src = this[key], dst = L[key]; for (let c = -14; c <= n + 16; c++) { const i = this.idx(i0 + c); dst[i] = src[i]; } }
    for (let j = 0; j <= n; j++) { const i = this.idx(i0 + j), h = this.h[i]; L.px[i] = this.px[i] + Math.cos(h) * shift[j]; L.pz[i] = this.pz[i] - Math.sin(h) * shift[j]; L.lat[i] = this.lat[i] + shift[j]; }
    // behind the window the lane stays at its starting offset for a few stations, so the join has no kink
    for (let c = 1; c <= 8; c++) { const i = this.idx(i0 - c), h = this.h[i]; L.px[i] = this.px[i] + Math.cos(h) * shift[0]; L.pz[i] = this.pz[i] - Math.sin(h) * shift[0]; L.lat[i] = this.lat[i] + shift[0]; }
    L.geometryRange(i0 - 10, n + 12);
    L.window = { i0, n };
    return L;
  }
  /**
   * Quasi-steady-state speeds over stations [i0, i0 + n] only: start at `vStart` and end no faster than `vEnd` (the
   * base line's speed where the lane rejoins it). Returns the time over the window.
   */
  speedsWindow(model, i0, n, vStart, vEnd, o = {}) {
    const N = this.N, ks = this.ks, len = this.len, vmax = this.vmax, v = this.v, trim = this.trim, btrim = this.btrim, dk = this.dk, J = o.jerk ?? model.jerk;
    const pb = o.brakeExp ?? 2, pd = o.driveExp ?? 2, top = o.top ?? 95, m0 = model.margin;
    const lat = (s, i) => { model.margin = m0 * trim[i]; const a = model.lat(s); model.margin = m0; return a; };
    for (let c = 0; c <= n; c++) {
      const i = this.idx(i0 + c), ak = Math.abs(ks[i]); let s = top;
      if (ak > 1e-6) { s = Math.min(top, Math.sqrt(lat(40, i) / ak)); for (let it = 0; it < 4; it++) s = Math.min(top, Math.sqrt(lat(s, i) / ak)); }
      if (J > 0 && dk[i] > 1e-7) s = Math.min(s, Math.cbrt(J / dk[i]));
      if (this.cap) s = Math.min(s, this.cap[i]);
      vmax[i] = s; v[i] = s;
    }
    const iS = this.idx(i0), iE = this.idx(i0 + n);
    v[iS] = Math.min(v[iS], vStart);
    const util = (i, s) => Math.min(1, s * s * Math.abs(ks[i]) / lat(s, i));
    for (let c = 0; c < n; c++) {
      const i = this.idx(i0 + c), nx = this.idx(i0 + c + 1), s = v[i], r = util(i, s);
      const t = Math.sqrt(s * s + 2 * len[i] * Math.max(0, model.drive(s, o.mass) * Math.pow(1 - Math.pow(r, pd), 1 / pd)));
      if (t < v[nx]) v[nx] = t;
    }
    v[iE] = Math.min(v[iE], vEnd);
    for (let c = n; c > 0; c--) {
      const i = this.idx(i0 + c), pv = this.idx(i0 + c - 1), s = v[i], r = util(i, s);
      model.margin = m0 * btrim[i]; const b = model.brake(s) * Math.pow(1 - Math.pow(r, pb), 1 / pb); model.margin = m0;
      const t = Math.sqrt(s * s + 2 * len[pv] * Math.max(0.5, b));
      if (t < v[pv]) v[pv] = t;
    }
    // braking envelope over the window, closed by the base line's envelope at the far end
    const vb = this.vbrk; for (let c = 0; c <= n; c++) vb[this.idx(i0 + c)] = vmax[this.idx(i0 + c)];
    vb[iE] = Math.min(vb[iE], o.vbrkEnd ?? vEnd);
    for (let c = n; c > 0; c--) {
      const i = this.idx(i0 + c), pv = this.idx(i0 + c - 1), sp = vb[i], r = util(i, sp);
      model.margin = m0 * btrim[i]; const b = model.brake(sp) * Math.pow(1 - Math.pow(r, pb), 1 / pb); model.margin = m0;
      const t = Math.sqrt(sp * sp + 2 * len[pv] * Math.max(0.5, b));
      if (t < vb[pv]) vb[pv] = t;
    }
    let T = 0; for (let c = 0; c < n; c++) { const i = this.idx(i0 + c); T += len[i] / Math.max(1, 0.5 * (v[i] + v[this.idx(i + 1)])); }
    return T;
  }
  /** Station index (fractional) of track distance s. */
  stationOf(s) { return ((s % this.track.length) + this.track.length) % this.track.length / this.ds; }
  /**
   * Corner zones from the speed profile: one per local speed minimum (apex) with at least `prom` m/s of
   * prominence, bounded by the speed maxima between consecutive apexes. Each zone is [a, b] in stations, wrapping.
   */
  zones(prom = 4) {
    const N = this.N, v = this.v, apex = [];
    // smooth lightly, then find minima with prominence over the surrounding maxima
    for (let i = 0; i < N; i++) {
      let lo = true; for (let d = -6; d <= 6; d++) if (v[this.idx(i + d)] < v[i] - 1e-9) { lo = false; break; }
      if (!lo) continue;
      let l = v[i], r = v[i];
      for (let d = 1; d < N / 2; d++) { const x = v[this.idx(i - d)]; if (x < v[i] - 1e-9) break; l = Math.max(l, x); }
      for (let d = 1; d < N / 2; d++) { const x = v[this.idx(i + d)]; if (x < v[i] - 1e-9) break; r = Math.max(r, x); }
      if (Math.min(l, r) - v[i] >= prom && (!apex.length || i - apex.at(-1) > 6)) apex.push(i);
    }
    if (!apex.length) return [{ a: 0, b: N - 1, apex: 0 }];
    const zones = [];
    for (let k = 0; k < apex.length; k++) {
      const p = apex[k], n = apex[(k + 1) % apex.length];
      // boundary: speed maximum between this apex and the next
      let best = p, span = (n - p + N) % N || N;
      for (let d = 0; d <= span; d++) { const i = this.idx(p + d); if (v[i] > v[best] || best === p) best = i; }
      zones.push({ apex: p, end: best });
    }
    return zones.map((z, k) => ({ a: zones[(k - 1 + zones.length) % zones.length].end, b: z.end, apex: z.apex }));
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
    if (data.btrim?.length === this.N) this.btrim.set(data.btrim);
    return true;
  }
}
