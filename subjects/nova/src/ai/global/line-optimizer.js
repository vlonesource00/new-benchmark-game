// DeepSeek Global Line Optimiser
// Multi-scale smooth parameterisation of the lateral profile:
//
//   q(s) = sum_k  c_k * raisedCosine(s; centre_k, width_k)
//
// with bump widths from 96 m down to 12 m. Descending on the coefficients
// cannot produce a jagged line, so every candidate is drivable by construction;
// curvature is bounded by the basis itself.
//
//   Stage G  minimise curvature energy (cheap, well conditioned)
//   Stage T  descend on real injected lap time from the full speed profile
//
// Seeds: centreline, inside line, delayed-apex inside line. The best line wins.

import { buildPath, expandNodes, nodesFromQ } from './path-geometry.js';
import { speedProfile } from './speed-profile.js';
import { clamp, wrap } from '../../sim/math.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// --- basis -----------------------------------------------------------------

export function makeBasis(model, { widths = [96, 48, 24, 12], overlap = 2 } = {}) {
  const centres = [];
  const widthOf = [];
  for (const w of widths) {
    const step = w / overlap;
    const count = Math.max(2, Math.round(model.length / step));
    for (let k = 0; k < count; k++) {
      centres.push((k * model.length) / count);
      widthOf.push(w);
    }
  }
  return { centres, widths: widthOf, count: centres.length, overlap, widthList: widths };
}

// Bump evaluation uses the exact metric offset from the centre to each station,
// so a coefficient vector expands to the same continuous profile at every
// station density (fixed station-count windows would be phase-inconsistent).
function addBump(model, centre, width, amount, out) {
  if (amount === 0) return;
  const span = Math.ceil(width / model.ds);
  const i0 = model.index(centre - width);
  for (let k = 0; k <= 2 * span; k++) {
    const i = (i0 + k) % model.n;
    const off = wrap(i * model.ds - centre + model.length / 2, model.length) - model.length / 2;
    const x = off / width;
    if (x <= -1 || x >= 1) continue;
    out[i] += amount * 0.5 * (1 + Math.cos(Math.PI * x));
  }
}

export function expandBumps(model, basis, coeffs, out = new Float64Array(model.n)) {
  out.fill(0);
  const { centres, widths, count } = basis;
  for (let k = 0; k < count; k++) addBump(model, centres[k], widths[k], coeffs[k], out);
  return out;
}

export function fitBumps(basis, model, profile) {
  const coeffs = new Float64Array(basis.count);
  const residual = Float64Array.from(profile);
  const scratch = new Float64Array(model.n);
  const widthOrder = [...new Set(basis.widths)].sort((a, b) => b - a);
  for (const w of widthOrder) {
    scratch.fill(0);
    for (let k = 0; k < basis.count; k++) {
      if (basis.widths[k] !== w) continue;
      const c = clamp(residual[model.index(basis.centres[k])], -model.qPlan, model.qPlan);
      coeffs[k] = c;
      addBump(model, basis.centres[k], w, c, scratch);
    }
    for (let i = 0; i < model.n; i++) residual[i] -= scratch[i];
  }
  return coeffs;
}

// --- objectives ------------------------------------------------------------

function violation(model, q) {
  let worst = 0;
  for (let i = 0; i < model.n; i++) {
    const over = Math.abs(q[i]) - model.qPlan;
    if (over > worst) worst = over;
  }
  return worst;
}

const violationCost = (over) => (over > 0 ? 50 * over + 1e4 * over * over : 0);

// A real car cannot track a path whose curvature oscillates station to station:
// penalising the squared curvature rate removes the "line chatter" that a
// purely time-based search happily creates by shaving path length.
function jerkPenalty(model, path, weight) {
  if (weight <= 0) return 0;
  let total = 0;
  for (let i = 0; i < model.n; i++) {
    const j = (i + 1) % model.n;
    const rate = (path.kappa[j] - path.kappa[i]) / Math.max(0.05, path.ds[i]);
    total += rate * rate * path.ds[i];
  }
  return weight * total;
}

function geometryCost(model, basis, coeffs, q, jerkWeight) {
  expandBumps(model, basis, coeffs, q);
  const over = violation(model, q);
  if (over > 0) return violationCost(over) + 1e3;
  const path = buildPath(model, q);
  let energy = 0;
  for (let i = 0; i < model.n; i++) energy += path.kappa[i] * path.kappa[i] * path.ds[i];
  return energy + 1e-4 * path.length + jerkPenalty(model, path, jerkWeight);
}

function timeCost(model, envelope, basis, coeffs, q, iterations, jerkWeight) {
  expandBumps(model, basis, coeffs, q);
  const over = violation(model, q);
  if (over > 0) return violationCost(over) + 1e3;
  const path = buildPath(model, q);
  const time = speedProfile(path, envelope, { iterations }).time;
  return (Number.isFinite(time) ? time : 1e9) + jerkPenalty(model, path, jerkWeight);
}

function descend(model, basis, coeffs, deltas, evaluate, rand, passesPerDelta) {
  const count = basis.count;
  const limit = model.qPlan;
  const order = new Uint16Array(count);
  for (let k = 0; k < count; k++) order[k] = k;
  let best = evaluate();
  for (const delta of deltas) {
    for (let pass = 0; pass < passesPerDelta; pass++) {
      for (let k = count - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [order[k], order[j]] = [order[j], order[k]];
      }
      let improved = false;
      for (const k of order) {
        const original = coeffs[k];
        let current = original;
        for (const sign of [1, -1]) {
          const trial = clamp(current + sign * delta, -limit, limit);
          if (trial === current) continue;
          coeffs[k] = trial;
          const cost = evaluate();
          if (cost < best - 1e-9) { best = cost; current = trial; improved = true; }
          else coeffs[k] = current;
        }
      }
      if (!improved) break;
    }
  }
  return best;
}

// Scale a fitted coefficient vector back until the expanded profile is legal.
export function repair(model, basis, coeffs, q) {
  expandBumps(model, basis, coeffs, q);
  let over = violation(model, q);
  if (over <= 0) return coeffs;
  let lo = 0, hi = 1;
  const scaled = new Float64Array(coeffs.length);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    for (let k = 0; k < coeffs.length; k++) scaled[k] = coeffs[k] * mid;
    expandBumps(model, basis, scaled, q);
    if (violation(model, q) > 0) hi = mid; else lo = mid;
  }
  for (let k = 0; k < coeffs.length; k++) coeffs[k] *= lo;
  expandBumps(model, basis, coeffs, q);
  return coeffs;
}

// --- seeds -----------------------------------------------------------------

export function centerlineCoeffs(basis) {
  return new Float64Array(basis.count);
}

// Radius-aware inside seed, then fitted onto the smooth basis.
export function insideSeedCoeffs(model, basis, { factor = 0.75, shift = 0, windowM = 24, radiusMargin = 4 } = {}) {
  const n = model.n;
  const raw = new Float64Array(n);
  const shiftStations = Math.round(shift / model.ds);
  for (let i = 0; i < n; i++) {
    const kappa = model.kappa[wrap(i + shiftStations, n)];
    const radius = Math.abs(kappa) > 1e-6 ? 1 / Math.abs(kappa) : Infinity;
    const insideLimit = Math.min(model.qPlan, Math.max(0, radius - radiusMargin)) * factor;
    const strength = clamp((Math.abs(kappa) - 0.002) / 0.012, 0, 1);
    raw[i] = Math.sign(kappa || 0) * insideLimit * strength;
  }
  const half = Math.max(1, Math.round(windowM / (2 * model.ds)));
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += raw[wrap(i + k, n)];
    smooth[i] = sum / (2 * half + 1);
  }
  return fitBumps(basis, model, smooth);
}

// --- driver ----------------------------------------------------------------

export function optimizeLine(model, envelope, {
  widths = [96, 48, 24, 12],
  overlap = 2,
  seed = 1234,
  seedLabels = ['centre', 'inside-late'],
  geometryDeltas = [3, 1.5, 0.7, 0.3],
  jerkWeight = 8,
  timeDeltas = [2.0, 1.0, 0.5, 0.2],
  outerIterations = 3,
  searchIterations = 5,
  refineIterations = 14,
  geometryPasses = 2,
  timePasses = 3,
  onProgress = null,
} = {}) {
  const basis = makeBasis(model, { widths, overlap });
  const rand = rng(seed);
  const q = new Float64Array(model.n);
  const seedPool = {
    centre: { label: 'centre', coeffs: centerlineCoeffs(basis) },
    'inside-late': { label: 'inside-late', coeffs: null },
  };
  const seeds = seedLabels.map((label) => {
    if (label === 'inside-late') {
      return { label, coeffs: repair(model, basis, insideSeedCoeffs(model, basis, { factor: 0.85, shift: 16 }), q) };
    }
    return seedPool.centre;
  });
  let overall = null;
  for (const s of seeds) {
    const coeffs = Float64Array.from(s.coeffs);
    descend(model, basis, coeffs, geometryDeltas, () => geometryCost(model, basis, coeffs, q, jerkWeight), rand, geometryPasses);
    if (onProgress) onProgress({ stage: 'geometry', seed: s.label, time: timeCost(model, envelope, basis, coeffs, q, searchIterations, jerkWeight) });
    let bestLocal = { coeffs: Float64Array.from(coeffs), time: timeCost(model, envelope, basis, coeffs, q, searchIterations, jerkWeight) };
    for (let outer = 0; outer < outerIterations; outer++) {
      descend(model, basis, coeffs, timeDeltas, () => timeCost(model, envelope, basis, coeffs, q, searchIterations + outer, jerkWeight), rand, timePasses);
      const time = timeCost(model, envelope, basis, coeffs, q, refineIterations, jerkWeight);
      if (time < bestLocal.time) bestLocal = { coeffs: Float64Array.from(coeffs), time };
      if (onProgress) onProgress({ stage: 'outer', seed: s.label, outer, time });
    }
    if (onProgress) onProgress({ stage: 'seed-done', seed: s.label, time: bestLocal.time });
    if (Number.isFinite(bestLocal.time) && (!overall || bestLocal.time < overall.time)) overall = bestLocal;
  }
  if (!overall) throw new Error('line optimisation produced no feasible line');
  expandBumps(model, basis, overall.coeffs, q);
  const path = buildPath(model, q);
  const profile = speedProfile(path, envelope, { iterations: refineIterations });
  return {
    basis,
    widths,
    overlap,
    coeffs: overall.coeffs,
    q,
    time: profile.time,
    cost: overall.cost,
    path,
    profile,
    nodes: nodesFromQ(model, Math.round(model.length / 4), q),
  };
}

export { expandNodes };
