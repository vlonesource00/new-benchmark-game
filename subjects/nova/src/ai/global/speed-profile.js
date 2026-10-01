// DeepSeek Speed Profile
// Solves the quasi-steady combined-slip speed profile over a closed path:
// curve limit, periodic backward braking pass, periodic forward drive pass,
// iterated until the lateral demand and the longitudinal envelope agree.
// Returns the physical lap time of the geometry and the spatial longitudinal
// demand that the controller tracks.

import { wrap, clamp } from '../../sim/math.js';

export function speedProfile(path, envelope, { iterations = 10, vCap = Infinity, open = false } = {}) {
  const n = path.n;
  const v = new Float64Array(n);
  const aLat = new Float64Array(n);
  const curveV = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    curveV[i] = Math.min(envelope.curveLimit(Math.abs(path.kappa[i])), vCap);
    v[i] = curveV[i];
    aLat[i] = v[i] * v[i] * Math.abs(path.kappa[i]);
  }
  const vMin = open ? 4.0 : 2.0;
  for (let pass = 0; pass < iterations; pass++) {
    if (open) {
      // Open path: a single backward sweep from the far end.
      for (let i = n - 2; i >= 0; i--) {
        const aBrake = envelope.brakeMax(v[i + 1], aLat[i + 1]);
        const cap = Math.sqrt(Math.max(vMin * vMin, v[i + 1] * v[i + 1] + 2 * aBrake * path.ds[i]));
        if (cap < v[i]) v[i] = cap;
      }
      for (let i = 1; i < n; i++) {
        const aDrive = envelope.driveMax(v[i - 1], aLat[i - 1]);
        const cap = Math.sqrt(Math.max(vMin * vMin, v[i - 1] * v[i - 1] + 2 * aDrive * path.ds[i - 1]));
        if (cap < v[i]) v[i] = cap;
      }
    } else {
      // Closed lap: propagate twice around the ring.
      for (let k = 0; k < 2 * n; k++) {
        const i = n - 1 - (k % n);
        const j = wrap(i + 1, n);
        const aBrake = envelope.brakeMax(v[j], aLat[j]);
        const cap = Math.sqrt(Math.max(vMin * vMin, v[j] * v[j] + 2 * aBrake * path.ds[i]));
        if (cap < v[i]) v[i] = cap;
      }
      for (let k = 0; k < 2 * n; k++) {
        const i = k % n;
        const p = wrap(i - 1, n);
        const aDrive = envelope.driveMax(v[p], aLat[p]);
        const cap = Math.sqrt(Math.max(vMin * vMin, v[p] * v[p] + 2 * aDrive * path.ds[p]));
        if (cap < v[i]) v[i] = cap;
      }
    }
    for (let i = 0; i < n; i++) aLat[i] = v[i] * v[i] * Math.abs(path.kappa[i]);
  }
  const aLong = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = open ? Math.min(i + 1, n - 1) : wrap(i + 1, n);
    aLong[i] = (v[j] * v[j] - v[i] * v[i]) / (2 * Math.max(0.05, path.ds[i]));
  }
  let time = 0;
  for (let i = 0; i < (open ? n - 1 : n); i++) {
    const j = open ? i + 1 : wrap(i + 1, n);
    time += path.ds[i] / Math.max(0.5, 0.5 * (v[i] + v[j]));
  }
  const limit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (v[i] <= curveV[i] + 1e-6) limit[i] = 1;             // curvature
    else if (aLat[i] > envelope.latMax(v[i]) * 0.75) limit[i] = 1;
    else if (aLong[i] > 0.35) limit[i] = 2;                  // drive limited
    else limit[i] = 3;                                       // coast / calm
  }
  return { v, aLat, aLong, curveV, time, length: path.length, limit };
}

export function longitudinalDemand(profile, i) {
  return profile.aLong[i % profile.aLong.length];
}

export function minSpeedInWindow(profile, model, sFrom, sTo) {
  const i0 = model.index(sFrom), i1 = model.index(sTo);
  let v = Infinity;
  const span = wrap(sTo - sFrom, model.length);
  for (let d = 0; d <= span; d += model.ds) {
    const i = model.index(sFrom + d);
    if (profile.v[i] < v) v = profile.v[i];
  }
  void i0; void i1;
  return v;
}

export function requiredAccel(profile, model, s, lookahead) {
  const i = model.index(s), j = model.index(s + lookahead);
  const dv2 = profile.v[j] * profile.v[j] - profile.v[i] * profile.v[i];
  return dv2 / (2 * Math.max(1, lookahead));
}

export { clamp };
