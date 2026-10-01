// Stage 0.5a sanity baselines.
//
// The oracle must reproduce known qualitative answers on simple tracks before any
// Harbor number is trusted. Specifically these catch the failure mode that made
// the previous version useless: a speed ceiling from one tight corner contaminating
// the whole lap.
//
//   1. long straight        -> full acceleration, no mysterious cap
//   2. constant radius      -> steady speed at the measured lateral limit
//   3. single corner        -> accelerate / brake / corner / accelerate
//   4. chicane              -> coupled geometry, no impossible lateral zigzag
//
//   node tools/dp-sanity.mjs [--iters 12]

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { buildTrackModel } from '../src/tracks/track-model.js';
import { createSpatialOracle, makeCurve } from '../src/ai/global/spatial-oracle.js';

const root = process.cwd();
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ITERS = Number(arg('iters', 12));
const spec = carSpecFor('gt');
const mass = spec.mass + 20;
const RHO = 1.225, G = 9.81;
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;

const id = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const dragAccel = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollAccel = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;
const ENGINE_BRAKE = 0.33;

const curves = {
  latMax: id.tests.capability.map((c) => [c.v, c.latMax]),
  driveForce: id.tests.drive.bins.map((b) => [b.v, mass * (b.value + dragAccel(b.v) + rollAccel(b.v) + ENGINE_BRAKE)]),
  brakeForce: id.tests.brake.bins.map((b) => [b.v, mass * b.value]),
};
const netDrive = (v) => makeCurve(id.tests.drive.bins.map((b) => [b.v, b.value]))(v);
const netBrake = (v) => makeCurve(id.tests.brake.bins.map((b) => [b.v, b.value]))(v);
const coastNet = (v) => makeCurve(id.tests.coast.bins.map((b) => [b.v, b.value]))(v);
const latMax = makeCurve(curves.latMax);

// --- lab tracks -------------------------------------------------------------
function stadium({ straight = 400, radius = 60, halfWidth = 40, id: tid = 'lab' }) {
  const pts = [];
  for (let z = -straight / 2; z <= straight / 2; z += 50) pts.push({ x: 0, y: 0, z });
  const cx = radius;
  for (let i = 1; i < 16; i++) { const a = Math.PI - (i / 16) * Math.PI; pts.push({ x: cx + radius * Math.cos(a), y: 0, z: straight / 2 + radius * Math.sin(a) }); }
  for (let z = straight / 2; z >= -straight / 2; z -= 50) pts.push({ x: 2 * radius, y: 0, z });
  for (let i = 1; i < 16; i++) { const a = (i / 16) * Math.PI; pts.push({ x: cx + radius * Math.cos(a), y: 0, z: -straight / 2 + radius * Math.sin(a) }); }
  return new Track({
    id: tid, name: tid, controlPoints: pts, sampleDensity: 8,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 10,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}
function circleLab(R, halfWidth = 40) {
  const pts = [];
  for (let i = 0; i < 256; i++) { const th = (i / 256) * Math.PI * 2; pts.push({ x: R * Math.sin(th), y: 0, z: R * Math.cos(th) }); }
  return new Track({
    id: 'lab-circle', name: 'lab-circle', controlPoints: pts, sampleDensity: 4,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 10,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}
function chicaneLab(halfWidth = 40) {
  // Straight, then a left-right S over 160 m, then straight back.
  const pts = [];
  for (let z = -300; z <= -80; z += 40) pts.push({ x: 0, y: 0, z });
  pts.push({ x: 0, y: 0, z: -40 }, { x: -14, y: 0, z: 0 }, { x: 14, y: 0, z: 40 }, { x: 0, y: 0, z: 80 });
  for (let z = 120; z <= 300; z += 40) pts.push({ x: 0, y: 0, z });
  pts.push({ x: -60, y: 0, z: 360 }, { x: -60, y: 0, z: 0 }, { x: -60, y: 0, z: -360 });
  return new Track({
    id: 'lab-chicane', name: 'lab-chicane', controlPoints: pts, sampleDensity: 12,
    roadHalfWidth: halfWidth, curbWidth: 1, runoffWidth: 10,
    start: { finishFraction: 0, gridFraction: 0, rowSpacingM: 8, laneOffsetM: 2 },
  });
}

function run(track, { qMax, dW, ds, dq, iters = ITERS }) {
  const model = buildTrackModel(track, { spacing: ds });
  const oracle = createSpatialOracle({
    model, curves, mass, driveNet: netDrive, brakeNet: netBrake, coastNet,
    options: { qMax, dW, dq: dq ?? 1.8 },
  });
  const t0 = Date.now();
  const solved = oracle.solve({
    mode: 'periodic', maxIterations: iters, tolerance: 1e-4,
    onProgress: (p) => {
      if (p.aborted) return;
      process.stdout.write(`    iter ${p.iter}: best ${p.best.toFixed(3)}  states ${p.statesVisited}  transitions ${p.transitions}  ${p.iterationMs} ms\n`);
    },
  });
  const solveMs = Date.now() - t0;
  const rec = oracle.recoverPeriodic(solved.V, {});
  const rep = rec && rec.replay ? rec.replay : null;
  return { model, oracle, solved, rec, rep, solveMs };
}

const results = [];
function report(name, r, checks) {
  const { rec, rep, solved } = r;
  if (rec && !rec.start) console.log('  (recovery returned no start state)');
  const startIdx = rec && rec.start
    ? r.oracle.idx(rec.start.kp, rec.start.kc, Math.max(0, Math.min(r.oracle.grid.WN - 1, Math.round((rec.start.w - r.oracle.grid.wMin) / r.oracle.grid.dW))))
    : -1;
  const tableCost = startIdx >= 0 ? r.solved.V[0 * r.oracle.grid.S + startIdx] : null;
  let recoveredCost = 0;
  if (rec) for (let k = 0; k < rec.traj.length; k++) {
    const a = rec.traj[k], b = rec.traj[(k + 1) % rec.traj.length];
    const tr = r.oracle.transitionW(a.i, a.kp, a.kc, a.w, b.kc, b.w);
    if (tr) recoveredCost += tr.dt;
  }
  const row = {
    name,
    stations: r.model.n,
    solveMs: r.solveMs,
    cycleMean: solved.cycleMean,
    tableCost, recoveredCost,
    replayTime: rep && rep.ok ? rep.time : null,
    replayOk: rep ? rep.ok : false,
    closed: rec ? rec.closed : false,
    complete: rec ? rec.complete : false,
    maxUy: rep && rep.ok ? rep.maxUy : null,
    minV: rep && rep.ok ? rep.minV : null,
    maxV: rep && rep.ok ? rep.maxV : null,
    checks,
  };
  results.push(row);
  const fmt = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(3));
  console.log(`\n== ${name} ==`);
  console.log(`  stations ${r.model.n}  solve ${r.solveMs} ms  cycleMean ${fmt(row.cycleMean)}`);
  console.log(`  table ${fmt(tableCost)}  recovered ${fmt(recoveredCost)}  replay ${fmt(row.replayTime)}  closed ${row.closed}  complete ${row.complete}`);
  console.log(`  v ${fmt(row.minV)} .. ${fmt(row.maxV)}  max uy ${fmt(row.maxUy)}`);
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? ` -- ${c.detail}` : ''}`);
}

// --- 1. long straight: no mysterious speed cap ------------------------------
{
  const r = run(stadium({ straight: 900, radius: 60, id: 'lab-straight' }), { qMax: 6, dW: 64, ds: 8, dq: 2.4 });
  const traj = r.rec ? r.rec.traj : [];
  // Top speed physically available at the end of a 900 m straight.
  let vTop = 30;
  for (let s = 0; s < 900; s += 2) { const a = netDrive(vTop); vTop = Math.sqrt(Math.max(1, vTop * vTop + 2 * a * 2)); }
  const maxV = traj.length ? Math.max(...traj.map((p) => p.v)) : 0;
  report('long straight (900 m) + hairpin', r, [
    { label: 'trajectory complete', pass: !!r.rec && r.rec.complete },
    { label: 'reaches the physically available top speed', pass: maxV > 0.9 * vTop, detail: `reached ${maxV.toFixed(1)} m/s of ${vTop.toFixed(1)} m/s available` },
    { label: 'no speed ceiling artefact', pass: maxV > 25, detail: `max ${maxV.toFixed(1)} m/s` },
    { label: 'replay matches the table', pass: r.rep && r.rep.ok && Math.abs(r.rep.time - r.solved.cycleMean) < 0.5, detail: r.rep && r.rep.ok ? `replay ${r.rep.time.toFixed(3)} vs cycleMean ${r.solved.cycleMean.toFixed(3)}` : 'replay failed' },
  ]);
}

// --- 2. constant radius circle ---------------------------------------------
{
  const R = 80;
  const r = run(circleLab(R), { qMax: 6, dW: 32, ds: 8, dq: 2.4 });
  const traj = r.rec ? r.rec.traj : [];
  const vMean = traj.length ? traj.reduce((a, p) => a + p.v, 0) / traj.length : 0;
  const qs = traj.map((p) => p.q);
  const qSpread = qs.length ? Math.max(...qs) - Math.min(...qs) : 0;
  // Steady-state corner speed at this radius: v^2 = latMax(v) * R_eff
  let vSteady = 25;
  for (let it = 0; it < 60; it++) vSteady = Math.sqrt(latMax(vSteady) * R);
  report(`constant radius circle R=${R}`, r, [
    { label: 'trajectory complete', pass: !!r.rec && r.rec.complete },
    { label: 'steady speed near the measured lateral limit', pass: Math.abs(vMean - vSteady) / vSteady < 0.08, detail: `mean ${vMean.toFixed(2)} vs limit ${vSteady.toFixed(2)} m/s` },
    { label: 'lateral offset is essentially constant', pass: qSpread <= 2 * r.oracle.grid.qGrid[1] + 1e-9, detail: `spread ${qSpread.toFixed(2)} m` },
    { label: 'replay matches the table', pass: r.rep && r.rep.ok && Math.abs(r.rep.time - r.solved.cycleMean) < 0.3, detail: r.rep && r.rep.ok ? `replay ${r.rep.time.toFixed(3)} vs cycleMean ${r.solved.cycleMean.toFixed(3)}` : 'replay failed' },
  ]);
}

// --- 3. single corner -------------------------------------------------------
{
  const r = run(stadium({ straight: 400, radius: 60, id: 'lab-corner' }), { qMax: 6, dW: 64, ds: 8, dq: 2.4 });
  const traj = r.rec ? r.rec.traj : [];
  const reps = r.rep && r.rep.ok ? r.rep.stations : [];
  const minV = reps.length ? Math.min(...reps.map((x) => x.v)) : 0;
  let vCorner = 25;
  for (let it = 0; it < 60; it++) vCorner = Math.sqrt(latMax(vCorner) * 60);
  const decels = reps.map((x) => x.aEff);
  const maxDecel = decels.length ? Math.min(...decels) : 0;
  const brakeCurve = netBrake(Math.max(5, minV + 8));
  report('single corner (400 m straights, R=60)', r, [
    { label: 'trajectory complete', pass: !!r.rec && r.rec.complete },
    { label: 'corner speed near the measured lateral limit', pass: Math.abs(minV - vCorner) / vCorner < 0.10, detail: `min ${minV.toFixed(2)} vs limit ${vCorner.toFixed(2)} m/s` },
    { label: 'braking respects the measured brake curve', pass: maxDecel >= -brakeCurve - 1e-6, detail: `min aEff ${maxDecel.toFixed(2)} vs -brake ${(-brakeCurve).toFixed(2)}` },
    { label: 'profile is accel/brake/corner/accel, not flat', pass: traj.length > 0 && Math.max(...traj.map((p) => p.v)) > 1.5 * minV, detail: `max ${traj.length ? Math.max(...traj.map((p) => p.v)).toFixed(1) : 'n/a'} vs min ${minV.toFixed(1)}` },
  ]);
}

// --- 4. chicane -------------------------------------------------------------
{
  const r = run(chicaneLab(), { qMax: 8, dW: 64, ds: 8, dq: 2.4 });
  const traj = r.rec ? r.rec.traj : [];
  let maxDq = 0;
  for (let k = 1; k < traj.length; k++) maxDq = Math.max(maxDq, Math.abs(traj[k].q - traj[k - 1].q));
  // A lateral step is limited by the lateral capability: dq <= ds * sqrt(ay/q...) ;
  // measured bound: with 4 m spacing and at worst 10 m/s, a 1 g manoeuvre allows
  // roughly ds * tan(asin(ay/g)) ~ 4 m. Anything above that is a zigzag artefact.
  report('chicane', r, [
    { label: 'trajectory complete', pass: !!r.rec && r.rec.complete },
    { label: 'no impossible lateral zigzag', pass: maxDq <= 4.01, detail: `max |dq| per 4 m station ${maxDq.toFixed(2)} m` },
    { label: 'replay legal (constraints hold)', pass: r.rep && r.rep.ok, detail: r.rep && r.rep.ok ? `max uy ${r.rep.maxUy.toFixed(3)}` : 'replay failed' },
  ]);
}

fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const failed = results.filter((r) => r.checks.some((c) => !c.pass));
fs.writeFileSync(path.join(root, 'artifacts', 'stage05a-sanity.json'), JSON.stringify({
  generated: new Date().toISOString(), iters: ITERS, results,
  passed: failed.length === 0,
}, null, 1));
console.log(`\n${failed.length === 0 ? 'ALL SANITY CHECKS PASSED' : `${failed.length} sanity track(s) FAILED`}`);
console.log('wrote artifacts/stage05a-sanity.json');
process.exit(failed.length === 0 ? 0 : 1);




