// DeepSeek Local Plan
// Short-horizon trajectory generation in Frenet coordinates. From the car's
// actual state (q, q') it builds a quintic blend onto the race line at the
// horizon, samples that trajectory as a real world-space path, derives its
// curvature, and solves a local speed profile inside both the cornering grip
// and the global plan. The tracker and the longitudinal controller then follow
// the local plan through the same interface they use for the global line, so
// the driver is always solving from where the car actually is rather than
// assuming it is already on the plan.

import { buildPath } from '../global/path-geometry.js';
import { speedProfile } from '../global/speed-profile.js';

function quintic(q0, dq0, ddq0, q1, dq1, ddq1, L) {
  // q(x) = a0 + a1 x + ... + a5 x^5 over x in [0, L]
  const a0 = q0, a1 = dq0, a2 = ddq0 / 2;
  const b0 = q1, b1 = dq1, b2 = ddq1 / 2;
  const L2 = L * L, L3 = L2 * L, L4 = L3 * L, L5 = L4 * L;
  const m = [
    [L3, L4, L5],
    [3 * L2, 4 * L3, 5 * L4],
    [6 * L, 12 * L2, 20 * L3],
  ];
  const rhs = [
    b0 - (a0 + a1 * L + a2 * L2),
    b1 - (a1 + 2 * a2 * L),
    b2 - 2 * a2,
  ];
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
    - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const solve = (col) => {
    const M = m.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
    return det(M) / det(m);
  };
  const a3 = solve(0), a4 = solve(1), a5 = solve(2);
  return (x) => a0 + a1 * x + a2 * x * x + a3 * x ** 3 + a4 * x ** 4 + a5 * x ** 5;
}

export function buildLocalPlan({ model, line, ego, envelope, horizon, samples = 96, gripFactor = 0.92, lead = 3 }) {
  const i0 = model.index(ego.s);
  const q0 = ego.q;
  const kappaC = model.kappa[i0];
  const headingDiff = Math.atan2(Math.sin(ego.yaw - model.heading[i0]), Math.cos(ego.yaw - model.heading[i0]));
  const dq0 = Math.tan(headingDiff) * (1 - kappaC * q0);
  const L = horizon ?? Math.max(30, Math.min(110, ego.speed * 1.6));
  const i1 = model.index(ego.s + L);
  const q1 = line.q[i1];
  // Line slope at the horizon (central difference on the planned q).
  const step = 4;
  const qa = line.q[model.index(ego.s + L - step)];
  const qb = line.q[model.index(ego.s + L + step)];
  const dq1 = (qb - qa) / (2 * step);
  // Trajectory generation: the race line plus an exponentially decaying
  // correction for the car's actual position and slope error. Because the base
  // is the line itself, the trajectory inherits the line's curvature rather
  // than inventing an S-curve that fights it; the correction only has to remove
  // a bounded error over the horizon.
  const e0 = Math.max(-5, Math.min(5, q0 - line.q[i0]));
  const lineSlopeNow = (line.q[model.index(ego.s + step)] - line.q[model.index(ego.s - step)]) / (2 * step);
  const slopeErr = Math.max(-2, Math.min(2, dq0 - lineSlopeNow));
  const tauPos = Math.max(12, 0.55 * L);
  const tauSlope = Math.max(10, 0.45 * L);
  const trajectoryQ = (d) => {
    const base = line.q[model.index(ego.s + d)];
    return base + e0 * Math.exp(-d / tauPos) + slopeErr * d * Math.exp(-d / tauSlope);
  };
  const poly = trajectoryQ;
  void quintic;

  // Sample from `lead` metres behind the car so metric heading windows near the
  // car are always fully inside the sampled curve.
  const dMin = -lead;
  const span = L - dMin;
  const qMin = model.qLegal;
  const xs = new Float64Array(samples);
  const zs = new Float64Array(samples);
  const ds = new Float64Array(samples);
  for (let k = 0; k < samples; k++) {
    const d = dMin + (k / (samples - 1)) * span;
    const q = trajectoryQ(d);
    const p = model.point(ego.s + d, Math.max(-qMin, Math.min(qMin, q)));
    xs[k] = p.x; zs[k] = p.z;
  }
  for (let k = 0; k < samples - 1; k++) ds[k] = Math.hypot(xs[k + 1] - xs[k], zs[k + 1] - zs[k]);
  ds[samples - 1] = ds[samples - 2];
  const carIndex = Math.max(1, Math.min(samples - 2, Math.round((-dMin / span) * (samples - 1))));
  // Metric heading and curvature on the local path (same estimator as the
  // global path builder, applied to a short open curve).
  const heading = new Float64Array(samples);
  const kappa = new Float64Array(samples);
  // Positions are extrapolated linearly past both ends of the sampled window so
  // the metric heading/curvature estimator is well defined at every sample.
  const positionAt = (d) => {
    const x = (d / span) * (samples - 1); // sample units, 0 at dMin
    if (x <= 0) {
      const f = x;
      return [xs[0] + (xs[1] - xs[0]) * f, zs[0] + (zs[1] - zs[0]) * f];
    }
    if (x >= samples - 1) {
      const f = x - (samples - 1);
      return [xs[samples - 1] + (xs[samples - 1] - xs[samples - 2]) * f, zs[samples - 1] + (zs[samples - 1] - zs[samples - 2]) * f];
    }
    const i = Math.floor(x), f = x - i;
    return [xs[i] + (xs[i + 1] - xs[i]) * f, zs[i] + (zs[i + 1] - zs[i]) * f];
  };
  const headingAt = (d) => {
    const a = positionAt(d - 3.0), b = positionAt(d + 3.0);
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  };
  for (let k = 0; k < samples; k++) {
    const d = dMin + (k / (samples - 1)) * span;
    const a = positionAt(d - 3.0), b = positionAt(d + 3.0);
    heading[k] = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const chord = Math.max(0.05, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const dh = Math.atan2(Math.sin(headingAt(d + 3.0) - headingAt(d - 3.0)), Math.cos(headingAt(d + 3.0) - headingAt(d - 3.0)));
    kappa[k] = dh / chord;
  }
  // Smooth the curvature: resampling a line-plus-correction onto a fine local
  // grid leaves small station-to-station noise, and a speed limit that reads
  // that noise produces spurious braking. A 5-tap filter is well below the
  // physical smoothing of the tyres.
  {
    const raw = Float64Array.from(kappa);
    for (let k = 0; k < samples; k++) {
      const a = raw[Math.max(0, k - 2)], b = raw[Math.max(0, k - 1)], c = raw[k];
      const d1 = raw[Math.min(samples - 1, k + 1)], e = raw[Math.min(samples - 1, k + 2)];
      kappa[k] = (a + 2 * b + 3 * c + 2 * d1 + e) / 9;
    }
  }

  const path = { n: samples, px: xs, pz: zs, ds, heading, kappa, length: L, closed: false, nx: new Float64Array(samples), nz: new Float64Array(samples) };
  for (let k = 0; k < samples; k++) { path.nx[k] = Math.cos(heading[k]); path.nz[k] = -Math.sin(heading[k]); }

  // Speed profile for the part of the trajectory the car has not driven yet.
  // The samples behind the car are history; they must not constrain the future,
  // so the open-path solver runs on the sub-path from the car to the horizon.
  const ahead = samples - carIndex;
  const sub = {
    n: ahead,
    px: xs.subarray(carIndex), pz: zs.subarray(carIndex),
    ds: ds.subarray(carIndex),
    heading: heading.subarray(carIndex), kappa: kappa.subarray(carIndex),
    nx: path.nx.subarray(carIndex), nz: path.nz.subarray(carIndex),
    length: L,
    closed: false,
  };
  const local = speedProfile(sub, envelope, { iterations: 8, open: true });
  const v = new Float64Array(samples);
  const aLat = new Float64Array(samples);
  const aLong = new Float64Array(samples);
  const n = samples - 1;
  const blendEnd = Math.min(0.6 * L, 30);
  const joinSpeed = Math.max(6, Math.min(ego.speed + 0.5, line.profile.v[i0] * 1.05));
  for (let k = 0; k < carIndex; k++) {
    v[k] = joinSpeed;
    aLat[k] = 0;
  }
  // (The first two ahead samples are inside the blend, so they inherit the
  // global plan rather than the transient curvature of the quintic itself.)
  for (let k = carIndex; k <= n; k++) {
    const d = dMin + (k / n) * span;
    const globalV = line.profile.v[model.index(ego.s + d)];
    const j = k - carIndex;
    const localCurve = Math.sqrt(gripFactor * envelope.latMax(local.v[j]) / Math.max(1e-5, Math.abs(kappa[k])));
    v[k] = Math.max(6, Math.min(local.v[j], globalV, d > blendEnd ? localCurve : Infinity));
    if (d <= 2) v[k] = Math.min(v[k], joinSpeed);
    aLat[k] = v[k] * v[k] * Math.abs(kappa[k]);
  }
  for (let k = n - 1; k >= carIndex; k--) {
    const brake = envelope.brakeMax(v[k + 1], aLat[k + 1]);
    v[k] = Math.min(v[k], Math.sqrt(Math.max(4, v[k + 1] * v[k + 1] + 2 * brake * ds[k])));
  }
  // Length-domain smoothing: a pointwise curvature limit flickers between
  // rebuilds as the sample phase shifts, and a speed target that flickers turns
  // into throttle/brake pulsing. Smoothing over a fixed distance and then
  // re-running the braking pass keeps the profile both stable and feasible.
  {
    const raw = Float64Array.from(v);
    const window = Math.max(2, Math.round(4 / (span / (samples - 1))));
    for (let k = carIndex; k <= n; k++) {
      let sum = 0, count = 0;
      for (let j = -window; j <= window; j++) {
        const idx = Math.max(carIndex, Math.min(n, k + j));
        sum += raw[idx]; count++;
      }
      v[k] = sum / count;
    }
    for (let k = n - 1; k >= carIndex; k--) {
      const brake = envelope.brakeMax(v[k + 1], aLat[k + 1]);
      v[k] = Math.min(v[k], Math.sqrt(Math.max(4, v[k + 1] * v[k + 1] + 2 * brake * ds[k])));
    }
  }
  for (let k = carIndex + 1; k <= n; k++) {
    const drive = envelope.driveMax(v[k - 1], aLat[k - 1]);
    v[k] = Math.min(v[k], Math.sqrt(v[k - 1] * v[k - 1] + 2 * drive * ds[k - 1]));
    aLat[k] = v[k] * v[k] * Math.abs(kappa[k]);
  }
  for (let k = 0; k <= n; k++) {
    const j = Math.min(k + 1, n);
    aLong[k] = (v[j] * v[j] - v[k] * v[k]) / (2 * Math.max(0.05, ds[Math.min(k, n - 1)]));
  }
  return { path, profile: { v, aLat, aLong, time: local.time, limit: local.limit, curveV: local.curveV }, index: carIndex, horizon: L, carD: 0 };
}
