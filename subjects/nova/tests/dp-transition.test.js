// Unit tests for the spatial oracle's canonical transition.
// These are the cheap gates that must hold before any Harbor solve is trusted:
// geometry, longitudinal accounting (gross vs net, the double-drag bug class),
// combined-slip boundary and corridor masking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createSpatialOracle, mengerCurvature, makeCurve } from '../src/ai/global/spatial-oracle.js';

const circleTrack = (R, halfWidth = 60) => {
  const pts = [];
  const nPts = 256;
  for (let i = 0; i < nPts; i++) {
    const th = (i / nPts) * Math.PI * 2;
    pts.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) });
  }
  return new Track({
    id: 'test-circle', name: 'Test Circle', controlPoints: pts, sampleDensity: 4,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 8,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
};

// Measured-curve stand-ins with exactly known values so the accounting can be
// asserted numerically rather than eyeballed.
const CURVES = {
  latMax: [[10, 12], [20, 13], [40, 15], [60, 19]],
  driveForce: [[10, 10 * 1325], [20, 7 * 1325], [40, 5 * 1325], [60, 3 * 1325]],
  brakeForce: [[10, 13 * 1325], [20, 15 * 1325], [40, 20 * 1325], [60, 24 * 1325]],
};
const netDrive = (v) => makeCurve(CURVES.driveForce)(v) / 1325;
const netBrake = (v) => makeCurve(CURVES.brakeForce)(v) / 1325;
const coast = () => 1;

test('Menger curvature reproduces 1/R for three points on a circle', () => {
  const R = 75;
  const at = (th) => ({ x: R * Math.sin(th), z: R * Math.cos(th) });
  for (const dth of [0.2, 0.1, 0.05, 0.02]) {
    const k = mengerCurvature(at(-dth), at(0), at(dth));
    assert.ok(Math.abs(k - 1 / R) / (1 / R) < 1e-6, `kappa ${k} vs ${1 / R} at dth=${dth}`);
  }
  assert.equal(mengerCurvature({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }), 0);
});

test('Menger curvature is invariant to which side the arc bends', () => {
  const R = 120;
  const a = { x: -5, z: R - Math.sqrt(R * R - 25) };
  const b = { x: 0, z: 0 };
  const c = { x: 5, z: R - Math.sqrt(R * R - 25) };
  const k1 = mengerCurvature(a, b, c);
  const k2 = mengerCurvature({ x: a.x, z: -a.z }, { x: 0, z: 0 }, { x: c.x, z: -c.z });
  assert.ok(Math.abs(k1 - k2) < 1e-12);
  assert.ok(Math.abs(k1 - 1 / R) / (1 / R) < 1e-3);
});

test('straight-line transition reproduces the measured net drive and brake curves', () => {
  const model = buildTrackModel(circleTrack(4000, 200), { spacing: 4 });
  const oracle = createSpatialOracle({
    model,
    curves: CURVES,
    mass: 1325,
    driveNet: netDrive,
    brakeNet: netBrake,
    coastNet: coast,
    options: { qMax: 0, dW: 8 },
  });
  const kc = Math.floor(oracle.grid.QN / 2);
  const kp = kc, kn = kc;
  // Find a state near 30 m/s and probe the extreme feasible successors.
  const jw = Math.round((30 * 30 - oracle.grid.wMin) / oracle.grid.dW);
  let maxAccel = -Infinity, minAccel = Infinity;
  oracle.successorsFull(10, kp, kc, oracle.grid.wGrid[jw], (rec) => {
    maxAccel = Math.max(maxAccel, rec.aEff);
    minAccel = Math.min(minAccel, rec.aEff);
  });
  const vMid = Math.sqrt(oracle.grid.wGrid[jw]);
  const expectDrive = netDrive(vMid);
  const expectBrake = -netBrake(vMid);
  // The enumerated window is quantised by dW/(2 dL); allow one step of slack.
  const slack = oracle.grid.dW / (2 * oracle.model.ds) + 1e-6;
  assert.ok(maxAccel <= expectDrive + 1e-9, `accel ${maxAccel} exceeded measured ${expectDrive}`);
  assert.ok(maxAccel > expectDrive - slack, `accel ${maxAccel} fell short of measured ${expectDrive} by more than one step (${slack})`);
  assert.ok(minAccel >= expectBrake - 1e-9, `brake ${minAccel} exceeded measured ${expectBrake}`);
  assert.ok(minAccel < expectBrake + slack, `brake ${minAccel} fell short of measured ${expectBrake}`);
});

test('coast deceleration is always available and is not double counted', () => {
  const model = buildTrackModel(circleTrack(4000, 200), { spacing: 4 });
  const oracle = createSpatialOracle({
    model, curves: CURVES, mass: 1325, driveNet: netDrive, brakeNet: netBrake, coastNet: coast,
    options: { qMax: 0, dW: 8 },
  });
  const kc = Math.floor(oracle.grid.QN / 2);
  const jw = Math.round((30 * 30 - oracle.grid.wMin) / oracle.grid.dW);
  // aEff can only take multiples of dW/(2 dL), so "coast" is the reachable step
  // nearest -coast, not an exact float.
  const step = oracle.grid.dW / (2 * oracle.model.ds);
  let nearestToCoast = Infinity;
  oracle.successorsFull(10, kc, kc, oracle.grid.wGrid[jw], (rec) => {
    if (Math.abs(rec.aEff + 1) < Math.abs(nearestToCoast + 1)) nearestToCoast = rec.aEff;
  });
  assert.ok(Number.isFinite(nearestToCoast), 'some transition must exist');
  assert.ok(Math.abs(nearestToCoast + 1) <= step, `zero-pedal transition must be reachable: nearest aEff=${nearestToCoast}, step=${step}`);
  let minAtZeroThrottle = Infinity;
  oracle.successorsFull(10, kc, kc, oracle.grid.wGrid[jw], (rec) => { minAtZeroThrottle = Math.min(minAtZeroThrottle, rec.aEff); });
  assert.ok(minAtZeroThrottle >= -netBrake(Math.sqrt(oracle.grid.wGrid[jw])) - 1e-9);
});

test('combined slip uses the measured unit-circle boundary with no artificial floor', () => {
  const R = 70;
  const model = buildTrackModel(circleTrack(R, 60), { spacing: 4 });
  const oracle = createSpatialOracle({
    model, curves: CURVES, mass: 1325, driveNet: netDrive, brakeNet: netBrake, coastNet: coast,
    options: { qMax: 8, dW: 1, wMin: 400, wMax: 1600 },
  });
  const kMid = Math.floor(oracle.grid.QN / 2);
  let maxUy = 0, minFrac = Infinity, samples = 0;
  // Scan finely through the corner-speed region so the sample actually reaches
  // the lateral boundary (a coarse list of speeds can straddle it).
  const seen = new Set();
  for (let v = 26; v <= 36; v += 0.25) {
    const jw = Math.round((v * v - oracle.grid.wMin) / oracle.grid.dW);
    if (jw < 0 || jw >= oracle.grid.WN || seen.has(jw)) continue;
    seen.add(jw);
    for (let i = 4; i < 20; i += 3) {
      oracle.successorsFull(i, kMid, kMid, oracle.grid.wGrid[jw], (rec) => {
        samples++;
        maxUy = Math.max(maxUy, rec.uy);
        minFrac = Math.min(minFrac, rec.longFrac);
        // The measured law is a circle in normalised slip: ux^2 + uy^2 = 1.
        assert.ok(Math.abs(rec.longFrac * rec.longFrac + rec.uy * rec.uy - 1) < 1e-9,
          `ellipse identity broken: uy=${rec.uy} frac=${rec.longFrac}`);
      });
    }
  }
  assert.ok(samples > 0, 'expected feasible transitions in the sample');
  assert.ok(maxUy > 0.99, `sample must reach the lateral boundary, max uy=${maxUy}`);
  assert.ok(minFrac < 0.15, `no artificial longitudinal floor: min frac=${minFrac}`);
});

test('corridor mask is respected per station', () => {
  const model = buildTrackModel(circleTrack(100, 30), { spacing: 4 });
  const oracle = createSpatialOracle({
    model, curves: CURVES, mass: 1325, driveNet: netDrive, brakeNet: netBrake, coastNet: coast,
    options: { qMax: 10, dW: 8 },
  });
  const lim = model.qPlan;
  for (let i = 0; i < oracle.grid.n; i += 37) {
    for (let k = 0; k < oracle.grid.QN; k++) {
      const allowed = oracle.qAllowed[i * oracle.grid.QN + k] === 1;
      const legal = Math.abs(oracle.grid.qGrid[k]) <= lim + 1e-9;
      assert.equal(allowed, legal, `station ${i} q index ${k}`);
    }
  }
});




