// Certified quasi-steady spatial optimal-control oracle.
//
// STATUS: see reports/stage05a-certified-oracle.md for the live certification matrix.
// Do not quote a Harbor number until every sanity case is certified.
//
// DESIGN (all four points exist because each one caused a wrong answer):
//
//   1. ONE canonical Bellman operator, bellmanMinimize({i,kp,kc,w}). Table
//      construction, policy recovery and residual audits all call it. Recovery
//      queries it at the CONTINUOUS state it actually occupies: there is no
//      rounding of the successor speed back to a grid node, which is a different
//      dynamical policy from the one the Bellman step solved.
//
//   2. Physical geometry. World-space segment length dL and Menger curvature from
//      P(i-1,kp) P(i,kc) P(i+1,kn). Time, acceleration and braking all integrate
//      over dL, never over station spacing.
//
//   3. STRICT feasibility interpolation. Interpolating between a finite and an
//      infinite value would hand a finite future cost to a speed that may be
//      beyond the feasible frontier, i.e. manufacture feasibility. The strict rule
//      is: exactly on a node -> that node; both bracketing nodes finite ->
//      interpolate; otherwise Infinity. This can lose a little sub-grid feasible
//      state space, and grid convergence quantifies that.
//
//   4. w = v^2 state with a continuous successor speed. Quantising the successor
//      trapped the car wherever the grid step exceeded the available acceleration
//      (43.27 m/s on a 900 m straight).
//
// Capability curves are the Stage 0 measured ones; the combined-slip boundary is
// the measured unit circle in normalised slip with no artificial reserve.

import { clamp } from '../../sim/math.js';

const EPS = 1e-9;

// Robust curvature magnitude through three world points (Menger curvature),
// units 1/metre. Zero for collinear points.
export function mengerCurvature(p0, p1, p2) {
  const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const c = Math.hypot(p2.x - p0.x, p2.z - p0.z);
  if (a < 1e-6 || b < 1e-6 || c < 1e-6) return 0;
  const cross = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z));
  return (2 * cross) / (a * b * c);
}

export function makeCurve(pairs) {
  if (!pairs || !pairs.length) return () => 0;
  return (v) => {
    if (v <= pairs[0][0]) return (pairs[0][1] / pairs[0][0]) * v;
    for (let i = 1; i < pairs.length; i++) {
      if (v <= pairs[i][0]) {
        const [v0, a0] = pairs[i - 1], [v1, a1] = pairs[i];
        return a0 + (a1 - a0) * ((v - v0) / (v1 - v0));
      }
    }
    return pairs[pairs.length - 1][1];
  };
}

export function createSpatialOracle({
  model,
  curves,
  mass = 1325,
  driveNet,
  brakeNet,
  coastNet,
  options = {},
} = {}) {
  const o = {
    dq: 1.8,
    qMax: null,
    wMin: 16,
    wMax: 3600,
    dW: 16,
    corridorMargin: 0,
    useWUpper: true,     // audited acceleration structure only
    strictValue: true,   // certification semantics
    float64: false,
    open: false,         // open horizon: terminal at station n-1, no wrap
    // Certification preset: Float64 storage, no acceleration masks, the reference
    // (continuous, knot-exact) Bellman minimiser, continuous capability curves.
    // Anything less is an experiment, not a reference solve.
    certification: false,
    ...options,
  };
  if (o.certification) {
    o.float64 = true;
    o.useWUpper = false;
    o.referenceMinimizer = true;
    o.continuousCapability = true;
  }
  const n = model.n;
  const ds = model.ds;

  const latMaxAt = makeCurve(curves?.latMax);
  const driveAt = driveNet ?? ((v) => makeCurve(curves?.driveForce)(v) / mass);
  const brakeAt = brakeNet ?? ((v) => makeCurve(curves?.brakeForce)(v) / mass);
  const coastAt = coastNet ?? (() => 0);

  // --- offset grid -----------------------------------------------------------
  // qPlan may be a scalar (real TrackModel) or a per-station array (synthetic
  // models used by the sanity tests). Treating an array as a scalar yields NaN
  // and silently masks every offset, so resolve it explicitly.
  const qPlanAt = (i) => (typeof model.qPlan === 'number' ? model.qPlan : model.qPlan[i]);
  let maxQPlan = 0;
  for (let i = 0; i < n; i++) maxQPlan = Math.max(maxQPlan, qPlanAt(i));
  const qLimit = o.qMax ?? Math.ceil(maxQPlan / o.dq) * o.dq;
  const QN = Math.round((2 * qLimit) / o.dq) + 1;
  const qGrid = new Float64Array(QN);
  for (let k = 0; k < QN; k++) qGrid[k] = -qLimit + k * o.dq;
  const qAllowed = new Uint8Array(n * QN);
  for (let i = 0; i < n; i++) {
    const lim = qPlanAt(i) - o.corridorMargin;
    for (let k = 0; k < QN; k++) qAllowed[i * QN + k] = Math.abs(qGrid[k]) <= lim + EPS ? 1 : 0;
  }

  // --- speed-energy grid -----------------------------------------------------
  const WN = Math.floor((o.wMax - o.wMin) / o.dW) + 1;
  const wGrid = new Float64Array(WN);
  for (let j = 0; j < WN; j++) wGrid[j] = o.wMin + j * o.dW;

  // --- world points ----------------------------------------------------------
  const px = new Float64Array(n * QN);
  const pz = new Float64Array(n * QN);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < QN; k++) {
      px[i * QN + k] = model.x[i] + qGrid[k] * model.nx[i];
      pz[i * QN + k] = model.z[i] + qGrid[k] * model.nz[i];
    }
  }

  // --- speed-indexed capability tables ---------------------------------------
  const latCapAt = new Float64Array(WN);
  const driveAccAt = new Float64Array(WN);
  const brakeAccAt = new Float64Array(WN);
  const coastAccAt = new Float64Array(WN);
  for (let j = 0; j < WN; j++) {
    const v = Math.sqrt(wGrid[j]);
    latCapAt[j] = Math.max(1, latMaxAt(v));
    driveAccAt[j] = driveAt(v);
    brakeAccAt[j] = brakeAt(v);
    coastAccAt[j] = coastAt(v);
  }

  // --- precomputed transition geometry ---------------------------------------
  // dL and kappa depend only on (station, kp, kc, kn). Kappa is already 1/metre:
  // it must NOT be divided by dL again anywhere.
  const G = QN * QN * QN;
  const geomDl = new Float64Array(n * G);
  const geomKappa = new Float64Array(n * G);
  const geomWAyMax = new Float64Array(n * G);
  const gIdx = (i, kp, kc, kn) => i * G + (kp * QN + kc) * QN + kn;
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n, iNext = (i + 1) % n;
    for (let kp = 0; kp < QN; kp++) {
      for (let kc = 0; kc < QN; kc++) {
        for (let kn = 0; kn < QN; kn++) {
          const gi = gIdx(i, kp, kc, kn);
          const p0 = { x: px[iPrev * QN + kp], z: pz[iPrev * QN + kp] };
          const p1 = { x: px[i * QN + kc], z: pz[i * QN + kc] };
          const p2 = { x: px[iNext * QN + kn], z: pz[iNext * QN + kn] };
          const dL = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          const kappa = mengerCurvature(p0, p1, p2);
          geomDl[gi] = dL;
          geomKappa[gi] = kappa;
          let wCap = o.wMax;
          if (kappa > 1e-7 && dL > 1e-6) {
            let v = Math.sqrt(o.wMax);
            for (let it = 0; it < 40; it++) v = Math.sqrt(latMaxAt(v) / kappa);
            wCap = Math.min(o.wMax, v * v * (1 + 1e-9));
          }
          geomWAyMax[gi] = wCap;
        }
      }
    }
  }

  // --- wUpper: OPTIMISTIC geometric speed bound ------------------------------
  // Per station, the flattest curvature available anywhere in the corridor gives
  // an upper bound on the speed any feasible line can carry there; a backward
  // braking pass with the strongest braking then bounds every station. It is used
  // ONLY to skip states, never as a constraint, and tools/dp-ablations.mjs runs
  // the solve with it disabled to prove it excludes nothing.
  const wUpper = new Float64Array(n).fill(o.wMax);
  {
    const flat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      const iPrev = (i - 1 + n) % n, iNext = (i + 1) % n;
      for (let kp = 0; kp < QN; kp++) {
        if (!qAllowed[iPrev * QN + kp]) continue;
        for (let kc = 0; kc < QN; kc++) {
          if (!qAllowed[i * QN + kc]) continue;
          for (let kn = 0; kn < QN; kn++) {
            if (!qAllowed[iNext * QN + kn]) continue;
            const kap = geomKappa[gIdx(i, kp, kc, kn)];
            if (kap < best) best = kap;
          }
        }
      }
      flat[i] = Number.isFinite(best) ? Math.max(best, 1e-6) : 1e-6;
    }
    for (let i = 0; i < n; i++) {
      let v = Math.sqrt(o.wMax);
      for (let it = 0; it < 40; it++) v = Math.sqrt(latMaxAt(v) / flat[i]);
      wUpper[i] = Math.min(o.wMax, v * v * 1.0001);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const iN = (i + 1) % n;
        const dL = Math.max(1e-6, Math.hypot(px[iN * QN] - px[i * QN], pz[iN * QN] - pz[i * QN]));
        const brake = brakeAt(Math.sqrt(wUpper[iN]));
        wUpper[i] = Math.min(wUpper[i], wUpper[iN] + 2 * brake * dL);
      }
    }
  }

  const S = QN * QN * WN;
  const idx = (kp, kc, jw) => (kp * QN + kc) * WN + jw;
  const wToNode = (w) => Math.max(0, Math.min(WN - 1, Math.round((w - o.wMin) / o.dW)));
  // Open horizon: station n-1 is the terminal and nothing wraps.
  const nextOf = (i) => (o.open ? i + 1 : (i + 1) % n);
  const prevOf = (i) => (o.open ? Math.max(0, i - 1) : (i - 1 + n) % n);

  // ==========================================================================
  // 1. Canonical transition (continuous w and wn).
  // ==========================================================================
  function transitionW(i, kp, kc, w, kn, wn) {
    const iN = nextOf(i);
    const gi = gIdx(i, kp, kc, kn);
    const dL = geomDl[gi];
    if (!(dL > 1e-6)) return null;
    if (wn < wGrid[0] - 1e-9 || wn > wGrid[WN - 1] + 1e-9) return null;
    const kappa = geomKappa[gi];
    const wTop = Math.max(w, wn);
    if (wTop > geomWAyMax[gi] + 1e-9) return null;
    const jTop = wToNode(wTop);
    const jMid = wToNode(0.5 * (w + wn));
    const vTopC = Math.sqrt(Math.max(0, wTop));
    const vMidC = Math.sqrt(Math.max(0, 0.5 * (w + wn)));
    const ay = wTop * kappa;
    // Reference solves evaluate the measured curves continuously. Mapping a speed
    // to the nearest w-grid sample first makes the physical transition depend on
    // dW, which is an approximation of the value grid leaking into the plant.
    const ayCap = o.continuousCapability ? Math.max(1, latMaxAt(vTopC)) : latCapAt[jTop];
    const coast = o.continuousCapability ? coastAt(vMidC) : coastAccAt[jMid];
    const driveCap = o.continuousCapability ? driveAt(vMidC) : driveAccAt[jMid];
    const brakeCap = o.continuousCapability ? brakeAt(vMidC) : brakeAccAt[jMid];
    const uy = clamp(ay / ayCap, 0, 1);
    const longFrac = Math.sqrt(Math.max(0, 1 - uy * uy));
    const aEff = (wn - w) / (2 * dL);
    const grossDrive = Math.max(0, driveCap + coast);
    const grossBrake = Math.max(0, brakeCap - coast);
    const accelCap = grossDrive * longFrac - coast;
    const decelCap = grossBrake * longFrac + coast;
    if (aEff > accelCap + 1e-9) return null;
    if (aEff < -decelCap - 1e-9) return null;
    const v = Math.sqrt(Math.max(0, w));
    const vn = Math.sqrt(Math.max(0, wn));
    const dt = (2 * dL) / Math.max(1e-6, v + vn);
    // Certification metric: the longitudinal term is normalised by the capability
    // that is actually being used. Normalising braking demand against drive
    // capability (the old behaviour) made u_total meaningless.
    const tyreDemand = aEff + coast;
    const uX = tyreDemand >= 0
      ? clamp(tyreDemand / Math.max(1e-6, grossDrive), 0, 1)
      : clamp(-tyreDemand / Math.max(1e-6, grossBrake), 0, 1);
    const utilisation = Math.hypot(uy, uX);
    return {
      feasible: true, i, iNext: iN, kp, kc, kn, w, wn, v, vn,
      dL, kappa, ay, uy, aEff, dt, accelCap, decelCap, longFrac, coast, utilisation, uX,
    };
  }
  const transition = (i, kp, kc, jw, kn, jwn) =>
    transitionW(i, kp, kc, wGrid[jw], kn, wGrid[jwn]);

  // ==========================================================================
  // 2. Value representation: grid knots + an adaptive CONTINUOUS feasibility
  //    frontier knot per column.
  //
  //    For a column (i,kp,kc) the representation is
  //        (w0,V0) ... (wTop,VTop)   grid knots, finite
  //        (wF ,VF )                 the frontier: the largest continuous w with a
  //                                  finite Bellman continuation, and the ACTUAL
  //                                  Bellman value there, computed by the same
  //                                  canonical minimiser as everything else.
  //    Queries are allowed only for w <= wF, and interpolation happens only
  //    between known feasible knots, so cost stays continuous while reachability
  //    is never invented. Holding the last grid value across the top interval was
  //    what removed the incentive to accelerate (a faster arrival scored the same
  //    as a slower one).
  // ==========================================================================
  const colIdx = (i, kp, kc) => (i * QN + kp) * QN + kc;
  const wF = new Float64Array(n * QN * QN).fill(NaN);
  const VF = new Float64Array(n * QN * QN).fill(Infinity);
  const topJwArr = new Int16Array(n * QN * QN).fill(-1);

  function valueAt(V, i, kp, kc, w) {
    const col = colIdx(i, kp, kc);
    const cap = wF[col];
    if (!(w <= cap + 1e-9)) return Infinity;
    const topJw = topJwArr[col];
    if (topJw < 0) return Infinity;
    const base = i * S + idx(kp, kc, 0);
    const x = (w - o.wMin) / o.dW;
    if (x <= topJw + 1e-9) {
      const j0 = Math.max(0, Math.min(topJw, Math.floor(x)));
      const j1 = Math.min(topJw, j0 + 1);
      const f = Math.max(0, Math.min(1, x - j0));
      const a = V[base + j0], b = V[base + j1];
      return a + (b - a) * f;
    }
    const wTop = wGrid[topJw];
    const a = V[base + topJw];
    const b = VF[col];
    if (!Number.isFinite(b)) return a;
    const f = (w - wTop) / Math.max(1e-9, cap - wTop);
    return a + (b - a) * f;
  }

  // ==========================================================================
  // 3. Successor candidate enumeration (reduced for speed, dense for audit).
  // ==========================================================================
  let transitionCount = 0;
  const FULL_SAMPLES = 96;

  // Feasibility frontiers of the successor interval, found by bisection from the
  // HOLD speed, which is always feasible (aEff = 0). Bisecting from either window
  // end instead is wrong: a marginally infeasible endpoint made the whole frontier
  // search bail out and silently dropped the acceleration candidate, which is what
  // inflated the middle of the value table and made the car decelerate.
  function frontier(i, kp, kc, w, kn, lo, hi, wantUp) {
    const fLo = transitionW(i, kp, kc, w, kn, lo) !== null;
    const fHi = transitionW(i, kp, kc, w, kn, hi) !== null;
    if (fLo && fHi) return wantUp ? hi : lo;
    if (!fLo && !fHi) return null;
    if (!fLo) {
      // feasible only above: bisect [w, hi] for the lower frontier
      let a = w, b = hi;
      for (let it = 0; it < 40; it++) {
        const mid = 0.5 * (a + b);
        if (transitionW(i, kp, kc, w, kn, mid) === null) b = mid; else a = mid;
      }
      return wantUp ? hi : a;
    }
    // feasible only below: bisect [lo, w] for the upper frontier
    let a = lo, b = w;
    for (let it = 0; it < 40; it++) {
      const mid = 0.5 * (a + b);
      if (transitionW(i, kp, kc, w, kn, mid) === null) a = mid; else b = mid;
    }
    return wantUp ? b : lo;
  }

  function successors(i, kp, kc, w, visit, { full = false } = {}) {
    if (o.open && i >= n - 1) return;
    const iN = nextOf(i);
    const v = Math.sqrt(Math.max(0, w));
    for (let kn = 0; kn < QN; kn++) {
      if (!qAllowed[iN * QN + kn]) continue;
      const gi = gIdx(i, kp, kc, kn);
      const dL = geomDl[gi];
      if (!(dL > 1e-6)) continue;
      // Exact capability at the exact state: no node rounding in the window.
      const coast = coastAt(v);
      const dMax = Math.max(0, driveAt(v) + coast);
      const dMin = -(Math.max(0, brakeAt(v) - coast) + coast);
      const wLo = Math.max(wGrid[0], w + 2 * dMin * dL);
      const wHi = Math.min(wGrid[WN - 1], Math.min(geomWAyMax[gi], w + 2 * dMax * dL));
      if (wHi < wLo - 1e-9) continue;
      const emit = (wn) => {
        if (wn === null || wn < wLo - 1e-9 || wn > wHi + 1e-9) return;
        transitionCount++;
        const rec = transitionW(i, kp, kc, w, kn, wn);
        if (rec) visit(rec);
      };
      const jLo = Math.max(0, Math.ceil((wLo - o.wMin) / o.dW - 1e-9));
      const jHi = Math.min(WN - 1, Math.floor((wHi - o.wMin) / o.dW + 1e-9));
      if (full) {
        for (let s = 0; s <= FULL_SAMPLES; s++) emit(wLo + ((wHi - wLo) * s) / FULL_SAMPLES);
        continue;
      }
      // The representation is piecewise linear in w with kinks exactly at the grid
      // knots and at the next layer's frontier knot, so the exact minimiser only
      // needs those points plus the window ends.
      emit(wGrid[jLo]);
      emit(wGrid[jHi]);
      emit(w);
      const jA = Math.max(0, jLo);
      const jB = Math.min(WN - 1, jHi);
      if (jB - jA <= 24) {
        for (let j = jA; j <= jB; j++) emit(wGrid[j]);
      } else {
        for (let s = 0; s <= 24; s++) emit(wGrid[Math.round(jA + ((jB - jA) * s) / 24)]);
      }
      const capNext = wF[colIdx(iN, kc, kn)];
      if (Number.isFinite(capNext) && capNext >= wLo - 1e-9 && capNext <= wHi + 1e-9) emit(capNext);
    }
  }

  // ==========================================================================
  // 4. Bellman minimisers.
  //
  //    The FAST operator samples the window at knots. That is NOT exact: even
  //    with a piecewise-linear V, Q(wn) = 2dL/(v + sqrt(wn)) + V(wn) is non-linear
  //    in wn because of the transition time, so an interior minimum can exist
  //    between knots. The measured reduced-vs-dense gap of up to 0.064 s is that
  //    error.
  //
  //    The REFERENCE operator splits the feasible window at every representation
  //    breakpoint (next-layer grid knots and next-layer frontier knot), evaluates
  //    the segment endpoints, and solves the analytic stationary condition of each
  //    segment:
  //        dQ/dwn = -dL / (sqrt(wn) (v + sqrt(wn))^2) + slope = 0
  //    i.e. u (u + v)^2 = dL / slope with u = sqrt(wn), monotone in u, so bisection
  //    is exact. Certification uses this one.
  // ==========================================================================
  function bellmanMinimizeFast(V, i, kp, kc, w, { dense = false } = {}) {
    let best = Infinity, bestKn = -1, bestWn = 0, bestRec = null;
    successors(i, kp, kc, w, (rec) => {
      const succVal = valueAt(V, rec.iNext, rec.kc, rec.kn, rec.wn);
      if (!Number.isFinite(succVal)) return;
      const cost = rec.dt + succVal;
      if (cost < best) { best = cost; bestKn = rec.kn; bestWn = rec.wn; bestRec = rec; }
    }, { full: dense });
    return { finite: Number.isFinite(best), cost: best, kn: bestKn, wn: bestWn, transition: bestRec };
  }

  function bellmanMinimizeReference(V, i, kp, kc, w) {
    if (o.open && i >= n - 1) return { finite: false, cost: Infinity, kn: -1, wn: 0, transition: null };
    const iN = nextOf(i);
    const v = Math.sqrt(Math.max(0, w));
    let best = Infinity, bestKn = -1, bestWn = 0, bestRec = null;
    for (let kn = 0; kn < QN; kn++) {
      if (!qAllowed[iN * QN + kn]) continue;
      const gi = gIdx(i, kp, kc, kn);
      const dL = geomDl[gi];
      if (!(dL > 1e-6)) continue;
      const coast = coastAt(v);
      const dMax = Math.max(0, driveAt(v) + coast);
      const dMin = -(Math.max(0, brakeAt(v) - coast) + coast);
      const wLo = Math.max(wGrid[0], w + 2 * dMin * dL);
      const wHi = Math.min(wGrid[WN - 1], Math.min(geomWAyMax[gi], w + 2 * dMax * dL));
      if (wHi < wLo - 1e-9) continue;
      const evalAt = (wn) => {
        transitionCount++;
        const rec = transitionW(i, kp, kc, w, kn, wn);
        if (!rec) return null;
        const sv = valueAt(V, rec.iNext, rec.kc, rec.kn, wn);
        if (!Number.isFinite(sv)) return null;
        return { cost: rec.dt + sv, sv, rec };
      };
      const consider = (r, wn) => {
        if (r && r.cost < best) { best = r.cost; bestKn = kn; bestWn = wn; bestRec = r.rec; }
      };
      // Breakpoints: window ends, interior next-layer knots, next-layer frontier.
      const bp = [wLo, wHi];
      const jA = Math.max(0, Math.ceil((wLo - o.wMin) / o.dW - 1e-9));
      const jB = Math.min(WN - 1, Math.floor((wHi - o.wMin) / o.dW + 1e-9));
      for (let j = Math.max(0, jA); j <= jB; j++) {
        if (wGrid[j] > wLo + 1e-12 && wGrid[j] < wHi - 1e-12) bp.push(wGrid[j]);
      }
      const capNext = wF[colIdx(iN, kc, kn)];
      if (Number.isFinite(capNext) && capNext > wLo + 1e-12 && capNext < wHi - 1e-12) bp.push(capNext);
      bp.sort((a, b) => a - b);
      for (let s = 0; s < bp.length - 1; s++) {
        const a = bp[s], b = bp[s + 1];
        if (b - a < 1e-12) continue;
        const ra = evalAt(a);
        const rb = evalAt(b);
        consider(ra, a);
        consider(rb, b);
        if (ra && rb && rb.sv > ra.sv) {
          const slope = (rb.sv - ra.sv) / (b - a);
          const rhs = dL / slope;
          let u0 = Math.sqrt(Math.max(0, a)), u1 = Math.sqrt(Math.max(0, b));
          const F = (u) => u * (u + v) * (u + v) - rhs;
          if (F(u0) <= 0 && F(u1) >= 0) {
            for (let it = 0; it < 60; it++) {
              const um = 0.5 * (u0 + u1);
              if (F(um) < 0) u0 = um; else u1 = um;
            }
            const um = 0.5 * (u0 + u1);
            consider(evalAt(um * um), um * um);
          }
        }
      }
    }
    return { finite: Number.isFinite(best), cost: best, kn: bestKn, wn: bestWn, transition: bestRec };
  }

  function bellmanMinimize(V, i, kp, kc, w, opts = {}) {
    return o.referenceMinimizer
      ? bellmanMinimizeReference(V, i, kp, kc, w)
      : bellmanMinimizeFast(V, i, kp, kc, w, opts);
  }

  // ==========================================================================
  // 4b. Frontier construction: the largest continuous w whose canonical Bellman
  //     minimisation is finite, plus the value there. The predicate is the
  //     minimiser itself, so feasibility and cost come from the same object.
  // ==========================================================================
  function computeFrontier(V, i, kp, kc) {
    const col = colIdx(i, kp, kc);
    const topJw = topJwArr[col];
    if (topJw < 0) { wF[col] = NaN; VF[col] = Infinity; return; }
    const wStart = wGrid[topJw];
    const wLimit = wGrid[WN - 1];
    const finite = (w) => bellmanMinimize(V, i, kp, kc, w).finite;
    if (!finite(wStart)) { wF[col] = NaN; VF[col] = Infinity; return; }
    if (finite(wLimit)) {
      const res = bellmanMinimize(V, i, kp, kc, wLimit);
      wF[col] = wLimit; VF[col] = res.cost;
      return;
    }
    let lo = wStart, hi = wLimit;
    let step = Math.max(o.dW, 1);
    let probe = Math.min(wLimit, lo + step);
    let guard = 0;
    while (probe < wLimit && guard++ < 80) {
      if (!finite(probe)) { hi = probe; break; }
      lo = probe;
      step *= 2;
      probe = Math.min(wLimit, lo + step);
    }
    for (let it = 0; it < 40; it++) {
      const mid = 0.5 * (lo + hi);
      if (finite(mid)) lo = mid; else hi = mid;
    }
    const res = bellmanMinimize(V, i, kp, kc, lo);
    wF[col] = lo;
    VF[col] = res.finite ? res.cost : Infinity;
  }

  // ==========================================================================
  // 5. Solve.
  // ==========================================================================
  function solve({ mode = 'periodic', maxIterations = 40, tolerance = 1e-4, onProgress = null,
    storePolicy = true, maxSeconds = 900, dense = false, terminalW = null } = {}) {
    const Arr = o.float64 ? Float64Array : Float32Array;
    const V = new Arr(n * S).fill(Infinity);
    const polKn = storePolicy ? new Int8Array(n * S).fill(-1) : null;
    const polWn = storePolicy ? new Arr(n * S) : null;
    let layer0 = new Arr(S);
    // Terminal: the timing line. Free terminal = zero for every state; a
    // speed-capped terminal (used to isolate backward braking propagation) only
    // accepts states below the cap.
    for (let kp = 0; kp < QN; kp++) {
      for (let kc = 0; kc < QN; kc++) {
        for (let jw = 0; jw < WN; jw++) {
          const ok = qAllowed[kp] && qAllowed[kc] && (terminalW === null || wGrid[jw] <= terminalW + 1e-9);
          layer0[idx(kp, kc, jw)] = ok ? 0 : Infinity;
        }
      }
    }
    const increments = [];
    let prevBest = null;
    let iterations = 0;
    let statesVisited = 0;
    const startedAt = Date.now();

    for (let iter = 0; iter < maxIterations; iter++) {
      const iterStart = Date.now();
      iterations = iter + 1;
      transitionCount = 0;
      statesVisited = 0;
      const termStation = o.open ? n - 1 : 0;
      for (let s = 0; s < S; s++) V[termStation * S + s] = layer0[s];
      // The terminal layer's feasible frontier: everything, or up to the cap.
      {
        const capJw = terminalW === null ? WN - 1 : wToNode(terminalW);
        for (let kp = 0; kp < QN; kp++) {
          for (let kc = 0; kc < QN; kc++) {
            const ok = qAllowed[prevOf(termStation) * QN + kp] && qAllowed[termStation * QN + kc];
            const col = colIdx(termStation, kp, kc);
            topJwArr[col] = ok ? capJw : -1;
            wF[col] = ok ? wGrid[capJw] : NaN;
            VF[col] = ok ? 0 : Infinity;
          }
        }
      }

      for (let i = o.open ? n - 2 : n - 1; i >= 0; i--) {
        const base = i * S;
        for (let kp = 0; kp < QN; kp++) {
          if (!qAllowed[prevOf(i) * QN + kp]) continue;
          for (let kc = 0; kc < QN; kc++) {
            if (!qAllowed[i * QN + kc]) continue;
            let topJw = -1;
            for (let jw = 0; jw < WN; jw++) {
              const w = wGrid[jw];
              if (o.useWUpper && w > wUpper[i]) { V[base + idx(kp, kc, jw)] = Infinity; continue; }
              statesVisited++;
              const res = bellmanMinimize(V, i, kp, kc, w, { dense });
              V[base + idx(kp, kc, jw)] = res.cost;
              if (Number.isFinite(res.cost)) topJw = jw;
              if (polKn) { polKn[base + idx(kp, kc, jw)] = res.kn; polWn[base + idx(kp, kc, jw)] = res.wn; }
            }
            topJwArr[colIdx(i, kp, kc)] = topJw;
            computeFrontier(V, i, kp, kc);
          }
        }
      }
      // Corridor-masked terminal-layer states must be Infinity: a zero left there
      // would win the argmin and hand the recovery a state with no policy.
      if (!o.open) for (let kp = 0; kp < QN; kp++) {
        const okPrev = qAllowed[((n - 1) % n) * QN + kp];
        for (let kc = 0; kc < QN; kc++) {
          if (okPrev && qAllowed[kc]) continue;
          for (let jw = 0; jw < WN; jw++) V[idx(kp, kc, jw)] = Infinity;
        }
      }
      let best = Infinity;
      for (let s = 0; s < S; s++) if (V[s] < best) best = V[s];
      increments.push(best);
      if (onProgress) {
        onProgress({
          iter, best, statesVisited, transitions: transitionCount,
          iterationMs: Date.now() - iterStart, elapsedMs: Date.now() - startedAt,
          increment: prevBest === null ? null : best - prevBest,
        });
      }
      if (mode === 'finish') break;
      if (prevBest !== null) {
        const inc = best - prevBest;
        if (iterations > 2 && Math.abs(inc - (increments[increments.length - 2] - prevBest)) < tolerance) {
          prevBest = best;
          break;
        }
      }
      prevBest = best;
      for (let s = 0; s < S; s++) layer0[s] = V[0 * S + s];
      if (Date.now() - startedAt > maxSeconds * 1000) {
        if (onProgress) onProgress({ aborted: true, elapsedMs: Date.now() - startedAt });
        break;
      }
    }
    let cycleMean = null;
    if (mode === 'periodic' && increments.length >= 2) cycleMean = increments[increments.length - 1] - increments[increments.length - 2];
    return { V, polKn, polWn, layer0, increments, iterations, cycleMean };
  }

  // ==========================================================================
  // 6. Continuous policy recovery.
  // ==========================================================================
  // Open horizon: start at a station-1 state and follow the Bellman policy at the
  // continuous state actually reached until the terminal station.
  function recoverOpen(V, { start = null, startStation = 1, maxSteps = null } = {}) {
    let s0 = start;
    if (!s0) {
      let best = Infinity;
      for (let kp = 0; kp < QN; kp++) {
        if (!qAllowed[((startStation - 1 + n) % n) * QN + kp]) continue;
        for (let kc = 0; kc < QN; kc++) {
          if (!qAllowed[startStation * QN + kc]) continue;
          for (let jw = 0; jw < WN; jw++) {
            const val = valueAt(V, startStation, kp, kc, wGrid[jw]);
            if (val < best) { best = val; s0 = { kp, kc, w: wGrid[jw] }; }
          }
        }
      }
    }
    if (!s0) return null;
    const traj = [];
    let { kp, kc, w } = s0;
    const steps = maxSteps ?? (n - 1);
    for (let step = 0; step < steps; step++) {
      const i = (startStation + step) % n;
      traj.push({ i, kp, kc, w, q: qGrid[kc], v: Math.sqrt(w) });
      if (o.open && i >= n - 1) break; // terminal station, nothing beyond it
      const res = bellmanMinimize(V, i, kp, kc, w);
      if (!res.finite) return { traj, complete: false, reason: `no feasible successor at station ${i}`, start: s0 };
      kp = kc; kc = res.kn; w = res.wn;
    }
    return { traj, complete: traj.length === steps || (o.open && traj[traj.length - 1]?.i === n - 1), start: s0 };
  }

  // Periodic: one-lap return map per timing-line geometry cell, closed by 1-D
  // root finding on Delta(w0) = w_after_one_lap - w0. Closure is a continuous
  // residual, not an integer node match.
  function recoverPeriodic(V, { cells = null, samples = 48, tol = 1e-6, maxIter = 60 } = {}) {
    const walk = (kp0, kc0, w0) => {
      let kp = kp0, kc = kc0, w = w0;
      for (let step = 0; step < n; step++) {
        const i = step;
        const res = bellmanMinimize(V, i, kp, kc, w);
        if (!res.finite) return null;
        kp = kc; kc = res.kn; w = res.wn;
      }
      return { kp, kc, w };
    };
    const cellsToTry = cells ?? (() => {
      const list = [];
      for (let kp = 0; kp < QN; kp++) {
        if (!qAllowed[((n - 1) % n) * QN + kp]) continue;
        for (let kc = 0; kc < QN; kc++) if (qAllowed[kc]) list.push([kp, kc]);
      }
      return list;
    })();

    let best = null;
    for (const [kp0, kc0] of cellsToTry) {
      const lo = wGrid[0], hi = wGrid[WN - 1];
      const delta = (w0) => {
        const end = walk(kp0, kc0, w0);
        if (!end || end.kp !== kp0 || end.kc !== kc0) return null;
        return end.w - w0;
      };
      // Bracket a sign change over the cell's speed range.
      let a = lo, fa = delta(a);
      const ws = [];
      for (let s = 0; s <= samples; s++) ws.push(lo + ((hi - lo) * s) / samples);
      let root = null;
      for (let s = 1; s < ws.length; s++) {
        const b = ws[s], fb = delta(b);
        if (fa === null) { a = b; fa = fb; continue; }
        if (fb === null) { a = b; fa = fb; continue; }
        if (fa === 0) { root = a; break; }
        if (fa * fb < 0) {
          let x0 = a, x1 = b, f0 = fa, f1 = fb;
          for (let it = 0; it < maxIter; it++) {
            const xm = 0.5 * (x0 + x1);
            const fm = delta(xm);
            if (fm === null) break;
            if (Math.abs(fm) < tol) { root = xm; break; }
            if (f0 * fm <= 0) { x1 = xm; f1 = fm; } else { x0 = xm; f0 = fm; }
          }
          if (root === null) root = 0.5 * (x0 + x1);
          break;
        }
        a = b; fa = fb;
      }
      if (root === null) continue;
      // Build the closed cycle from the root and cost it.
      const traj = [];
      let kp = kp0, kc = kc0, w = root;
      let ok = true;
      for (let step = 0; step < n; step++) {
        const i = step;
        traj.push({ i, kp, kc, w, q: qGrid[kc], v: Math.sqrt(w) });
        const res = bellmanMinimize(V, i, kp, kc, w);
        if (!res.finite) { ok = false; break; }
        kp = kc; kc = res.kn; w = res.wn;
      }
      if (!ok) continue;
      const closure = { dqPrev: qGrid[kp] - qGrid[kp0], dqNow: qGrid[kc] - qGrid[kc0], dw: w - root, dv: Math.sqrt(Math.max(0, w)) - Math.sqrt(Math.max(0, root)) };
      const rep = replay(traj);
      const candidate = { traj, start: { kp: kp0, kc: kc0, w: root }, closure, closed: true, replay: rep };
      if (!best || (rep.ok && rep.time < best.replay.time)) best = candidate;
    }
    return best;
  }

  // ==========================================================================
  // 7. Independent replay. Recomputes everything from the sequence via the
  //    canonical transition; reads no accumulated cost.
  // ==========================================================================
  function replay(traj, { closed = true } = {}) {
    let time = 0, distance = 0;
    let maxUy = 0, maxUtil = 0, minV = Infinity, maxV = 0, maxQ = 0;
    const stations = [];
    if (!traj || !traj.length) return { ok: false, reason: 'empty trajectory', stations };
    const limit = closed ? traj.length : traj.length - 1;
    for (let k = 0; k < limit; k++) {
      const a = traj[k];
      const b = traj[(k + 1) % traj.length];
      const rec = transitionW(a.i, a.kp, a.kc, a.w, b.kc, b.w);
      if (!rec) return { ok: false, reason: `replay transition infeasible at station ${a.i}`, at: a.i, stations };
      time += rec.dt;
      distance += rec.dL;
      maxUy = Math.max(maxUy, rec.uy);
      maxUtil = Math.max(maxUtil, rec.utilisation);
      minV = Math.min(minV, rec.v);
      maxV = Math.max(maxV, rec.vn);
      maxQ = Math.max(maxQ, Math.abs(a.q));
      stations.push({
        i: a.i, q: a.q, v: rec.v, vNext: rec.vn, dL: rec.dL, kappa: rec.kappa,
        ay: rec.ay, uy: rec.uy, aEff: rec.aEff, dt: rec.dt, longFrac: rec.longFrac,
      });
    }
    return { ok: true, time, distance, maxUy, maxUtil, minV, maxV, maxQ, stations };
  }

  return {
    grid: { n, ds, QN, qGrid, WN, wGrid, dW: o.dW, qLimit, wMin: o.wMin, wMax: o.wMax, S, states: n * S },
    options: o,
    model, curves: { latMaxAt, driveAt, brakeAt, coastAt },
    qAllowed, wUpper, idx, wToNode,
    geom: { dl: geomDl, kappa: geomKappa, wAyMax: geomWAyMax, gIdx, G },
    transition, transitionW, valueAt, successors, bellmanMinimize, bellmanMinimizeFast, bellmanMinimizeReference,
    successorsFull: (i, kp, kc, w, visit) => successors(i, kp, kc, w, visit, { full: true }),
    solve, recoverOpen, recoverPeriodic, replay,
    stats: () => ({ transitions: transitionCount }),
  };
}





