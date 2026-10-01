// Export the track geometry the direct quasi-steady oracle needs:
//
//   * centreline stations (x, z, s) at a chosen spacing
//   * the per-station LEGAL corridor (qMin, qMax) from the real model
//   * the JS curvature estimator (cross-check only: Python recomputes Menger)
//   * the measured A-line offset (81.067 s bake) as a warm-start seed
//
// The Python oracle uses this so the corridor bounds are the real ones, not an
// assumed constant, and so the path basis is legal by construction.
//
//   node tools/export-track-geometry.mjs [--track harbor-ring] [--spacing 5]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname;
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createEnvelope } from '../src/ai/global/envelope.js';
import { RaceLine } from '../src/ai/race-line.js';
import { LINE } from '../src/tracks/lines/harbor-ring-gt-measured.js';

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const join = (...p) => path.join(...p);

const trackId = arg('track', 'harbor-ring');
const spacing = Number(arg('spacing', 5));
const spec = carSpecFor(arg('class', 'gt'));
const fuelKg = 20;
const mass = spec.mass + fuelKg;
const G = 9.81, RHO = 1.225;
const id = JSON.parse(fs.readFileSync(join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;
const dragAccel = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollAccel = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;
const curves = {
  latMax: id.tests.capability.map((c) => [c.v, c.latMax]),
  driveForce: id.tests.drive.bins.map((b) => [b.v, mass * (b.value + dragAccel(b.v) + rollAccel(b.v) + 0.33)]),
  brakeForce: id.tests.brake.bins.map((b) => [b.v, mass * b.value]),
};
const envelope = createEnvelope(spec, { fuelKg, wing: 6, curves });

const track = new Track(trackId === 'harbor-ring' ? 'harbor-ring' : null);
const model = buildTrackModel(track, { spacing });

// Reproduce the measured A-line on its own (dense) model so the offset can be
// sampled at the export stations, and check it against the recorded lap time.
const denseModel = buildTrackModel(track, { spacing: 0.5 });
const denseLine = new RaceLine(denseModel, envelope, {
  widths: LINE.widths, overlap: LINE.overlap, coeffs: LINE.coeffs, iterations: 14,
});
const denseQ = denseLine.q;
const L = track.length;
const sampleDense = (sv) => {
  const n = denseModel.n;
  const x = ((sv % L) + L) % L / denseModel.ds;
  const i = Math.min(n - 1, Math.floor(x));
  const j = (i + 1) % n;
  const t = x - i;
  return denseQ[i] + (denseQ[j] - denseQ[i]) * t;
};

const n = model.n;
const x = [], z = [], s = [], kappa = [], qMin = [], qMax = [], qMeasured = [];
for (let i = 0; i < n; i++) {
  x.push(+model.x[i].toFixed(4));
  z.push(+model.z[i].toFixed(4));
  s.push(+model.s[i].toFixed(4));
  kappa.push(+model.kappa[i].toFixed(8));
  qMin.push(+model.qMin[i].toFixed(4));
  qMax.push(+model.qMax[i].toFixed(4));
  qMeasured.push(+sampleDense(model.s[i]).toFixed(4));
}

const out = {
  generated: new Date().toISOString(),
  track: trackId,
  class: spec.key,
  length: +L.toFixed(4),
  spacing,
  stations: n,
  periodic: true,
  halfWidth: model.halfWidth,
  qLegal: model.qLegal,
  qPlan: model.qPlan,
  x, z, s, kappa, qMin, qMax, qMeasured,
  measured: {
    variant: LINE.variant,
    theoreticalTime: LINE.theoreticalTime,
    searchTime: LINE.searchTime,
    pathLength: LINE.pathLength,
    reproducedTime: +denseLine.time.toFixed(4),
    pathLengthReproduced: +denseLine.path.length.toFixed(3),
  },
};

const OUT = join(root, 'artifacts', arg('out', 'track-geometry.json'));
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}`);
console.log(`  ${trackId}: ${n} stations, ds ${(L / n).toFixed(3)} m, length ${L.toFixed(3)} m`);
console.log(`  corridor qLegal ${model.qLegal.toFixed(3)} m (qMin/qMax per station exported)`);
console.log(`  measured line reproduced: t ${denseLine.time.toFixed(4)} s vs recorded ${LINE.theoreticalTime} s, ` +
  `path ${denseLine.path.length.toFixed(1)} m vs recorded ${LINE.pathLength} m`);
console.log(`  qMeasured at export stations: min ${Math.min(...qMeasured).toFixed(2)} max ${Math.max(...qMeasured).toFixed(2)}`);
