import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NovaValueField,
  NovaBeliefEngine,
  NovaTopologyPlanner,
  NovaCoupledController,
  NovaDriver,
} from '../src/ai/nova/index.js';
import { NOVA_FREE_AIR } from '../src/tracks/lines/harbor-ring-nova.js';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

test('NovaValueField computes sensitivity Taylor expansion and optimal continuation', () => {
  const vf = new NovaValueField({ reference: NOVA_FREE_AIR });
  assert.ok(Number.isFinite(vf.nominalLapTime), 'Nominal lap time should be finite');
  assert.ok(vf.nominalLapTime > 70 && vf.nominalLapTime < 100, 'Nominal lap time should be around 85s');

  const s = 1000;
  const nom = vf.sampleNominal(s);
  assert.ok(Number.isFinite(nom.v) && nom.v > 0, 'Nominal speed must be positive');
  assert.ok(Number.isFinite(nom.V0) && nom.V0 > 0, 'V0 must be positive');

  // Value at nominal must equal V0
  const vAtNominal = vf.evaluate(s, nom.q, nom.v, 0);
  assert.ok(Math.abs(vAtNominal - nom.V0) < 1e-4, 'Value at nominal state should equal V0');

  // Slow speed deficit must increase remaining time
  const vSlow = vf.evaluate(s, nom.q, nom.v - 5, 0);
  assert.ok(vSlow > vAtNominal, 'Speed deficit must increase remaining lap time');

  // Off-track lateral offset must increase remaining time
  const vWide = vf.evaluate(s, nom.q + 3.0, nom.v, 0);
  assert.ok(vWide > vAtNominal, 'Lateral offset must increase remaining lap time');

  // Optimal continuation decays deviation towards nominal
  const qTarget = vf.optimalContinuationQ(s, nom.q + 2.0, 20.0);
  assert.ok(Math.abs(qTarget - nom.q) < 2.0, 'Optimal continuation must decay toward nominal line');
});

test('NovaBeliefEngine updates intent probabilities and generates occupancy tubes', () => {
  const belief = new NovaBeliefEngine();
  const rivals = [
    { id: 'rival-1', s: 500, q: 2.0, speed: 30, dq: -0.5, dv: -1.0 },
    { id: 'rival-2', s: 600, q: -1.0, speed: 35, dq: 0.0, dv: 0.0 },
  ];
  const ego = { s: 480, q: 0.0, speed: 32 };

  belief.update(rivals, ego, 0.1);
  const b1 = belief.getBelief('rival-1');
  assert.ok(b1, 'Belief must exist for rival-1');
  assert.ok(b1.defendInside > 0, 'defendInside probability must be positive');

  const tubes = belief.getOccupancyTubes(2.0, 0.5);
  assert.equal(tubes.length, 2, 'Should generate tubes for both rivals');
  assert.ok(tubes[0].tubes.length > 0, 'Tube should have time segments');
  assert.equal(tubes[0].branches.length, 7, 'Rival futures must remain separate intent branches');
  const left = tubes[0].branches.find(branch => branch.mode === 'DEFEND_LEFT');
  const right = tubes[0].branches.find(branch => branch.mode === 'DEFEND_RIGHT');
  assert.ok(left.tubes.at(-1).q_mean < right.tubes.at(-1).q_mean - 1,
    'Opposite defensive futures must not collapse to a mean path');
  assert.ok(Math.abs(tubes[0].branches.reduce((sum, branch) => sum + branch.probability, 0) - 1) < 1e-9);

  const corridors = belief.getClearanceCorridors(500, -8.2, 8.2);
  assert.ok(Array.isArray(corridors), 'Clearance corridors must be an array');
  assert.ok(corridors.length >= 1, 'Should find at least one free corridor');
});

test('Rival attack intent uses ego forward speed, not body lateral velocity', () => {
  const slow = new NovaBeliefEngine();
  const fast = new NovaBeliefEngine();
  const rival = { id: 1, s: 480, q: 0, speed: 31, dq: 0, dv: 0 };
  slow.update([{ ...rival }], { s: 500, speed: 30, v: 0 }, 0.1);
  fast.update([{ ...rival }], { s: 500, speed: 40, v: 0 }, 0.1);
  assert.ok(slow.getBelief(1).ATTACK > fast.getBelief(1).ATTACK,
    'Only a rival closing in forward speed should increase attack intent');
});

test('NovaTopologyPlanner executes the selected station-indexed candidate at the host timestep', () => {
  const vf = new NovaValueField({ reference: NOVA_FREE_AIR });
  const belief = new NovaBeliefEngine();
  const planner = new NovaTopologyPlanner();

  const egoState = { s: 500, q: 0, v: 30, x: 0, y: 0, yaw: 0, yawRate: 0 };
  const opponents = [{ id: 'rival-1', s: 520, q: 0, v: 28, dq: 0, dv: 0 }];

  belief.update(opponents, egoState, 0.1);
  const plan = planner.plan(egoState, opponents, vf, belief, NOVA_FREE_AIR, 10.0, 1 / 120);

  assert.ok(plan.activeTopology, 'Active topology must be selected');
  assert.ok(['H_FOLLOW', 'H_OUTSIDE', 'H_INSIDE', 'H_SWITCHBACK'].includes(plan.activeTopology));
  assert.ok(plan.candidates.length === 4, 'Must evaluate 4 distinct homotopy classes');
  assert.ok(plan.candidates.every(c => Number.isFinite(c.cost)), 'All candidate costs must be finite');
  assert.equal(plan.planningDt, 1 / 120);
  assert.equal(plan.targetTrajectory, plan.candidates.find(c => c.topology === plan.activeTopology).trajectory);
  const lookStation = egoState.s + 25;
  const a = plan.targetTrajectory.findLast(p => p.s <= lookStation);
  const b = plan.targetTrajectory.find(p => p.s >= lookStation);
  const expectedQ = a.q + (b.q - a.q) * (lookStation - a.s) / (b.s - a.s);
  assert.ok(Math.abs(plan.targetQAt(lookStation) - expectedQ) < 1e-9);
  planner.plan(egoState, opponents, vf, belief, NOVA_FREE_AIR, 10 + 1 / 120, 1 / 120);
  assert.ok(Math.abs(planner.commitmentTime - 1 / 120) < 1e-12);
});

test('FOLLOW preserves the changing free-air line and leaves speed uncapped at a safe gap', () => {
  const planner = new NovaTopologyPlanner();
  const vf = new NovaValueField({ reference: NOVA_FREE_AIR });
  const ego = { s: 500, q: vf.sampleNominal(500).q, v: 40, id: 0 };
  const lead = { id: 1, s: 528, q: ego.q, speed: 38 };
  const plan = planner.plan(ego, [lead], vf, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(plan.activeTopology, 'H_FOLLOW');
  assert.equal(plan.targetSpeedCap, Infinity);
  for (const distance of [12, 35, 70]) {
    const actual = plan.targetQAt(ego.s + distance);
    const expected = vf.sampleNominal(ego.s + distance).q;
    assert.ok(Math.abs(actual - expected) < 0.05, `FOLLOW flattened the line at +${distance}m`);
  }
});

test('DEFEND slightly changes the apex while keeping the free-air entry and exit', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 2480, q: -4, v: 30 };
  const trailer = { id: 1, s: 2465, q: -4, speed: 37 };
  const plan = planner.plan(ego, [trailer], null, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(plan.phase, 'DEFEND_COMMITTED');
  assert.equal(plan.activeTopology, 'H_FOLLOW');
  assert.equal(plan.targetSpeedCap, Infinity);
  const start = plan.targetTrajectory[0];
  const middle = plan.targetTrajectory[6];
  const end = plan.targetTrajectory.at(-1);
  assert.ok(Math.abs(start.deformation) < 1e-9);
  assert.ok(Math.abs(middle.deformation) > 0.1 && Math.abs(middle.deformation) <= 0.45);
  assert.ok(Math.abs(end.deformation) < 1e-9);
});

test('ATTACK path rejoins the optimized free-air exit after clearing a rival', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 500, q: 0, v: 40 };
  const lead = { id: 1, s: 525, q: 0, speed: 25 };
  const path = planner._trajectory('H_OUTSIDE', ego, lead, 25, null, NOVA_FREE_AIR, 6.15);
  assert.ok(Math.abs(path[0].deformation) < 1e-9);
  assert.ok(path.some(p => p.deformation > 1.5), 'Attack needs a distinct apex');
  assert.ok(Math.abs(path.at(-1).deformation) < 0.05, 'Exit should return to the fast line');
});

test('Tactical horizon uses forward speed when the native state also has lateral velocity', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 500, q: 0, speed: 40, v: 0 };
  const lead = { id: 1, s: 522, q: 0, speed: 25 };
  const plan = planner.plan(ego, [lead], null, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.ok(Math.abs(plan.targetTrajectory.at(-1).s - 620) < 1e-9);
  assert.ok(plan.phase === 'ATTACK_COMMITTED' || plan.phase === 'PRE_OVERLAP' ||
    Number.isFinite(plan.targetSpeedCap), 'Closing-speed risk must be considered');
});

test('Predicted swept-body overlap, rather than mere proximity, authorizes a clearing cap', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 500, q: 0, speed: 58, v: 0 };
  const rival = { id: 1, s: 497, q: 3.2, speed: 60, dq: -2 };
  const belief = new NovaBeliefEngine();
  belief.update([rival], ego, 1 / 120);
  const plan = planner.plan(ego, [rival], null, belief, NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(plan.phase, 'CONCEDE');
  assert.ok(plan.targetSpeedCap < rival.speed && plan.targetSpeedCap >= 54, 'Dynamic yielding must resolve swept conflict without over-yielding');
  assert.equal(plan.targetSpeedCapReason, 'PREDICTED_SWEPT_CONFLICT');
  assert.ok(plan.sweptPrediction.peakRisk > 0.18);
  const safe = new NovaTopologyPlanner().plan(ego,
    [{ ...rival, q: 5.8, dq: 0 }], null, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(safe.targetSpeedCap, Infinity);
});

test('A braking lead triggers an early cap from its predicted swept conflict', () => {
  const belief = new NovaBeliefEngine();
  const ego = { id: 0, s: 500, q: 0, speed: 65 };
  const lead = { id: 1, s: 518, q: 0, speed: 58, dv: -7 };
  belief.update([lead], ego, 0.1);
  belief.getOccupancyTubes();
  const plan = new NovaTopologyPlanner().plan(ego, [lead], null, belief,
    NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(plan.activeTopology, 'H_FOLLOW');
  assert.equal(plan.targetSpeedCapReason, 'PREDICTED_LEAD_BRAKING');
  assert.ok(plan.sweptPrediction.firstTTC <= 2);
  assert.ok(plan.targetSpeedCap < lead.speed);
});

test('Lead and rear attacker keep separate collision predictions in three-car traffic', () => {
  const belief = new NovaBeliefEngine();
  const ego = { id: 0, s: 500, q: 0, speed: 65 };
  const opponents = [
    { id: 1, s: 518, q: 0, speed: 58, dv: -7 },
    { id: 2, s: 496, q: 3, speed: 67, dq: -1 },
  ];
  belief.update(opponents, ego, 0.1);
  belief.getOccupancyTubes();
  const plan = new NovaTopologyPlanner().plan(ego, opponents, null, belief,
    NOVA_FREE_AIR, 0, 1 / 120);
  assert.ok(plan.sweptPrediction.byOpponent[1].peakRisk > 0.35);
  assert.ok(plan.sweptPrediction.byOpponent[2].peakRisk > 0.35);
  assert.equal(plan.targetSpeedCapReason, 'PREDICTED_LEAD_BRAKING');
});

test('Three-wide overlap considers the closing third car, not only nearest car', () => {
  const belief = new NovaBeliefEngine();
  const ego = { id: 0, s: 500, q: 0, speed: 55 };
  const opponents = [
    { id: 1, s: 501, q: 3, speed: 56, dq: -1 },
    { id: 2, s: 503, q: -3, speed: 57, dq: 1 },
  ];
  belief.update(opponents, ego, 0.1);
  belief.getOccupancyTubes();
  const plan = new NovaTopologyPlanner().plan(ego, opponents, null, belief,
    NOVA_FREE_AIR, 0, 1 / 120);
  assert.ok(plan.sweptPrediction.byOpponent[1].peakRisk > 0.5);
  assert.ok(plan.sweptPrediction.byOpponent[2].peakRisk > 0.5);
  assert.equal(plan.targetSpeedCapReason, 'PREDICTED_SWEPT_CONFLICT');
  assert.ok(plan.targetSpeedCap < ego.speed);
});

test('A rival clear behind the rear bumper cannot push FOLLOW toward the road edge', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 860, q: 1.5, speed: 20 };
  const rival = { id: 1, s: 854.2, q: -1, speed: 20 };
  const plan = planner.plan(ego, [rival], null, null, NOVA_FREE_AIR, 0, 1 / 120);
  for (const node of plan.targetTrajectory) {
    assert.ok(Math.abs(node.deformation) < 1e-9, 'No body overlap means no lateral repulsion');
  }
});

test('Pass completion needs rear bumper clearance and a free return corridor', () => {
  const ego = { id: 0, s: 500, q: 0, speed: 30, halfLength: 2.325 };
  const rival = { id: 1, s: 493, q: 0, speed: 28, halfLength: 2.325 };
  const open = { freeIntervalsAt: () => [[-6.15, 6.15]], latestTubes: [] };
  const blocked = { freeIntervalsAt: () => [[-6.15, -4]], latestTubes: [] };
  const planner = new NovaTopologyPlanner();
  planner.lastAttackId = 1;
  const clear = planner.plan(ego, [rival], null, open, NOVA_FREE_AIR, 1, 1 / 120);
  assert.equal(clear.phase, 'PASS_COMPLETE');
  const tooClose = new NovaTopologyPlanner();
  tooClose.lastAttackId = 1;
  assert.notEqual(tooClose.plan(ego, [{ ...rival, s: 496 }], null, open,
    NOVA_FREE_AIR, 1, 1 / 120).phase, 'PASS_COMPLETE');
  const noExit = new NovaTopologyPlanner();
  noExit.lastAttackId = 1;
  assert.notEqual(noExit.plan(ego, [rival], null, blocked,
    NOVA_FREE_AIR, 1, 1 / 120).phase, 'PASS_COMPLETE');
});

test('Multi-car occupancy removes blocked pass corridors', () => {
  const belief = new NovaBeliefEngine();
  belief.update([
    { id: 1, s: 520, q: 0, speed: 30 },
    { id: 2, s: 520, q: 4, speed: 30 },
    { id: 3, s: 480, q: -3, speed: 33 },
  ], { s: 500, speed: 32 }, 0.1);
  belief.getOccupancyTubes(1, 0.25);
  const intervals = belief.freeIntervalsAt(520, 0, -6.15, 6.15, 2704.62);
  assert.ok(intervals.some(([lo, hi]) => hi < 0), 'Left passing corridor should remain');
  assert.ok(!intervals.some(([lo, hi]) => lo > 0), 'Third car blocks the right passing corridor');
});

test('Attack geometry follows reachable free space and rejects a blocked flank', () => {
  const belief = new NovaBeliefEngine();
  const ego = { id: 0, s: 500, q: 0, speed: 40 };
  const opponents = [
    { id: 1, s: 525, q: 0, speed: 25 },
    { id: 2, s: 525, q: 4, speed: 25 },
  ];
  belief.update(opponents, ego, 0.1);
  belief.getOccupancyTubes();
  const plan = new NovaTopologyPlanner().plan(ego, opponents, null, belief,
    NOVA_FREE_AIR, 0, 1 / 120);
  const inside = plan.candidates.find(c => c.topology === 'H_INSIDE');
  const outside = plan.candidates.find(c => c.topology === 'H_OUTSIDE');
  assert.equal(inside.trajectory.corridorFeasible, true);
  assert.equal(outside.trajectory.corridorFeasible, false);
  assert.ok(inside.trajectory.encounterCorridor[1] < 0);
  assert.ok(inside.rollout.duration > 0 && inside.rollout.exitSpeed > 0);
  assert.ok(inside.cost < outside.cost);
});

test('A reachable faster pass stays available with a small closing speed', () => {
  const reference = { q: Array(1000).fill(0), v: Array(1000).fill(25),
    kappa: Array(1000).fill(0), ds: 3, length: 3000, halfWidth: 8.2 };
  const ego = { id: 0, s: 500, q: 0, speed: 20 };
  const lead = { id: 1, s: 507, q: 0, speed: 19 };
  const belief = new NovaBeliefEngine();
  belief.update([lead], ego, 0.1);
  belief.getOccupancyTubes();
  const plan = new NovaTopologyPlanner().plan(ego, [lead], null, belief,
    reference, 0, 1 / 120);
  assert.equal(plan.activeTopology, 'H_OUTSIDE');
  assert.equal(plan.phase, 'ATTACK_COMMITTED');
  assert.equal(plan.targetSpeedCap, Infinity,
    'A clear selected pass must not inherit a close-follow brake');
});

test('A failed attack aborts cleanly and permits immediate defense', () => {
  const planner = new NovaTopologyPlanner();
  planner.lastAttackId = 1;
  planner.targetId = 1;
  planner.selectedSide = 1;
  planner.commitmentTime = 3;
  const ego = { id: 0, s: 500, q: 0, speed: 30 };
  const abandoned = planner.plan(ego, [{ id: 1, s: 535, q: 0, speed: 31 }],
    null, null, NOVA_FREE_AIR, 10, 1 / 120);
  assert.equal(abandoned.phase, 'ABORT');
  assert.equal(planner.selectedSide, 0);
  assert.ok(planner.attackCooldownUntil > 10);
  const defended = planner.plan(ego, [{ id: 2, s: 490, q: 5, speed: 36 }],
    null, null, NOVA_FREE_AIR, 10.5, 1 / 120);
  assert.equal(defended.phase, 'DEFEND_COMMITTED');
});

test('Traffic exit brakes only when measured lateral motion predicts road-edge crossing', () => {
  const planner = new NovaTopologyPlanner();
  const rival = { id: 1, s: 490, q: -3, speed: 15 };
  const ego = { id: 0, s: 500, q: 5, speed: 20 };
  const first = planner.plan(ego, [rival], null, null, NOVA_FREE_AIR, 0, 0.1);
  assert.equal(first.targetSpeedCap, Infinity);
  const second = planner.plan({ ...ego, s: 502, q: 6.2 }, [rival], null,
    null, NOVA_FREE_AIR, 0.1, 0.1);
  assert.equal(second.targetSpeedCapReason, 'PREDICTED_EDGE_CROSSING');
  assert.ok(second.targetSpeedCap < ego.speed);
});

test('NovaCoupledController executes predictive braking and coupled steering with zero NaN', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });

  const obs = {
    ego: { s: 1300, q: 0, speed: 45, x: 0, z: 0, yaw: 0, yawRate: 0, spec: car.spec },
    dt: 1 / 120,
  };

  const cmd = cc.step(obs);
  assert.ok(Number.isFinite(cmd.steer), 'Steer command must be finite');
  assert.ok(Number.isFinite(cmd.throttle), 'Throttle command must be finite');
  assert.ok(Number.isFinite(cmd.brake), 'Brake command must be finite');
  assert.ok(cmd.brake > 0, 'Car at 45m/s before hairpin must command threshold braking');
});

test('NovaCoupledController commands 100% wide open throttle and zero braking on straightaways', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });

  // Test across multiple speeds along the 341m main straight (s = 500m)
  for (const testSpeed of [25, 35, 45, 50]) {
    const obs = {
      ego: { s: 500, q: 0, speed: testSpeed, x: 0, z: 0, yaw: 0, yawRate: 0, spec: car.spec },
      dt: 1 / 120,
    };
    const cmd = cc.step(obs);
    assert.equal(cmd.throttle, 1.0, `At speed ${testSpeed} m/s on open straight, throttle must be 1.0 (100%)`);
    assert.equal(cmd.brake, 0.0, `At speed ${testSpeed} m/s on open straight, brake must be 0.0`);
    assert.equal(cc.state.plannedBrake, false, `At speed ${testSpeed} m/s on open straight, plannedBrake must be false`);
  }
});

test('NovaCoupledController samples the selected path at its steering lookahead', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });
  const stations = [];
  const here = cc.sample(500);
  cc.step({
    ego: { s: 500, q: here.q, speed: 40, x: here.x, z: here.z,
      yaw: here.heading, yawRate: 0, spec: car.spec },
    dt: 1 / 120,
  }, {
    activeTopology: 'H_OUTSIDE',
    targetQAt: s => { stations.push(s); return cc.sample(s).q + 1; },
    targetSpeedCap: Infinity,
  });
  assert.ok(stations.some(s => s > 515), 'Steering must query the selected candidate ahead of the car');
});

test('NovaDriver wires all components into Session seamlessly', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  session.mode = 'practice';
  session.laps = 1;
  session.autopilot = true;
  session.start();

  const driver = session.drivers[0];
  assert.ok(driver.ai instanceof NovaDriver, 'Primary driver must be NovaDriver');
  assert.ok(driver.ai.valueField instanceof NovaValueField);
  assert.ok(driver.ai.beliefEngine instanceof NovaBeliefEngine);
  assert.ok(driver.ai.topologyPlanner instanceof NovaTopologyPlanner);
  assert.ok(driver.ai.coupledController instanceof NovaCoupledController);

  session.phase = 'racing';
  session.countdown = 0;
  // Step session for 1 second (120 ticks) of active racing
  for (let i = 0; i < 120; i++) {
    session.step(1 / 120, { throttle: 0, brake: 0, steer: 0 });
  }

  assert.ok(driver.ai.novaTime > 0.9, 'Nova active time must be accumulated');
  assert.equal(driver.ai.topologyResult.planningDt, 1 / 120, 'Host timestep must reach tactical planner');
  assert.equal(driver.ai.legacyTime, 0, 'Legacy fallback time must be 0');
  assert.equal(driver.ai.fallbackCount, 0, 'Fallback count must be 0');
  assert.equal(driver.ai.strictFail, null, 'Strict fail must be null');
  assert.equal(driver.ai.state.mode, 'NOVA', 'State mode must be NOVA');
  assert.ok(driver.ai.line, 'Driver must expose .line view');
  const oldPlanner = driver.ai.topologyPlanner;
  driver.ai.reset();
  assert.notEqual(driver.ai.topologyPlanner, oldPlanner,
    'A restarted race must discard tactical commitment and lateral history');
  assert.equal(driver.ai.topologyPlanner.lastEgoQ, null);
});

test('SPATIAL_REFERENCE_HASH remains identical to frozen baseline', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const baseline = JSON.parse(readFileSync('artifacts/nova-live-spatial-baseline-v1.json', 'utf8'));

  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const line = session.line;

  const hash = createHash('sha256');
  for (const arr of [line.q, line.path.px, line.path.pz, line.path.heading, line.path.kappa]) {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    hash.update(buf);
  }
  const currentHash = hash.digest('hex');

  assert.equal(
    currentHash,
    baseline.reference.spatialReferenceHash,
    'SPATIAL_REFERENCE_HASH must match frozen baseline: spatial trajectory must never mutate!'
  );
});

test('NovaCoupledController exposes complete longitudinal causal trace and reason enums', async () => {
  const { TARGET_LIMIT_REASON, THROTTLE_LIMIT_REASON, BRAKE_REASON } = await import('../src/ai/nova/index.js');

  assert.ok(TARGET_LIMIT_REASON.REFERENCE_PROFILE, 'TARGET_LIMIT_REASON enum must be exported');
  assert.ok(THROTTLE_LIMIT_REASON.TARGET_REACHED, 'THROTTLE_LIMIT_REASON enum must be exported');
  assert.ok(BRAKE_REASON.UPCOMING_SPEED_CONSTRAINT, 'BRAKE_REASON enum must be exported');

  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });

  // Test on open straight
  const hereStraight = cc.sample(500);
  const straightObs = {
    ego: { s: 500, q: 0, speed: 40, x: 0, z: 0, yaw: hereStraight.heading, yawRate: 0, spec: car.spec },
    dt: 1 / 120,
  };
  cc.step(straightObs);

  assert.equal(cc.state.throttleLimitReason, THROTTLE_LIMIT_REASON.NONE, 'Straight throttle limit reason must be NONE');
  assert.equal(cc.state.brakeReason, BRAKE_REASON.NONE, 'Straight brake reason must be NONE');
  assert.equal(cc.state.clearFullThrottleEligible, true, 'Straight must be clear full throttle eligible');
  assert.ok(Number.isFinite(cc.state.brakingMarginMeters), 'Braking margin must be finite');

  // Test approaching tight hairpin
  const hairpinObs = {
    ego: { s: 1300, q: 0, speed: 45, x: 0, z: 0, yaw: 0, yawRate: 0, spec: car.spec },
    dt: 1 / 120,
  };
  cc.step(hairpinObs);

  assert.equal(cc.state.brakeReason, BRAKE_REASON.UPCOMING_SPEED_CONSTRAINT, 'Hairpin approach brake reason must be UPCOMING_SPEED_CONSTRAINT');
  assert.equal(cc.state.throttleLimitReason, THROTTLE_LIMIT_REASON.UPCOMING_BRAKING, 'Hairpin approach throttle limit reason must be UPCOMING_BRAKING');
});

test('Stable high-G sideslip in left and right corners does not trigger false countersteer', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });

  // Station 1630m: Left turn (kappa < 0)
  const leftTurnSample = cc.sample(1630);
  const leftTurnObs = {
    ego: {
      s: 1630,
      q: leftTurnSample.q,
      speed: 32, // ~115 km/h
      x: leftTurnSample.x,
      z: leftTurnSample.z,
      yaw: leftTurnSample.heading,
      yawRate: -0.45, // turning left (yawRate < 0)
      u: 32 * Math.cos(0.075),
      v: 32 * Math.sin(0.075), // lateral slip outward (to the right, positive)
      spec: car.spec,
      wheels: car.wheels,
    },
    dt: 1 / 120,
  };
  const leftCmd = cc.step(leftTurnObs);
  assert.equal(cc.state.isOversteering, false, 'Stable sideslip beta ~ 0.075 rad must not trigger oversteer flag');
  assert.equal(cc.state.debugSteer.betaExcess, 0, 'Beta excess countersteer must be zero during stable cornering');

  // Station 2105m: Right turn (kappa > 0)
  const rightTurnSample = cc.sample(2105);
  const rightTurnObs = {
    ego: {
      s: 2105,
      q: rightTurnSample.q,
      speed: 25,
      x: rightTurnSample.x,
      z: rightTurnSample.z,
      yaw: rightTurnSample.heading,
      yawRate: 0.2,
      u: 25 * Math.cos(-0.075),
      v: 25 * Math.sin(-0.075), // lateral slip outward (to the left, negative)
      spec: car.spec,
      wheels: car.wheels,
    },
    dt: 1 / 120,
  };
  const rightCmd = cc.step(rightTurnObs);
  assert.equal(cc.state.isOversteering, false, 'Stable sideslip beta ~ -0.075 rad must not trigger oversteer flag');
  assert.equal(cc.state.debugSteer.betaExcess, 0, 'Beta excess countersteer must be zero during stable cornering');
});

test('Axle saturation oversteer triggers corrective countersteer with mirrored signs', () => {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const car = session.cars[0];
  const cc = new NovaCoupledController({
    reference: NOVA_FREE_AIR,
    envelope: session.lineFor(car).envelope,
    model: session.model,
  });

  // Severe oversteer in left turn: tail sliding right, beta = +0.16 rad, rear saturation satR > 1.05
  const leftSample = cc.sample(1630);
  const leftOversteerObs = {
    ego: {
      s: 1630,
      q: leftSample.q,
      speed: 30,
      x: leftSample.x,
      z: leftSample.z,
      yaw: leftSample.heading,
      yawRate: -0.9,
      u: 30 * Math.cos(0.16),
      v: 30 * Math.sin(0.16),
      spec: car.spec,
      wheels: car.wheels,
    },
    dt: 1 / 120,
  };
  cc.step(leftOversteerObs);
  assert.equal(cc.state.isOversteering, true, 'Severe rear saturation satR > 1.05 must flag oversteer');
  assert.ok(cc.state.debugSteer.betaExcess > 0, 'Left turn oversteer must have positive betaExcess for rightward countersteer');

  // Severe oversteer in right turn: tail sliding left, beta = -0.16 rad, rear saturation satR > 1.05
  const rightSample = cc.sample(800);
  const rightOversteerObs = {
    ego: {
      s: 800,
      q: rightSample.q,
      speed: 30,
      x: rightSample.x,
      z: rightSample.z,
      yaw: rightSample.heading,
      yawRate: 0.9,
      u: 30 * Math.cos(-0.16),
      v: 30 * Math.sin(-0.16),
      spec: car.spec,
      wheels: car.wheels,
    },
    dt: 1 / 120,
  };
  cc.step(rightOversteerObs);
  assert.equal(cc.state.isOversteering, true, 'Severe rear saturation satR > 1.05 must flag oversteer');
  assert.ok(cc.state.debugSteer.betaExcess < 0, 'Right turn oversteer must have negative betaExcess for leftward countersteer');
});

