import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { buildPath, expandNodes } from '../src/ai/global/path-geometry.js';

const TAU = Math.PI * 2;

// Synthetic closed circular model with the same conventions as TrackModel:
// +q is toward the centre of curvature when kappa > 0.
function circleModel(R = 200, spacing = 0.5) {
  const length = TAU * R;
  const n = Math.round(length / spacing);
  const ds = length / n;
  const x = new Float64Array(n), z = new Float64Array(n);
  const tx = new Float64Array(n), tz = new Float64Array(n);
  const nx = new Float64Array(n), nz = new Float64Array(n);
  const heading = new Float64Array(n), kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const th = (i * ds) / R;
    x[i] = R * Math.sin(th); z[i] = R * Math.cos(th);
    tx[i] = Math.cos(th); tz[i] = -Math.sin(th);
    nx[i] = tz[i]; nz[i] = -tx[i];
    heading[i] = Math.atan2(tx[i], tz[i]);
    kappa[i] = 1 / R;
  }
  return {
    id: 'circle', length, n, ds, halfWidth: 8, qLegal: 7, x, z, tx, tz, nx, nz, heading, kappa,
    point: () => { throw new Error('unused'); },
    index: (s) => Math.floor(((s % length) + length) % length / ds) % n,
    project: () => { throw new Error('unused'); },
    kappaAt: () => 1 / R,
    gripAt: () => 1,
    clampQ: (s, q) => q,
    sample: () => 0,
  };
}

test('TrackModel reproduces the Harbor Ring length', () => {
  const track = new Track('harbor-ring');
  const model = buildTrackModel(track);
  assert.ok(Math.abs(model.length - 2704.6192489145687) < 0.01, `length ${model.length}`);
  assert.equal(model.n, Math.round(track.length / 0.5));
  assert.ok(Math.abs(model.qLegal - (8.2 - 0.99)) < 1e-9);
});

test('Centerline path reproduces centreline geometry', () => {
  const track = new Track('harbor-ring');
  const model = buildTrackModel(track);
  const q = new Float64Array(model.n);
  const path = buildPath(model, q);
  assert.ok(Math.abs(path.length - model.length) / model.length < 0.002, `path ${path.length} vs ${model.length}`);
  // Both curvature fields are independent estimates of the same underlying
  // curve; at Catmull-Rom node joins they smooth discontinuities differently,
  // so compare the distribution rather than the single worst station.
  const errors = [];
  for (let i = 0; i < model.n; i++) errors.push(Math.abs(path.kappa[i] - model.kappa[i]));
  errors.sort((a, b) => a - b);
  const median = errors[errors.length >> 1];
  const p99 = errors[Math.floor(errors.length * 0.99)];
  assert.ok(median < 0.003, `median curvature error ${median}`);
  assert.ok(p99 < 0.02, `p99 curvature error ${p99}`);
});

test('Offset curve on a circle matches analytic length and curvature', () => {
  const R = 200;
  const model = circleModel(R);
  for (const q0 of [-6, -2, 0, 3, 6]) {
    const q = new Float64Array(model.n).fill(q0);
    const path = buildPath(model, q);
    const expectedLength = TAU * (R - q0);
    assert.ok(Math.abs(path.length - expectedLength) / expectedLength < 1e-3, `q=${q0} length ${path.length} vs ${expectedLength}`);
    const expectedKappa = 1 / (R - q0);
    let mean = 0;
    for (let i = 0; i < path.n; i++) mean += path.kappa[i];
    mean /= path.n;
    assert.ok(Math.abs(mean - expectedKappa) < 1e-4 * expectedKappa + 1e-6, `q=${q0} kappa ${mean} vs ${expectedKappa}`);
  }
});

test('Node expansion is periodic and respects interpolation between nodes', () => {
  const R = 200;
  const model = circleModel(R);
  const count = 64;
  const nodes = new Float64Array(count);
  for (let k = 0; k < count; k++) nodes[k] = Math.sin((k / count) * TAU) * 6;
  const q = expandNodes(model, count, nodes);
  assert.equal(q.length, model.n);
  let min = Infinity, max = -Infinity;
  for (const v of q) { min = Math.min(min, v); max = Math.max(max, v); }
  assert.ok(min > -6.5 && max < 6.5);
  // Smoothness: second difference of the interpolated profile stays bounded.
  let maxJump = 0;
  for (let i = 0; i < model.n; i++) {
    const a = q[(i - 1 + model.n) % model.n], b = q[i], c = q[(i + 1) % model.n];
    maxJump = Math.max(maxJump, Math.abs(a - 2 * b + c));
  }
  assert.ok(maxJump < 0.02, `second difference ${maxJump}`);
});
