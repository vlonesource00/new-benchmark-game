// Reference-operator audit and straight-physics trend.
//
// Separates the two errors the certification brief requires:
//   epsilon_operator = T_fast[V](x) - T_reference[V](x)      (successor search)
//   epsilon_repr     = valueAt(V,x) - T_reference[V](x)      (representation)
// and reports the free-straight physics against an independently integrated
// maximum-acceleration reference at two station spacings.
//
//   node tools/dp-reference-audit.mjs

import fs from 'node:fs';
import path from 'node:path';
import { carSpecFor } from '../src/sim/car-specs.js';
import { createSpatialOracle, makeCurve } from '../src/ai/global/spatial-oracle.js';

const root = process.cwd();
const spec = carSpecFor('gt');
const mass = spec.mass + 20;
const RHO = 1.225, G = 9.81;
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;

const id = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const dragA = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollA = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;
const netDrive = (v) => makeCurve(id.tests.drive.bins.map((b) => [b.v, b.value]))(v);
const netBrake = (v) => makeCurve(id.tests.brake.bins.map((b) => [b.v, b.value]))(v);
const netCoast = (v) => makeCurve(id.tests.coast.bins.map((b) => [b.v, b.value]))(v);
const curves = {
  latMax: id.tests.capability.map((c) => [c.v, c.latMax]),
  driveForce: id.tests.drive.bins.map((b) => [b.v, mass * (b.value + dragA(b.v) + rollA(b.v) + 0.33)]),
  brakeForce: id.tests.brake.bins.map((b) => [b.v, mass * b.value]),
};

function straightModel({ stations, ds, qPlan = 6 }) {
  const n = stations;
  const x = new Float64Array(n), z = new Float64Array(n);
  const nx = new Float64Array(n).fill(1), nz = new Float64Array(n), kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = i * ds;
  return { n, ds, x, z, nx, nz, kappa, qPlan, qLegal: qPlan, length: n * ds, open: true };
}

// High-resolution reference: RK4 on w'(s) = 2 a_drive(sqrt(w)).
function referenceProfile({ v0, distance, step = 0.05 }) {
  const aOf = (v) => netDrive(v);
  let w = v0 * v0, s = 0, t = 0;
  const push = [];
  while (s < distance - 1e-12) {
    const h = Math.min(step, distance - s);
    const f = (ww) => 2 * aOf(Math.sqrt(ww));
    const k1 = f(w);
    const k2 = f(w + 0.5 * h * k1);
    const k3 = f(w + 0.5 * h * k2);
    const k4 = f(w + h * k3);
    const wNext = w + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    const vMid = Math.sqrt(Math.max(0.01, 0.5 * (w + wNext)));
    const dt = h / vMid;
    s += h; t += dt; w = wNext;
    push.push([s, w]);
  }
  return { w, v: Math.sqrt(w), t, trace: push, step };
}

const QUERY_V = { kp: 2, kc: 2 }; // q index chosen per grid below

function auditAt(label, { stations, ds, dq, dW, wMax, certification = false }) {
  const model = straightModel({ stations, ds });
  const oracle = createSpatialOracle({
    model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet: netCoast,
    options: { qMax: 6, dq, dW, wMin: 16, wMax, open: true, certification },
  });
  const g = oracle.grid;
  const t0 = Date.now();
  const solved = oracle.solve({ mode: 'finish' });
  const solveMs = Date.now() - t0;
  const kMid = oracle.wToNode(0); // unused, keep lint quiet
  void kMid;
  const kp = Math.floor(g.QN / 2), kc = Math.floor(g.QN / 2);
  const v0 = 20;
  const distance = (g.n - 2) * model.ds;
  const ref = referenceProfile({ v0, distance });

  const rec = oracle.recoverOpen(solved.V, { start: { kp, kc, w: v0 * v0 }, startStation: 1, maxSteps: g.n - 1 });
  const rep = rec && rec.traj.length ? oracle.replay(rec.traj, { closed: false }) : null;
  const vFinal = rec && rec.traj.length ? rec.traj[rec.traj.length - 1].v : null;

  // --- operator error: fast vs reference on sampled continuous states
  const opErrs = [];
  const reprOnGrid = [], reprOffGrid = [];
  let sampled = 0;
  for (let i = 1; i < g.n - 1; i += Math.max(1, Math.round(g.n / 12))) {
    for (let s = 0; s < 40; s++) {
      const w = 60 + ((wMax - 60) * ((s * 37) % 40)) / 40;
      const fast = oracle.bellmanMinimizeFast(solved.V, i, kp, kc, w);
      const refM = oracle.bellmanMinimizeReference(solved.V, i, kp, kc, w);
      if (!fast.finite || !refM.finite) continue;
      sampled++;
      opErrs.push(fast.cost - refM.cost);
      const onGrid = oracle.valueAt(solved.V, i, kp, kc, w);
      reprOnGrid.push(onGrid - refM.cost);
      const wOff = w + dW * 0.37;
      const refOff = oracle.bellmanMinimizeReference(solved.V, i, kp, kc, wOff);
      if (refOff.finite) reprOffGrid.push(oracle.valueAt(solved.V, i, kp, kc, wOff) - refOff.cost);
    }
  }
  const stats = (arr) => {
    if (!arr.length) return { n: 0 };
    const a = [...arr].sort((x, y) => x - y);
    const abs = a.map(Math.abs).sort((x, y) => x - y);
    const mean = a.reduce((p, c) => p + c, 0) / a.length;
    return {
      n: a.length,
      meanSigned: +mean.toFixed(5),
      meanAbs: +(abs.reduce((p, c) => p + c, 0) / a.length).toFixed(5),
      p95: +abs[Math.min(abs.length - 1, Math.floor(0.95 * abs.length))].toFixed(5),
      p99: +abs[Math.min(abs.length - 1, Math.floor(0.99 * abs.length))].toFixed(5),
      max: +abs[abs.length - 1].toFixed(5),
    };
  };
  const out = {
    label,
    grid: { stations: g.n, ds: model.ds, QN: g.QN, WN: g.WN, dW, states: g.states },
    solveMs,
    dpFinalSpeed: vFinal,
    refFinalSpeed: +ref.v.toFixed(3),
    speedErr: vFinal === null ? null : +(vFinal - ref.v).toFixed(3),
    dpTime: rep && rep.ok ? +rep.time.toFixed(4) : null,
    refTime: +ref.t.toFixed(4),
    timeErr: rep && rep.ok ? +(rep.time - ref.t).toFixed(4) : null,
    operatorError: stats(opErrs),
    representationOnGrid: stats(reprOnGrid),
    representationOffGrid: stats(reprOffGrid),
  };
  console.log(`\n== ${label} ==`);
  console.log(`  grid n=${g.n} ds=${model.ds} QN=${g.QN} WN=${g.WN} states=${g.states}  solve ${solveMs} ms`);
  console.log(`  final speed DP ${vFinal === null ? 'n/a' : vFinal.toFixed(2)} vs reference ${out.refFinalSpeed}  (err ${out.speedErr})`);
  console.log(`  travel time DP ${out.dpTime} vs reference ${out.refTime}  (err ${out.timeErr})`);
  console.log(`  operator error   (fast - reference): mean ${out.operatorError.meanSigned} p95 ${out.operatorError.p95} max ${out.operatorError.max} over ${out.operatorError.n}`);
  console.log(`  repr error on-grid   : mean ${out.representationOnGrid.meanSigned} p95 ${out.representationOnGrid.p95} max ${out.representationOnGrid.max}`);
  console.log(`  repr error off-grid  : mean ${out.representationOffGrid.meanSigned} p95 ${out.representationOffGrid.p95} max ${out.representationOffGrid.max}`);
  return out;
}

const results = [];
results.push(auditAt('straight, fast operator, ds=10, dW=64', { stations: 60, ds: 10, dq: 3, dW: 64, wMax: 5400 }));
results.push(auditAt('straight, fast operator, ds=5, dW=64', { stations: 118, ds: 5, dq: 3, dW: 64, wMax: 5400 }));
results.push(auditAt('straight, fast operator, ds=5, dW=16', { stations: 118, ds: 5, dq: 3, dW: 16, wMax: 5400 }));
results.push(auditAt('straight, fast operator, ds=2, dW=8', { stations: 291, ds: 2, dq: 3, dW: 8, wMax: 5400 }));
results.push(auditAt('straight, REFERENCE operator, ds=5, dW=16', { stations: 118, ds: 5, dq: 3, dW: 16, wMax: 5400, certification: true }));

fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'stage05a-reference-audit.json'), JSON.stringify({
  generated: new Date().toISOString(), results,
}, null, 1));
console.log('\nwrote artifacts/stage05a-reference-audit.json');

