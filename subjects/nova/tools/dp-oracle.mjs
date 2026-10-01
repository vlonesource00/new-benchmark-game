// Stage 0.5a — exact spatial dynamic-programming oracle. STATUS: NOT CERTIFIED.
//
// GOAL. The bake (A = 81.067 s) came from a heuristic bump-basis optimiser. This
// is meant to solve the same quasi-steady problem EXACTLY, so three quantities
// separate:
//
//     A - B_dp      = optimiser quality gap (the heuristic's own suboptimality)
//     B_dp          = the true optimum of the model
//     73.2 - B_dp   = what the MODEL still cannot reach
//
// and to emit V*(s,q,v): the minimum remaining lap time from a state.
//
// KNOWN DEFECT (do not trust any lap time this prints).
//   The feasible arrival-speed cap does not grow backwards away from a corner, so
//   the whole lap collapses onto the cap of the tightest station instead of
//   forming a braking profile. Measured: with (dq 1.2, dv 3) the cap is a flat
//   19.0 m/s from s=40 to s=2600, and the reported optimum is 222 s. The cap is
//   vCap[i][kp][kc] = largest grid index with a finite value, and it is read for
//   the successor state, but the braking branch (arriving slower than the current
//   speed) is not lifting it. Earlier variants produced 70.02 s when the
//   interpolator was allowed to hold across the feasible boundary (phantom speed
//   carry into corners) and 143.15 s for the opposite reason.
//
// HOW TO FIX (in order):
//   1. Share ONE transition-cost function between the backward sweep and the
//      trajectory recovery; they currently disagree, which is why the recovered
//      trajectory dies after ~800 m and does not realise the table's value.
//   2. Represent feasibility as an explicit continuous half-line per state
//      (v <= vCapSpeed) and never interpolate across the boundary.
//   3. Write the certification test BEFORE trusting any number: simulate the
//      recovered trajectory with the same transition rules and require
//      |recovered time - table value| < 1e-3 s, plus per-station a_y <= latMax
//      and |q| <= qPlan. Without that check every variant above looked plausible.
//
// Other bugs already found and fixed here, worth not reintroducing: a Jacobi sweep
// that propagated one station per pass (needs Gauss-Seidel in place), mask-skipped
// cells reading as valid zeros, a missing kappa_track term (the track looked
// straight), and quantising the successor speed to the grid (the car could brake
// but never accelerate, trapping it at the hairpin's ceiling).
//
// Formulation as intended
//   state    (q_{i-1}, q_i, v) at station i on uniform offset and speed grids
//   path     the q sequence defines the geometry; local curvature is the change in
//            path slope across three points (4 m stencil), the same first-order
//            form as the planner's metric heading estimator
//   demand   a_y = v^2 |kappa|, checked against the measured latMax(v)
//   control  v -> v_next over ds, bounded by the measured drive/brake curves
//            scaled by the friction ellipse sqrt(1 - (a_y/latMax)^2)
//   corridor |q| <= qPlan(s) enforced per station
//   lap      flying lap: single backward pass from the timing line (station 0)
//
//   node tools/dp-oracle.mjs [--spacing 2] [--dq 1.2] [--dv 3]

import fs from 'node:fs';
import path from 'node:path';
import { Track } from '../src/sim/track.js';
import { carSpecFor } from '../src/sim/car-specs.js';
import { buildTrackModel } from '../src/tracks/track-model.js';

const root = process.cwd();
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DS = Number(arg('spacing', 2));
const DQ = Number(arg('dq', 1.2));
const DV = Number(arg('dv', 3));
const SWEEPS = Number(arg('sweeps', 30));
const V_MIN = 4, V_MAX = 78;
const spec = carSpecFor('gt');
const fuelKg = 20;
const mass = spec.mass + fuelKg;
const G = 9.81, RHO = 1.225;
const cdA = spec.area * spec.cd, clA = spec.area * spec.cl;
const dragAccel = (v) => (0.5 * RHO * v * v * cdA) / mass;
const rollAccel = (v) => (0.013 * (mass * G + 0.5 * RHO * v * v * clA) * Math.tanh(v * 2)) / mass;

const id = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'plant-identification-v2.json'), 'utf8'));
const curves = {
  latMax: id.tests.capability.map((c) => [c.v, c.latMax]),
  driveForce: id.tests.drive.bins.map((b) => [b.v, mass * (b.value + dragAccel(b.v) + rollAccel(b.v) + 0.33)]),
  brakeForce: id.tests.brake.bins.map((b) => [b.v, mass * b.value]),
};
const interp = (pts, v) => {
  if (v <= pts[0][0]) return (pts[0][1] / pts[0][0]) * v;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [v0, a0] = pts[i - 1], [v1, a1] = pts[i];
      return a0 + (a1 - a0) * ((v - v0) / (v1 - v0));
    }
  }
  return pts[pts.length - 1][1];
};

const track = new Track('harbor-ring');
const model = buildTrackModel(track, { spacing: DS });
const n = model.n;
const ds = model.ds;

const halfCorridor = Number(arg('corridor', 7.2));
const QN = Math.floor((2 * halfCorridor) / DQ) + 1;
const qGrid = new Float64Array(QN);
for (let k = 0; k < QN; k++) qGrid[k] = -halfCorridor + k * DQ;
const VN = Math.floor((V_MAX - V_MIN) / DV) + 1;
const vGrid = new Float64Array(VN);
for (let j = 0; j < VN; j++) vGrid[j] = V_MIN + j * DV;

// Per-speed pre-computation of the capability curves.
const ayMax = new Float64Array(VN);
const aDrive = new Float64Array(VN);
const aBrake = new Float64Array(VN);
for (let j = 0; j < VN; j++) {
  const v = vGrid[j];
  ayMax[j] = interp(curves.latMax, v);
  aDrive[j] = Math.max(0, interp(curves.driveForce, v) / mass - dragAccel(v) - rollAccel(v) - 0.33);
  aBrake[j] = interp(curves.brakeForce, v) / mass;
  if (ayMax[j] < 1) ayMax[j] = 1;
}

const allowed = new Uint8Array(n * QN);
for (let i = 0; i < n; i++) {
  const lim = model.qPlan;
  for (let k = 0; k < QN; k++) allowed[i * QN + k] = Math.abs(qGrid[k]) <= lim + 1e-9 ? 1 : 0;
}

const S1 = QN * VN;
const S = QN * S1;
const at = (i, kp, kc, j) => i * S + kp * S1 + kc * VN + j;
// Largest feasible arrival-speed index per (station, kp, kc). Feasibility in
// arrival speed is a half-line, so this single integer captures the whole
// constraint and prevents the interpolator from carrying phantom speed into a
// corner (which is what let the first version claim a 70 s lap).
const vCap = new Int16Array(n * QN * QN).fill(-1);
// The timing line is the terminal: any arrival speed is acceptable there.
for (let kp = 0; kp < QN; kp++) for (let kc = 0; kc < QN; kc++) vCap[kp * QN + kc] = VN - 1;

let oldArr = new Float32Array(n * S);
// In-place (Gauss-Seidel) backward sweep: station i reads station i+1's freshly
// computed values, so the remaining-time field propagates the whole lap in a
// single pass. Station 0 stays zero: that is the timing-line terminal.
oldArr.fill(0);
const slope = new Float64Array(QN * QN);
for (let a = 0; a < QN; a++) for (let b = 0; b < QN; b++) slope[a * QN + b] = Math.atan2(qGrid[b] - qGrid[a], ds);

console.log(`grid: n=${n} (${ds.toFixed(2)} m) QN=${QN} (dq ${DQ}) VN=${VN} (dv ${DV}) corridor +-${halfCorridor}`);
const t0 = Date.now();
const history = [];
let lapTime = null;
let lastFinite = true;
let writes = 0;

// Single backward pass from the timing line. Station 0 is the finish (all states
// worth zero); the answer is the best state at station 1, i.e. the optimal flying
// lap truncated by one 2 m step.
for (let i = n - 1; i >= 1; i--) {
  const iNext = (i + 1) % n;
  const allowedPrev = ((i - 1 + n) % n) * QN;
  const allowedCur = i * QN;
  const allowedNext = iNext * QN;
  const nextBase = iNext * S;
  for (let kp = 0; kp < QN; kp++) {
    if (!allowed[allowedPrev + kp]) continue;
    for (let kc = 0; kc < QN; kc++) {
      if (!allowed[allowedCur + kc]) continue;
      const psiIn = slope[kp * QN + kc];
      const rowBase = i * S + kp * S1 + kc * VN;
      let topFinite = -1;
      for (let j = 0; j < VN; j++) {
        const v = vGrid[j];
        const v2 = v * v;
        let best = Infinity;
        for (let kn = 0; kn < QN; kn++) {
          if (!allowed[allowedNext + kn]) continue;
          // Total path curvature in the curvilinear frame: the line's own
          // curvature plus the track's, corrected for the offset (kappa_track/(1-kappa_track*q)).
          const kt = model.kappa[i];
          const kappa = (slope[kc * QN + kn] - psiIn) / ds + kt / (1 - kt * qGrid[kc]);
          const ay = v2 * Math.abs(kappa);
          if (ay > ayMax[j]) continue;
          const ellipse = Math.sqrt(Math.max(0.04, 1 - (ay / ayMax[j]) ** 2));
          const vHi = Math.sqrt(v2 + 2 * ds * aDrive[j] * ellipse);
          const vLo = Math.sqrt(Math.max(V_MIN * V_MIN, v2 - 2 * ds * aBrake[j] * ellipse));
          // The successor speed is CONTINUOUS: over a 2 m station the achievable
          // speed change (0.5 m/s at 40 m/s) is far smaller than any useful grid
          // step, so quantising it traps the car at the slowest feasible speed for
          // the whole lap - it can brake but never accelerate. V is piecewise
          // linear in v, so the minimum over the interval is at an end or a kink.
          const colBase = nextBase + kc * S1 + kn * VN;
          const capIdx = vCap[iNext * QN * QN + kc * QN + kn];
          if (capIdx < 0) continue;
          const vCapSpeed = vGrid[capIdx];
          const costAt = (vn) => {
            const x = (vn - V_MIN) / DV;
            const j0 = Math.max(0, Math.min(capIdx, Math.floor(x)));
            const j1 = Math.min(capIdx, j0 + 1);
            const f = j1 > j0 ? x - j0 : 0;
            const a = oldArr[colBase + j0], b = oldArr[colBase + j1];
            return (2 * ds) / (v + vn) + a + (b - a) * f;
          };
          const vTop = Math.min(vHi, vCapSpeed);
          if (vLo <= vTop) {
            let cand = costAt(vTop);
            const cLo = costAt(vLo);
            if (cLo < cand) cand = cLo;
            const kn0 = Math.ceil((vLo - V_MIN) / DV - 1e-9);
            const kn1 = Math.floor((vTop - V_MIN) / DV + 1e-9);
            for (let jn = Math.max(0, kn0); jn <= Math.min(capIdx, kn1); jn++) {
              const c = costAt(vGrid[jn]);
              if (c < cand) cand = c;
            }
            if (cand < best) best = cand;
          }
        }
        oldArr[rowBase + j] = best;
        writes++;
        if (Number.isFinite(best)) topFinite = j;
      }
      vCap[i * QN * QN + kp * QN + kc] = topFinite;
    }
  }
  if (args.includes('--debug')) {
    let minVal = Infinity;
    for (let kp = 0; kp < QN; kp++) for (let kc = 0; kc < QN; kc++) {
      if (!allowed[((i - 1 + n) % n) * QN + kp] || !allowed[i * QN + kc]) continue;
      for (let j = 0; j < VN; j++) { const v = oldArr[i * S + kp * S1 + kc * VN + j]; if (v < minVal) minVal = v; }
    }
    if (!Number.isFinite(minVal) && lastFinite) {
      console.log(`  first infeasible station going backwards: i=${i} s=${(i * ds).toFixed(0)} kappa=${model.kappa[i].toFixed(4)} (R=${(1 / Math.max(1e-6, Math.abs(model.kappa[i]))).toFixed(1)} m)`);
    }
    lastFinite = Number.isFinite(minVal);
  }
}
// Mark every state that violates the corridor as infeasible, so the recovered
// trajectory and the reported lap time can never come from a mask-skipped cell
// (those were never written and still hold their initial zero).
for (let i = 0; i < n; i++) {
  for (let kp = 0; kp < QN; kp++) {
    const okPrev = allowed[((i - 1 + n) % n) * QN + kp];
    for (let kc = 0; kc < QN; kc++) {
      if (okPrev && allowed[i * QN + kc]) continue;
      const base = i * S + kp * S1 + kc * VN;
      for (let j = 0; j < VN; j++) oldArr[base + j] = Infinity;
    }
  }
}
{
  let best = Infinity, bk = -1;
  for (let k = S; k < 2 * S; k++) if (oldArr[k] < best) { best = oldArr[k]; bk = k; }
  lapTime = best;
  void bk;
}
console.log(`writes=${writes} sample=${oldArr[1 * QN * QN * VN + 7 * QN * VN + 7 * VN + 20]}`);
console.log(`one backward pass in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`DP optimal flying lap (from station 1, one 2 m step short of the line): ${lapTime.toFixed(3)} s`);

if (args.includes('--debug')) {
  console.log('\nfeasible-speed cap (m/s) for the straight-line state q_prev=q_now=0, per station:');
if (args.includes('--debug2')) {
  const kMid = (QN - 1) / 2;
  for (const i of [840, 880, 2360, 2320]) {
    const kp = kMid, kc = kMid;
    const psiIn = slope[kp * QN + kc];
    const iNext = (i + 1) % n;
    const kn = kMid;
    const capIdx = vCap[iNext * QN * QN + kc * QN + kn];
    const kt = model.kappa[i];
    const kappa = (slope[kc * QN + kn] - psiIn) / ds + kt / (1 - kt * qGrid[kc]);
    console.log(`station ${i} (s=${(i * ds).toFixed(0)}) kt=${kt.toFixed(4)} kappa_line+track=${kappa.toFixed(5)} succCap=${capIdx >= 0 ? vGrid[capIdx] : 'INF'}`);
    for (const j of [11, 12, 13, 14]) {
      const v = vGrid[j];
      const ay = v * v * Math.abs(kappa);
      const ellipse = Math.sqrt(Math.max(0.04, 1 - (ay / ayMax[j]) ** 2));
      const vHi = Math.sqrt(v * v + 2 * ds * aDrive[j] * ellipse);
      const vLo = Math.sqrt(Math.max(V_MIN * V_MIN, v * v - 2 * ds * aBrake[j] * ellipse));
      const vTop = Math.min(vHi, capIdx >= 0 ? vGrid[capIdx] : Infinity);
      console.log(`   v=${v.toFixed(1)} ay=${ay.toFixed(2)}/ayMax=${ayMax[j].toFixed(2)} e=${ellipse.toFixed(3)} aD=${aDrive[j].toFixed(1)} aB=${aBrake[j].toFixed(1)} vLo=${vLo.toFixed(2)} vHi=${vHi.toFixed(2)} vTop=${vTop.toFixed(2)} ok=${vLo <= vTop} valueHere=${Number.isFinite(oldArr[at(i, kp, kc, j)]) ? oldArr[at(i, kp, kc, j)].toFixed(1) : 'INF'}`);
    }
  }
}
  const kMid = (QN - 1) / 2;
  const rows = [];
  for (let i = 0; i < n; i += Math.max(1, Math.round(40 / ds))) {
    const cap = vCap[i * QN * QN + kMid * QN + kMid];
    rows.push(`s=${String(Math.round(i * ds)).padStart(4)}:${cap >= 0 ? vGrid[cap].toFixed(1).padStart(6) : '  INF'.padStart(6)}`);
  }
  for (let k = 0; k < rows.length; k += 8) console.log('  ' + rows.slice(k, k + 8).join(''));
  console.log('\nvalue at station 1 by speed (state q=0):');
  const line = [];
  for (let j = 0; j < VN; j++) line.push(`${vGrid[j]}:${Number.isFinite(oldArr[at(1, kMid, kMid, j)]) ? oldArr[at(1, kMid, kMid, j)].toFixed(1) : 'INF'}`);
  console.log('  ' + line.join(' '));
}

// Forward recovery on the converged table: greedy best successor from the best
// state at station 0, i.e. the optimal periodic trajectory.
function recover() {
  const V = oldArr;
  let bestS = -1, bestVal = Infinity;
  for (let kp = 0; kp < QN; kp++) for (let kc = 0; kc < QN; kc++) for (let j = 0; j < VN; j++) {
    const s = at(1, kp, kc, j);
    if (V[s] < bestVal) { bestVal = V[s]; bestS = s; }
  }
  let kp = Math.floor((bestS - S) / S1), kc = Math.floor(((bestS - S) % S1) / VN), j = bestS % VN;
  const traj = [];
  let t = 0;
  for (let step = 1; step < n + 2; step++) {
    const i = step % n;
    traj.push({ i, s: i * ds, q: qGrid[kc], v: vGrid[j], t });
    const iNext = (i + 1) % n;
    const psiIn = slope[kp * QN + kc];
    let best = Infinity, bk = -1, bv = 0;
    for (let kn = 0; kn < QN; kn++) {
      if (!allowed[iNext * QN + kn]) continue;
      const kt = model.kappa[i];
      const kappa = (slope[kc * QN + kn] - psiIn) / ds + kt / (1 - kt * qGrid[kc]);
      const ay = vGrid[j] ** 2 * Math.abs(kappa);
      if (ay > ayMax[j]) continue;
      const ellipse = Math.sqrt(Math.max(0.04, 1 - (ay / ayMax[j]) ** 2));
      const vHi = Math.sqrt(vGrid[j] ** 2 + 2 * ds * aDrive[j] * ellipse);
      const vLo = Math.sqrt(Math.max(V_MIN * V_MIN, vGrid[j] ** 2 - 2 * ds * aBrake[j] * ellipse));
      if (vLo > vHi) continue;
      const colBase = iNext * S + kc * S1 + kn * VN;
      const cand = [vLo, vHi];
      const kn0 = Math.ceil((vLo - V_MIN) / DV - 1e-9);
      const kn1 = Math.floor((vHi - V_MIN) / DV + 1e-9);
      for (let jn = Math.max(0, kn0); jn <= Math.min(VN - 1, kn1); jn++) cand.push(vGrid[jn]);
      for (const vn of cand) {
        const x = (vn - V_MIN) / DV;
        const j0 = Math.max(0, Math.min(VN - 1, Math.floor(x)));
        const j1 = Math.min(VN - 1, j0 + 1);
        const f = x - j0;
        let a = V[colBase + j0], b = V[colBase + j1];
        if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
        if (!Number.isFinite(a)) a = b;
        if (!Number.isFinite(b)) b = a;
        const cost = (2 * ds) / (vGrid[j] + vn) + a + (b - a) * f;
        if (cost < best) { best = cost; bk = kn; bv = vn; }
      }
    }
    if (bk < 0) break;
    t += (2 * ds) / (vGrid[j] + bv);
    kp = kc; kc = bk; j = Math.max(0, Math.min(VN - 1, Math.round((bv - V_MIN) / DV)));
  }
  return { traj, time: t, closed: traj.length >= n };
}

const rec = recover();
const trace = rec.traj.map((p) => [+p.s.toFixed(1), +p.q.toFixed(3), +p.v.toFixed(2), +p.t.toFixed(3)]);
const qs = rec.traj.map((p) => Math.abs(p.q));
const vs = rec.traj.map((p) => p.v);
console.log(`recovered: ${rec.time.toFixed(3)} s, peak |q| ${Math.max(...qs).toFixed(2)} m, v ${Math.min(...vs).toFixed(1)}..${Math.max(...vs).toFixed(1)} m/s`);

// Per-200 m block times, for comparison with the bake's delta map.
const blocks = [];
for (let b = 0; b < model.length; b += 200) {
  const w = rec.traj.filter((p) => p.s >= b && p.s < b + 200);
  if (!w.length) continue;
  const ms = (w[w.length - 1].t - w[0].t);
  blocks.push({ from: b, dpTime: +ms.toFixed(2), minV: +Math.min(...w.map((p) => p.v)).toFixed(1), maxV: +Math.max(...w.map((p) => p.v)).toFixed(1), maxQ: +Math.max(...w.map((p) => Math.abs(p.q))).toFixed(2) });
}
console.log('block   dpTime  minV  maxV  maxQ');
for (const b of blocks) console.log(`${String(b.from).padStart(5)} ${String(b.dpTime).padStart(8)} ${String(b.minV).padStart(5)} ${String(b.maxV).padStart(5)} ${String(b.maxQ).padStart(5)}`);

const out = {
  generated: new Date().toISOString(),
  grid: { spacing: DS, dq: DQ, dv: DV, QN, VN, corridor: halfCorridor, stations: n, sweeps: history.length },
  lapTime: lapTime === null ? null : +lapTime.toFixed(4),
  recoveredTime: +rec.time.toFixed(4),
  sweepHistory: history.map((h) => +h.toFixed(4)),
  blocks,
  trajectory: trace,
};
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'stage05a-dp-oracle.json'), JSON.stringify(out, null, 1));
console.log('wrote artifacts/stage05a-dp-oracle.json');




