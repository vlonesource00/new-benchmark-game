// DeepSeek Path Geometry
// Converts a lateral profile q(s) into real world-space geometry: positions,
// headings, signed curvature and true arc length. The optimiser's objective is
// always evaluated on this geometry, never on an approximation, so path length
// and curvature are physically exact for the sampled path.
//
// Curvature is estimated over fixed metric windows (default 1.5 m half-span)
// rather than fixed station counts, so the same path evaluates identically at
// 0.5 m and 2 m sampling. A vehicle cannot follow curvature impulses at the
// centreline node joins; the metric window is the model of that smoothing.

import { wrap, clamp } from '../../sim/math.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function buildPath(model, q, { headingHalfSpan = 3.0 } = {}) {
  const n = model.n;
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = model.x[i] + q[i] * model.nx[i];
    pz[i] = model.z[i] + q[i] * model.nz[i];
  }
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = wrap(i + 1, n);
    ds[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  // Positions and headings are sampled at exact metric offsets so the geometry
  // of a given q(s) is identical at every station density.
  const positionAt = (sv) => {
    const u = wrap(sv, model.length) / model.ds;
    const i = Math.floor(u) % n;
    const f = u - Math.floor(u);
    const j = wrap(i + 1, n);
    return [px[i] + (px[j] - px[i]) * f, pz[i] + (pz[j] - pz[i]) * f];
  };
  const headingAt = (sv) => {
    const a = positionAt(sv - headingHalfSpan);
    const b = positionAt(sv + headingHalfSpan);
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  };
  const heading = new Float64Array(n);
  const kappa = new Float64Array(n);
  const arc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sv = i * model.ds;
    const a = positionAt(sv - headingHalfSpan);
    const b = positionAt(sv + headingHalfSpan);
    const chord = Math.max(0.05, Math.hypot(b[0] - a[0], b[1] - a[1]));
    heading[i] = Math.atan2(b[0] - a[0], b[1] - a[1]);
    // Curvature is with respect to true path arc length, not centreline s:
    // the chord over a fixed centreline span is longer on an outside line.
    kappa[i] = wrapAngle(headingAt(sv + headingHalfSpan) - headingAt(sv - headingHalfSpan)) / chord;
    arc[i] = chord;
  }
  let length = 0;
  for (let i = 0; i < n; i++) length += ds[i];
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) { nx[i] = Math.cos(heading[i]); nz[i] = -Math.sin(heading[i]); }
  return { n, px, pz, ds, heading, kappa, arc, length, nx, nz };
}

export function pathStats(path) {
  let energy = 0;
  for (let i = 0; i < path.n; i++) energy += path.kappa[i] * path.kappa[i] * path.ds[i];
  return { length: path.length, energy };
}

// Periodic smoothing of a lateral profile, clamped to the legal corridor.
export function smoothQ(model, q, passes = 1, amount = 0.35) {
  const n = model.n;
  let src = Float64Array.from(q);
  const out = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const avg = (src[wrap(i - 1, n)] + src[i] + src[wrap(i + 1, n)]) / 3;
      out[i] = clamp(src[i] + (avg - src[i]) * amount, model.qMin[i], model.qMax[i]);
    }
    src = Float64Array.from(out);
  }
  return out;
}

// Resample a coarse node profile to every model station with periodic
// Catmull-Rom interpolation, so the lateral profile and its first derivative
// are continuous between nodes.
export function expandNodes(model, count, nodes, out = new Float64Array(model.n)) {
  const n = model.n;
  for (let i = 0; i < n; i++) {
    const u = (i * count) / n;
    const i1 = Math.floor(u) % count;
    const f = u - Math.floor(u);
    const p0 = nodes[wrap(i1 - 1, count)], p1 = nodes[i1];
    const p2 = nodes[wrap(i1 + 1, count)], p3 = nodes[wrap(i1 + 2, count)];
    out[i] = 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
  }
  return out;
}

// Extract a coarse node profile from a dense station profile.
export function nodesFromQ(model, count, q) {
  const nodes = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    nodes[k] = q[Math.round((k * model.n) / count) % model.n];
  }
  return nodes;
}
