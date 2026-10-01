import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { buildPath, expandNodes } from '../src/ai/global/path-geometry.js';
import { speedProfile } from '../src/ai/global/speed-profile.js';
import { CAR_CLASSES } from '../src/sim/car-specs.js';
import { makeBasis, expandBumps, insideSeedCoeffs, repair } from '../src/ai/global/line-optimizer.js';

test('Envelope is finite, monotone and physically plausible', () => {
  const env = createEnvelope(CAR_CLASSES.gt, {});
  assert.ok(env.latMax(20) > 12, `lat at 20 m/s ${env.latMax(20)}`);
  assert.ok(env.latMax(70) > env.latMax(20), 'downforce raises lateral capability');
  assert.ok(env.brakeMax(50) > 10, `brake at 50 m/s ${env.brakeMax(50)}`);
  assert.ok(env.brakeMax(50) < 30);
  assert.ok(env.driveMax(30) > 2 && env.driveMax(30) < 12);
  assert.ok(env.vMax > 250 / 3.6 && env.vMax < 340 / 3.6, `vmax ${env.vMax * 3.6} km/h`);
  // Combined slip: full lateral usage removes longitudinal capability.
  assert.ok(env.brakeMax(50, env.latMax(50)) < env.brakeMax(50, 0) * 0.5);
});

test('Speed profile respects curvature, braking and drive limits', () => {
  const track = new Track('harbor-ring');
  const model = buildTrackModel(track, { spacing: 1 });
  const env = createEnvelope(CAR_CLASSES.gt, {});
  const q = new Float64Array(model.n);
  const path = buildPath(model, q);
  const profile = speedProfile(path, env, { iterations: 12 });
  assert.ok(profile.time > 60 && profile.time < 110, `centreline time ${profile.time}`);
  let maxLatUsage = 0, brakeViolations = 0, driveViolations = 0;
  for (let i = 0; i < model.n; i++) {
    const lat = profile.v[i] * profile.v[i] * Math.abs(path.kappa[i]);
    maxLatUsage = Math.max(maxLatUsage, lat / env.latMax(profile.v[i]));
    const j = (i + 1) % model.n;
    const a = (profile.v[j] * profile.v[j] - profile.v[i] * profile.v[i]) / (2 * path.ds[i]);
    if (a < 0) {
      if (-a > env.brakeMax(profile.v[i], lat) * 1.02) brakeViolations++;
    } else if (a > env.driveMax(profile.v[i], lat) * 1.02) driveViolations++;
  }
  assert.ok(maxLatUsage <= 1.005, `max lateral usage ${maxLatUsage}`);
  assert.equal(brakeViolations, 0);
  assert.equal(driveViolations, 0);
});

test('Inside seed is legal, fold-free and finite-time', () => {
  const track = new Track('harbor-ring');
  const model = buildTrackModel(track, { spacing: 1.5 });
  const env = createEnvelope(CAR_CLASSES.gt, {});
  const basis = makeBasis(model, { widths: [96, 48, 24, 12] });
  const q = new Float64Array(model.n);
  const coeffs = repair(model, basis, insideSeedCoeffs(model, basis, { factor: 0.85, shift: 16 }), q);
  expandBumps(model, basis, coeffs, q);
  for (let i = 0; i < q.length; i++) {
    assert.ok(Math.abs(q[i]) <= model.qLegal + 1e-9, `q ${q[i]} exceeds the legal corridor`);
  }
  const path = buildPath(model, q);
  let maxK = 0;
  for (const k of path.kappa) maxK = Math.max(maxK, Math.abs(k));
  assert.ok(maxK < 0.35, `max curvature ${maxK}`);
  const profile = speedProfile(path, env, { iterations: 12 });
  assert.ok(profile.time > 60 && profile.time < 200, `seed time ${profile.time}`);
});
