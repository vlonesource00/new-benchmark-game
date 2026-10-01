// DeepSeek Track Model
// A dense, station-indexed representation of the circuit. This is the AI's
// private track intelligence layer: it never mutates the physical Track and it
// can be rebuilt from any host providing the same control-point geometry.
//
// Conventions (identical to the Astra-derived plant):
//   +s    arc length along the track centreline, wraps at track.length
//   +q    lateral offset along the centreline normal n = (tz, -tx)
//         (n points to the inside of the turn when kappa > 0)
//   +yaw  heading = atan2(tx, tz), forward = (sin yaw, cos yaw)
//
// Everything downstream (line optimisation, speed profile, control, racecraft)
// consumes this model, never the raw Track.

import { wrap, clamp } from '../sim/math.js';

const smooth = (a, i, n, w) => {
  let sum = 0, count = 0;
  for (let k = -w; k <= w; k++) { sum += a[wrap(i + k, n)]; count++; }
  return sum / count;
};

const cubic = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

// Evaluate the circuit's control-point spline directly at the requested
// station spacing. Sampling `track.at()` instead would inherit the coarse node
// interpolation, whose curvature is station-density dependent; the analytic
// spline is what the vehicle actually drives on.
function analyticCentreline(track, spacing) {
  const control = track.scenario.controlPoints.map((p) => [p.x, p.z]);
  const dense = [];
  let s = 0;
  for (let i = 0; i < control.length; i++) {
    const a = control[wrap(i - 1, control.length)], b = control[i];
    const c = control[(i + 1) % control.length], d = control[(i + 2) % control.length];
    const estimate = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const steps = Math.max(4, Math.ceil((estimate / spacing) * 4));
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      const x = cubic(a[0], b[0], c[0], d[0], t), z = cubic(a[1], b[1], c[1], d[1], t);
      const last = dense.at(-1);
      if (last) s += Math.hypot(x - last.x, z - last.z);
      dense.push({ x, z, s });
    }
  }
  const first = dense[0], last = dense.at(-1);
  const total = s + Math.hypot(last.x - first.x, last.z - first.z);
  const n = Math.max(16, Math.round(total / spacing));
  const ds = total / n;
  const out = { n, ds, length: total, x: new Float64Array(n), z: new Float64Array(n) };
  // Uniform resample in arc length.
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const target = i * ds;
    while (cursor < dense.length - 2 && dense[cursor + 1].s < target) cursor++;
    const a = dense[cursor], b = dense[Math.min(cursor + 1, dense.length - 1)];
    const span = Math.max(1e-6, b.s - a.s);
    const f = clamp((target - a.s) / span, 0, 1);
    out.x[i] = a.x + (b.x - a.x) * f;
    out.z[i] = a.z + (b.z - a.z) * f;
  }
  return out;
}

export function buildTrackModel(track, {
  spacing = 0.5,
  halfCarWidth = 0.99,
  kerbAllowance = 0.0,
} = {}) {
  const length = track.length;
  const n = Math.max(16, Math.round(length / spacing));
  const ds = length / n;
  const x = new Float64Array(n), z = new Float64Array(n);
  const tx = new Float64Array(n), tz = new Float64Array(n);
  const nx = new Float64Array(n), nz = new Float64Array(n);
  const heading = new Float64Array(n);
  const rawKappa = new Float64Array(n);
  const kappa = new Float64Array(n);
  const turnSign = new Float64Array(n);
  const s = new Float64Array(n);

  if (track.scenario?.controlPoints) {
    const centre = analyticCentreline(track, spacing);
    for (let i = 0; i < n; i++) {
      const j = Math.min(centre.n - 1, Math.round((i * centre.n) / n) % centre.n);
      x[i] = centre.x[j]; z[i] = centre.z[j]; s[i] = i * ds;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = track.at(i * ds);
      s[i] = i * ds;
      x[i] = p.x; z[i] = p.z;
    }
  }
  // Tangent, heading, normal and curvature use the same metric estimators as
  // path-geometry.js, so the model's centreline and a q = 0 path agree.
  const spanStations = Math.max(1, Math.round(3.0 / ds));
  for (let i = 0; i < n; i++) {
    const a = wrap(i - spanStations, n), b = wrap(i + spanStations, n);
    const dx = x[b] - x[a], dz = z[b] - z[a];
    const d = Math.hypot(dx, dz);
    tx[i] = dx / d; tz[i] = dz / d;
    nx[i] = tz[i]; nz[i] = -tx[i];
    heading[i] = Math.atan2(tx[i], tz[i]);
  }
  for (let i = 0; i < n; i++) {
    const a = wrap(i - spanStations, n), b = wrap(i + spanStations, n);
    const chord = Math.max(0.05, Math.hypot(x[b] - x[a], z[b] - z[a]));
    const d0 = wrap(heading[i] - heading[a] + Math.PI, 2 * Math.PI) - Math.PI;
    const d1 = wrap(heading[b] - heading[i] + Math.PI, 2 * Math.PI) - Math.PI;
    rawKappa[i] = (d0 + d1) / chord;
  }
  for (let i = 0; i < n; i++) kappa[i] = rawKappa[i];
  for (let i = 0; i < n; i++) turnSign[i] = Math.abs(kappa[i]) < 1e-6 ? 1 : Math.sign(kappa[i]);

  const halfWidth = track.halfWidth;
  const qLegal = Math.max(0.2, halfWidth - halfCarWidth + kerbAllowance);
  // Planning corridor keeps a control margin inside the legal corridor so the
  // line never sits exactly on the track-limit boundary. The margin is sized
  // from the achievable tracking accuracy, not from a round number: the driver
  // may run a few decimetres wide at the limit, and a line on the boundary
  // turns every small error into an off-track.
  const qPlan = Math.max(0.2, qLegal - 0.8);
  const qMin = new Float64Array(n).fill(-qLegal);
  const qMax = new Float64Array(n).fill(qLegal);

  // Spatial hash for nearest-point queries from arbitrary world positions.
  const cell = 30;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(x[i] / cell)},${Math.floor(z[i] / cell)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, list = []);
    list.push(i);
  }

  const model = {
    id: track.id,
    name: track.name,
    length,
    n,
    ds,
    halfWidth,
    curbWidth: track.curbWidth,
    qLegal,
    qPlan,
    x, z, tx, tz, nx, nz, heading, kappa, turnSign, s, qMin, qMax,
    finishS: track.finishS,
    gridS: track.gridS,
    // Centreline normal offset position.
    point(sv, q = 0) {
      const i = model.index(sv);
      const t = wrap(sv, length) / ds - i;
      const j = wrap(i + 1, n);
      const cx = x[i] + (x[j] - x[i]) * t, cz = z[i] + (z[j] - z[i]) * t;
      const nnx = nx[i] + (nx[j] - nx[i]) * t, nnz = nz[i] + (nz[j] - nz[i]) * t;
      return { x: cx + nnx * q, z: cz + nnz * q, nx: nnx, nz: nnz, heading: heading[i] + wrap(heading[j] - heading[i] + Math.PI, 2 * Math.PI) - Math.PI };
    },
    index(sv) {
      let i = Math.floor(wrap(sv, length) / ds) % n;
      if (i < 0) i += n;
      return i;
    },
    // World -> (s, q) projection using the spatial hash.
    project(px, pz) {
      const gx = Math.floor(px / cell), gz = Math.floor(pz / cell);
      let best = Infinity, index = -1;
      for (let dx = -1; dx <= 1 && index < 0; dx++) for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${gx + dx},${gz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const d = (x[i] - px) ** 2 + (z[i] - pz) ** 2;
          if (d < best) { best = d; index = i; }
        }
      }
      if (index < 0) {
        for (let i = 0; i < n; i++) {
          const d = (x[i] - px) ** 2 + (z[i] - pz) ** 2;
          if (d < best) { best = d; index = i; }
        }
      }
      const along = (px - x[index]) * tx[index] + (pz - z[index]) * tz[index];
      const sv = wrap(index * ds + along, length);
      const qi = (px - x[index]) * nx[index] + (pz - z[index]) * nz[index];
      return { s: sv, q: qi, index: model.index(sv) };
    },
    kappaAt(sv) {
      const i = model.index(sv);
      return kappa[i];
    },
    gripAt(sv, q = 0) {
      // Asphalt inside the road, kerb grip beyond it (planning stays legal).
      const a = Math.abs(q);
      if (a <= halfWidth) return 1;
      if (a <= halfWidth + track.curbWidth) return 0.88;
      return 0.52;
    },
    clampQ(sv, q) {
      const i = model.index(sv);
      return clamp(q, qMin[i], qMax[i]);
    },
    // Sample an interpolated value array at station s.
    sample(array, sv) {
      const i = model.index(sv);
      const j = wrap(i + 1, n);
      const t = clamp(wrap(sv, length) / ds - Math.floor(wrap(sv, length) / ds), 0, 1);
      return array[i] + (array[j] - array[i]) * t;
    },
  };
  return model;
}
