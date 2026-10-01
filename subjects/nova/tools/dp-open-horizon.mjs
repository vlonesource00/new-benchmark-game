// Open-horizon sanity tests. These isolate longitudinal correctness from periodic
// closure, which the stadium test confounds:
//
//   1. straight, free terminal   -> must accelerate at the maximum physically
//      feasible rate; compared against a direct forward rollout of the measured
//      net drive curve
//   2. straight, terminal speed cap -> isolates backward braking propagation;
//      compared against a backward rollout of the measured brake curve
//   3. stadium, free terminal    -> accelerate / brake / corner / accelerate
//   4. reduced vs dense Bellman  -> measures the candidate-set error
//
// Certification gate for 1-3: table value == summed policy cost == independent
// replay, to 1e-3 s.
//
//   node tools/dp-open-horizon.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createSpatialOracle, makeCurve } from '../src/ai/global/spatial-oracle.js';

const root = process.cwd();
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
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

// --- synthetic straight model ------------------------------------------------
// Avoids the hairpin entirely: a genuine straight with no curvature and no wrap
// interference beyond the terminal station.
function straightModel({ stations = 60, ds = 10, qPlan = 6 } = {}) {
  const n = stations;
  const x = new Float64Array(n), z = new Float64Array(n);
  const nx = new Float64Array(n), nz = new Float64Array(n);
  const kappa = new Float64Array(n);
  const qPl = new Float64Array(n).fill(qPlan);
  for (let i = 0; i < n; i++) { x[i] = 0; z[i] = i * ds; nx[i] = 1; nz[i] = 0; }
  return { n, ds, x, z, nx, nz, kappa, qPlan: qPl, qLegal: new Float64Array(n).fill(qPlan), length: n * ds, open: true };
}

function stadium({ straight = 300, radius = 60, halfWidth = 40, id: tid = 'lab' } = {}) {
  const pts = [];
  for (let z = -straight / 2; z <= straight / 2; z += 50) pts.push({ x: 0, y: 0, z });
  for (let i = 1; i < 16; i++) { const a = Math.PI - (i / 16) * Math.PI; pts.push({ x: radius + radius * Math.cos(a), y: 0, z: straight / 2 + radius * Math.sin(a) }); }
  for (let z = straight / 2; z >= -straight / 2; z -= 50) pts.push({ x: 2 * radius, y: 0, z });
  for (let i = 1; i < 16; i++) { const a = (i / 16) * Math.PI; pts.push({ x: radius + radius * Math.cos(a), y: 0, z: -straight / 2 + radius * Math.sin(a) }); }
  return new Track({
    id: tid, name: tid, controlPoints: pts, sampleDensity: 8,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 10,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}

// --- forward / backward rollouts for reference ------------------------------
function rollout({ v0, distance, accel, step = 0.25 }) {
  let v = v0, s = 0, t = 0;
  const trace = [[0, v, 0]];
  while (s < distance - 1e-9) {
    const a = accel(v);
    const dsStep = Math.min(step, distance - s);
    const vNext = Math.sqrt(Math.max(1, v * v + 2 * a * dsStep));
    t += (2 * dsStep) / (v + vNext);
    s += dsStep; v = vNext;
    trace.push([s, v, t]);
  }
  return { v: v, t, trace };
}
function brakeEnvelope({ vTerminal, distance, decel, step = 0.25 }) {
  // Largest speed at a given DISTANCE FROM THE END that can still make vTerminal.
  // Indexed from the terminal outward, so env[0] = vTerminal.
  let v = vTerminal, s = 0;
  const pts = [[0, v]];
  while (s < distance - 1e-9) {
    const a = decel(v);
    const dsStep = Math.min(step, distance - s);
    v = Math.sqrt(Math.max(1, v * v + 2 * a * dsStep));
    s += dsStep;
    pts.push([s, v]);
  }
  return pts;
}

const results = [];
function gate(name, checks, extra = {}) {
  const failed = checks.filter((c) => !c.pass);
  results.push({ name, checks, ...extra, passed: failed.length === 0 });
  console.log(`\n== ${name} ==`);
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? ` -- ${c.detail}` : ''}`);
  return failed.length === 0;
}

const stateLabel = (o, i, kp, kc, w) => `station ${i} q=${o.grid.qGrid[kc].toFixed(2)} v=${Math.sqrt(w).toFixed(2)}`;

// --- 1. straight, free terminal ---------------------------------------------
{
  const model = straightModel({ stations: 60, ds: 10 });
  const oracle = createSpatialOracle({ model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet: netCoast,
    options: { qMax: 6, dq: 2.4, dW: 16, wMin: 16, wMax: 5400, open: !!model.open } });
  const solved = oracle.solve({ mode: 'finish' });
  const g = oracle.grid;
  const kMid = Math.floor(g.QN / 2);
  const v0 = 20, w0 = v0 * v0;
  const start = { kp: kMid, kc: kMid, w: w0 };
  const rec = oracle.recoverOpen(solved.V, { start, startStation: 1, maxSteps: g.n - 1 });
  const rep = rec && rec.traj.length ? oracle.replay(rec.traj, { closed: false }) : null;
  const tableVal = oracle.valueAt(solved.V, 1, kMid, kMid, w0);
  let policyCost = 0;
  for (let k = 0; k < (rec?.traj.length ?? 0) - 1; k++) {
    const a = rec.traj[k], b = rec.traj[k + 1];
    const tr = oracle.transitionW(a.i, a.kp, a.kc, a.w, b.kc, b.w);
    if (tr) policyCost += tr.dt;
  }
  const distance = (model.n - 2) * model.ds; // stations 1..59 -> 58 segments of 10 m
  const roll = rollout({ v0, distance, accel: netDrive });
  const vFinal = rec && rec.traj.length ? rec.traj[rec.traj.length - 1].v : 0;
  void stateLabel;
  gate('straight, free terminal (from 20 m/s over 580 m)', [
    { label: 'trajectory complete', pass: !!rec && rec.complete, detail: rec ? `${rec.traj?.length ?? 0}/${g.n - 1} stations` : 'no recovery' },
    { label: 'table == policy cost (1e-3)', pass: Number.isFinite(tableVal) && Math.abs(tableVal - policyCost) < 1e-3, detail: `table ${tableVal.toFixed(4)} vs policy ${policyCost.toFixed(4)}` },
    { label: 'policy == replay (1e-3)', pass: !!rep && rep.ok && Math.abs(rep.time - policyCost) < 1e-3, detail: rep && rep.ok ? `replay ${rep.time.toFixed(4)} vs policy ${policyCost.toFixed(4)}` : 'replay failed' },
    { label: 'final speed matches the forward rollout', pass: Math.abs(vFinal - roll.v) < 0.35, detail: `DP ${vFinal.toFixed(2)} vs rollout ${roll.v.toFixed(2)} m/s` },
    { label: 'travel time matches the forward rollout', pass: Math.abs(policyCost - roll.t) < 0.05, detail: `DP ${policyCost.toFixed(3)} vs rollout ${roll.t.toFixed(3)} s` },
  ]);
}

// --- 2. straight, terminal speed cap (backward braking) ---------------------
{
  const model = straightModel({ stations: 60, ds: 10 });
  const oracle = createSpatialOracle({ model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet: netCoast,
    options: { qMax: 6, dq: 2.4, dW: 16, wMin: 16, wMax: 5400, open: !!model.open } });
  const vTerm = 20;
  const solved = oracle.solve({ mode: 'finish', terminalW: vTerm * vTerm });
  const g = oracle.grid;
  const kMid = Math.floor(g.QN / 2);
  const v0 = 45;
  const start = { kp: kMid, kc: kMid, w: v0 * v0 };
  const rec = oracle.recoverOpen(solved.V, { start, startStation: 1, maxSteps: g.n - 1 });
  const rep = rec && rec.traj.length ? oracle.replay(rec.traj, { closed: false }) : null;
  const tableVal = oracle.valueAt(solved.V, 1, kMid, kMid, v0 * v0);
  let policyCost = 0;
  for (let k = 0; k < (rec?.traj.length ?? 0) - 1; k++) {
    const a = rec.traj[k], b = rec.traj[k + 1];
    const tr = oracle.transitionW(a.i, a.kp, a.kc, a.w, b.kc, b.w);
    if (tr) policyCost += tr.dt;
  }
  const distance = (model.n - 2) * model.ds;
  const env = brakeEnvelope({ vTerminal: vTerm, distance, decel: netBrake });
  // The envelope is a function of distance-from-the-end; compare at the DP's own
  // station positions via interpolation, not via a first-match lookup.
  let maxViolation = 0;
  if (rec) {
    const envAt = (sFromEnd) => {
      if (!env.length) return Infinity;
      if (sFromEnd <= env[0][0]) return env[0][1];
      for (let k = 1; k < env.length; k++) {
        if (sFromEnd <= env[k][0]) {
          const [s0, v0] = env[k - 1], [s1, v1] = env[k];
          return v0 + (v1 - v0) * ((sFromEnd - s0) / Math.max(1e-9, s1 - s0));
        }
      }
      return env[env.length - 1][1];
    };
    for (const p of rec.traj) {
      const sFromEnd = distance - (p.i - 1) * model.ds;
      maxViolation = Math.max(maxViolation, p.v - envAt(sFromEnd));
    }
  }
  const finalV = rec && rec.traj.length ? rec.traj[rec.traj.length - 1].v : null;
  gate('straight, terminal cap 20 m/s (from 45 m/s over 580 m)', [
    { label: 'trajectory complete', pass: !!rec && rec.complete, detail: rec ? `${rec.traj?.length ?? 0}/${g.n - 1} stations` : 'no recovery' },
    { label: 'table == policy cost (1e-3)', pass: Number.isFinite(tableVal) && Math.abs(tableVal - policyCost) < 1e-3, detail: `table ${tableVal.toFixed(4)} vs policy ${policyCost.toFixed(4)}` },
    { label: 'policy == replay (1e-3)', pass: !!rep && rep.ok && Math.abs(rep.time - policyCost) < 1e-3, detail: rep && rep.ok ? `replay ${rep.time.toFixed(4)} vs policy ${policyCost.toFixed(4)}` : 'replay failed' },
    { label: 'terminal speed respected', pass: finalV !== null && finalV <= vTerm + 0.5, detail: `final ${finalV === null ? 'n/a' : finalV.toFixed(2)} vs cap ${vTerm}` },
    { label: 'never exceeds the backward braking envelope', pass: maxViolation < 0.6, detail: `max violation ${maxViolation.toFixed(3)} m/s` },
  ]);
}

// --- 3. stadium, free terminal (accel / brake / corner / accel) --------------
{
  const track = stadium({ straight: 300, radius: 60 });
  const model = buildTrackModel(track, { spacing: 8 });
  const oracle = createSpatialOracle({ model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet: netCoast,
    options: { qMax: 6, dq: 2.4, dW: 16, wMin: 16, wMax: 5400, open: !!model.open } });
  const solved = oracle.solve({ mode: 'finish' });
  const g = oracle.grid;
  const kMid = Math.floor(g.QN / 2);
  const start = { kp: kMid, kc: kMid, w: 30 * 30 };
  const rec = oracle.recoverOpen(solved.V, { start, startStation: 1, maxSteps: g.n - 1 });
  const rep = rec && rec.traj.length ? oracle.replay(rec.traj, { closed: false }) : null;
  const tableVal = oracle.valueAt(solved.V, 1, kMid, kMid, 30 * 30);
  let policyCost = 0;
  for (let k = 0; k < (rec?.traj.length ?? 0) - 1; k++) {
    const a = rec.traj[k], b = rec.traj[k + 1];
    const tr = oracle.transitionW(a.i, a.kp, a.kc, a.w, b.kc, b.w);
    if (tr) policyCost += tr.dt;
  }
  const vs = rec ? rec.traj.map((p) => p.v) : [];
  let vCorner = 25;
  for (let it = 0; it < 60; it++) vCorner = Math.sqrt(oracle.curves.latMaxAt(vCorner) * 60);
  gate('stadium (300 m straights, R=60), free terminal from 30 m/s', [
    { label: 'trajectory complete', pass: !!rec && rec.complete, detail: rec ? `${rec.traj?.length ?? 0}/${g.n - 1} stations` : 'no recovery' },
    { label: 'table == policy cost (1e-3)', pass: Number.isFinite(tableVal) && Math.abs(tableVal - policyCost) < 1e-3, detail: `table ${tableVal.toFixed(4)} vs policy ${policyCost.toFixed(4)}` },
    { label: 'policy == replay (1e-3)', pass: !!rep && rep.ok && Math.abs(rep.time - policyCost) < 1e-3, detail: rep && rep.ok ? `replay ${rep.time.toFixed(4)} vs policy ${policyCost.toFixed(4)}` : 'replay failed' },
    { label: 'corner speed near the measured lateral limit', pass: vs.length > 0 && Math.abs(Math.min(...vs) - vCorner) / vCorner < 0.15, detail: `min ${vs.length ? Math.min(...vs).toFixed(2) : 'n/a'} vs limit ${vCorner.toFixed(2)} m/s` },
    { label: 'profile rises then falls (not flat)', pass: vs.length > 0 && Math.max(...vs) > 1.15 * Math.min(...vs), detail: `max ${vs.length ? Math.max(...vs).toFixed(1) : 'n/a'} min ${vs.length ? Math.min(...vs).toFixed(1) : 'n/a'}` },
  ]);
}

// --- 4. reduced vs dense Bellman --------------------------------------------
{
  const model = straightModel({ stations: 60, ds: 10 });
  const oracle = createSpatialOracle({ model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet: netCoast,
    options: { qMax: 6, dq: 2.4, dW: 16, wMin: 16, wMax: 5400, open: !!model.open } });
  const solved = oracle.solve({ mode: 'finish' });
  const g = oracle.grid;
  const kMid = Math.floor(g.QN / 2);
  let maxGap = 0, sumGap = 0, count = 0;
  const gaps = [];
  for (let i = 1; i < g.n - 1; i += 3) {
    for (let jw = 0; jw < g.WN; jw += 7) {
      const w = g.wGrid[jw];
      const fast = oracle.bellmanMinimize(solved.V, i, kMid, kMid, w);
      const dense = oracle.bellmanMinimize(solved.V, i, kMid, kMid, w, { dense: true });
      if (!fast.finite || !dense.finite) continue;
      const gap = fast.cost - dense.cost;
      gaps.push(gap); sumGap += Math.abs(gap); count++;
      maxGap = Math.max(maxGap, Math.abs(gap));
    }
  }
  gaps.sort((a, b) => a - b);
  const p95 = gaps.length ? gaps[Math.floor(0.95 * gaps.length)] : 0;
  gate('reduced vs dense Bellman operator', [
    { label: 'candidate set is exact enough (max gap < 1e-3 s)', pass: maxGap < 1e-3, detail: `mean ${(sumGap / Math.max(1, count)).toExponential(2)} p95 ${p95.toExponential(2)} max ${maxGap.toExponential(2)} over ${count} states` },
  ]);
}

fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'stage05a-open-horizon.json'), JSON.stringify({
  generated: new Date().toISOString(), results, passed: results.every((r) => r.passed),
}, null, 1));
const failed = results.filter((r) => !r.passed);
console.log(`\n${failed.length === 0 ? 'ALL OPEN-HORIZON CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`);
console.log('wrote artifacts/stage05a-open-horizon.json');
process.exit(failed.length === 0 ? 0 : 1);


