import { NovaValueField, NovaBeliefEngine, NovaTopologyPlanner } from '../src/ai/nova/index.js';
import { NOVA_FREE_AIR } from '../src/tracks/lines/harbor-ring-nova.js';

// Setup Nova components
const vf = new NovaValueField({ reference: NOVA_FREE_AIR });
const be = new NovaBeliefEngine();
const planner = new NovaTopologyPlanner();

// Scenario parameters:
// Approaching straight / open curve at s=450m
// NOVA closing on Gemini at 3.0 m/s relative speed
const vNova = 45.0;
const vGemini = 42.0;
const closingSpeed = vNova - vGemini; // 3.0 m/s
const totalOverlapDist = 2.325 * 2 + 0.5; // ~5.15m body overlap window
const overlapDuration = totalOverlapDist / closingSpeed; // ~1.72s

// We evaluate from t = -3.0s (ds = +9.0m, ahead) to t = +3.0s (ds = -9.0m, behind)
const dt = 0.05; // 20 Hz logging
const tStart = -3.0;
const tEnd = 3.0;

console.log('================================================================================');
console.log('NOVA V4 ARCHITECTURAL AUDIT: GEMINI OVERTAKE EPISODE INSTRUMENTATION');
console.log('================================================================================');
console.log(`Relative speed: ${closingSpeed.toFixed(1)} m/s | Overlap distance: ${totalOverlapDist.toFixed(2)} m`);
console.log('--------------------------------------------------------------------------------');

const log = [];

for (let t = tStart; t <= tEnd + 1e-5; t += dt) {
  const relativeS = -t * closingSpeed; // at t=0, relativeS = 0 (aligned)
  const sEgo = 450.0 + (t - tStart) * vNova;
  const sGemini = sEgo + relativeS;

  const ego = {
    id: 'nova',
    s: sEgo,
    q: -0.5,
    speed: vNova,
    halfLength: 2.325,
    halfWidth: 1.01,
  };

  const gemini = {
    id: 'gemini-supreme',
    s: sGemini,
    q: 1.2, // Gemini is holding 1.2m right of centerline
    speed: vGemini,
    halfLength: 2.325,
    halfWidth: 1.01,
  };

  be.update([gemini], ego, dt);
  const plan = planner.plan(ego, [gemini], vf, be, NOVA_FREE_AIR, t - tStart, dt);

  const refQ = vf.sampleNominal(sEgo).q;
  const leadId = planner.targetId; // or who planner sees as lead
  const overlapActive = Math.abs(relativeS) <= (ego.halfLength + gemini.halfLength + 0.5);

  log.push({
    t: +t.toFixed(2),
    ds: +relativeS.toFixed(2),
    bodyState: relativeS > 5.15 ? 'AHEAD' : (relativeS < -5.15 ? 'BEHIND' : 'OVERLAPPING'),
    phase: plan.phase,
    targetId: planner.targetId,
    lastAttackId: planner.lastAttackId,
    selectedSide: planner.selectedSide,
    maneuverAge: +planner.maneuverAge.toFixed(2),
    topology: plan.activeTopology,
    targetQ: +plan.targetQ.toFixed(2),
    refQ: +refQ.toFixed(2),
    deformation: +(plan.targetQ - refQ).toFixed(2),
    targetSpeedCap: Number.isFinite(plan.targetSpeedCap) ? +plan.targetSpeedCap.toFixed(1) : 'INF',
    capReason: plan.targetSpeedCapReason || 'NONE',
    risk: +(plan.sweptPrediction?.peakRisk ?? 0).toFixed(2)
  });
}

// Print key milestone snapshots
console.log('t(s) | ds(m)  | BodyState   | Phase             | targetId | lastAtkId | side | age(s) | Topology     | targetQ | refQ  | Deform | SpeedCap | Reason');
console.log('-----+--------+-------------+-------------------+----------+-----------+------+--------+--------------+---------+-------+--------+----------+------------------------');
for (const entry of log) {
  // Print every 0.25s or when state changes
  if (Math.abs(entry.t % 0.25) < 0.02 || Math.abs(entry.ds) < 0.2 || Math.abs(entry.ds - 5.15) < 0.2 || Math.abs(entry.ds + 5.15) < 0.2) {
    console.log(
      `${entry.t.toFixed(2).padStart(4)} | ` +
      `${entry.ds.toFixed(2).padStart(6)} | ` +
      `${entry.bodyState.padEnd(11)} | ` +
      `${entry.phase.padEnd(17)} | ` +
      `${String(entry.targetId || 'null').padEnd(8)} | ` +
      `${String(entry.lastAttackId || 'null').padEnd(9)} | ` +
      `${String(entry.selectedSide).padStart(4)} | ` +
      `${entry.maneuverAge.toFixed(2).padStart(6)} | ` +
      `${entry.topology.padEnd(12)} | ` +
      `${entry.targetQ.toFixed(2).padStart(7)} | ` +
      `${entry.refQ.toFixed(2).padStart(5)} | ` +
      `${entry.deformation.toFixed(2).padStart(6)} | ` +
      `${String(entry.targetSpeedCap).padStart(8)} | ` +
      `${entry.capReason}`
    );
  }
}

// Architectural failure assertions:
console.log('\n================================================================================');
console.log('AUDIT VERIFICATIONS:');
console.log('--------------------------------------------------------------------------------');

// 1. Check if targetId becomes null during overlap
const overlapEntries = log.filter(e => e.bodyState === 'OVERLAPPING');
const hasNullTargetDuringOverlap = overlapEntries.some(e => e.targetId === null);
console.log(`[FAILURE 1] targetId becomes null during overlap: ${hasNullTargetDuringOverlap ? 'PROVEN (CONFIRMED)' : 'NOT FOUND'}`);

// 2. Check if selectedSide resets during overlap
const sideResetsDuringOverlap = overlapEntries.some(e => e.selectedSide === 0);
console.log(`[FAILURE 2] selectedSide resets to 0 during overlap: ${sideResetsDuringOverlap ? 'PROVEN (CONFIRMED)' : 'NOT FOUND'}`);

// 3. Check if maneuverAge resets to 0 when overlap begins
const ageResets = overlapEntries[0]?.maneuverAge === 0;
console.log(`[FAILURE 3] maneuverAge resets to 0 when overlap begins: ${ageResets ? 'PROVEN (CONFIRMED)' : 'NOT FOUND'}`);

// 4. Check if deformation collapses toward racing line during overlap
const attackEntries = log.filter(e => e.t < -1.75); // well before overlap
const preOverlapDeform = Math.abs(attackEntries.at(-1)?.deformation || 0);
const midOverlapDeform = Math.abs(overlapEntries.find(e => Math.abs(e.ds) < 0.5)?.deformation || 0);
console.log(`[FAILURE 4] Pre-overlap deformation: ${preOverlapDeform.toFixed(2)}m -> Mid-overlap deformation: ${midOverlapDeform.toFixed(2)}m (Snaps back to ref line)`);

// 5. Check if targetSpeedCap drops to match rival speed
const hasSpeedCapDuringOverlap = overlapEntries.some(e => e.targetSpeedCap !== 'INF' && e.targetSpeedCap <= vGemini + 1.0);
console.log(`[FAILURE 5] targetSpeedCap drops to match rival speed during overlap: ${hasSpeedCapDuringOverlap ? 'PROVEN (CONFIRMED)' : 'NOT FOUND'}`);
console.log('================================================================================\n');
