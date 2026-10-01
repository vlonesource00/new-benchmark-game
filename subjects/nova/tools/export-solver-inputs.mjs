// Export the certified measured model for the direct optimal-control oracle.
//
// The Python solver must use the SAME identified curves as the JS oracle, so they
// are exported rather than re-derived: one source of truth for the plant.
//
//   node tools/export-solver-inputs.mjs

import fs from 'node:fs';
import path from 'node:path';
import { carSpecFor } from '../src/sim/car-specs.js';
import { makeCurve } from '../src/ai/global/spatial-oracle.js';

const root = process.cwd();
const spec = carSpecFor('gt');
const fuelKg = 20;
const mass = spec.mass + fuelKg;
const RHO = 1.225, G = 9.81;
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;

const id = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const dragA = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollA = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;

const out = {
  generated: new Date().toISOString(),
  purpose: 'shared plant model for tools/direct-oracle.py; mirrors src/ai/global/spatial-oracle.js',
  class: spec.key,
  mass,
  wheelbase: spec.wheelbase,
  halfWidth: spec.halfWidth,
  // Capability curves exactly as the JS oracle builds them.
  latMax: id.tests.capability.map((c) => [+c.v, +c.latMax]),
  driveNet: id.tests.drive.bins.map((b) => [+b.v, +b.value]),
  brakeNet: id.tests.brake.bins.map((b) => [+b.v, +b.value]),
  coastNet: id.tests.coast.bins.map((b) => [+b.v, +b.value]),
  // Convenience: gross drive acceleration (net + coast + engine braking), used to
  // convert between net and gross accounting unambiguously.
  driveGross: id.tests.drive.bins.map((b) => [+b.v, +(b.value + dragA(b.v) + rollA(b.v) + 0.33).toFixed(4)]),
  probe: {
    latMaxAt30: +makeCurve(id.tests.capability.map((c) => [c.v, c.latMax]))(30).toFixed(4),
    driveAt30: +makeCurve(id.tests.drive.bins.map((b) => [b.v, b.value]))(30).toFixed(4),
    brakeAt30: +makeCurve(id.tests.brake.bins.map((b) => [b.v, b.value]))(30).toFixed(4),
    coastAt30: +makeCurve(id.tests.coast.bins.map((b) => [b.v, b.value]))(30).toFixed(4),
  },
};

const OUT = path.join(root, 'artifacts', 'solver-inputs.json');
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}`);
for (const [k, v] of Object.entries(out.probe)) console.log(`  ${k} = ${v}`);
