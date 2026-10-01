import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NovaBeliefEngine, INTENT_MODES, DEFAULT_PRIOR } from '../src/ai/nova/belief-occupancy.js';

test('R1-1: Opponent physical state estimation separates kinematics from intent probabilities', () => {
  const engine = new NovaBeliefEngine();
  const opponent = { id: 'rival-A', s: 200, q: 1.5, v: 40 };
  const ego = { s: 180, q: 0.0, v: 40 };

  engine.update([opponent], ego, 0.05);

  const phys = engine.getPhysicalState('rival-A');
  assert.ok(phys, 'Physical state must exist');
  assert.equal(phys.s, 200);
  assert.equal(phys.q, 1.5);
  assert.equal(phys.v, 40);
  assert.ok(Number.isFinite(phys.sigma_s0), 'Must have separate spatial uncertainty sigma_s');
  assert.ok(Number.isFinite(phys.sigma_q0), 'Must have separate lateral uncertainty sigma_q');

  const belief = engine.getBelief('rival-A');
  assert.ok(belief, 'Intent belief must exist');
  for (const mode of INTENT_MODES) {
    assert.ok(Number.isFinite(belief[mode]), `Mode ${mode} must be finite`);
    assert.ok(belief[mode] >= 0 && belief[mode] <= 1.0, `Mode ${mode} must be valid probability`);
  }
  const sum = INTENT_MODES.reduce((acc, m) => acc + belief[m], 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-4, 'Intent posterior must normalize to 1.0');
});

test('R1-2: Constant speed and steady lateral position drives posterior toward HOLD', () => {
  const engine = new NovaBeliefEngine();
  let opponent = { id: 'rival-steady', s: 300, q: 0.0, v: 45, dq: 0, dv: 0 };
  const ego = { s: 260, q: 0.0, v: 45 };

  // Simulate 10 update cycles of steady tracking
  for (let step = 0; step < 10; step++) {
    opponent = { id: 'rival-steady', s: 300 + step * 45 * 0.05, q: 0.0, v: 45, dq: 0, dv: 0 };
    engine.update([opponent], ego, 0.05);
  }

  const b = engine.getBelief('rival-steady');
  assert.ok(b.HOLD > DEFAULT_PRIOR.HOLD, `P(HOLD) (${b.HOLD.toFixed(3)}) must increase from prior (${DEFAULT_PRIOR.HOLD})`);
  assert.ok(b.HOLD > b.DEFEND_LEFT, 'HOLD must exceed DEFEND_LEFT for steady car');
  assert.ok(b.HOLD > b.DEFEND_RIGHT, 'HOLD must exceed DEFEND_RIGHT for steady car');
  assert.ok(b.HOLD > b.BRAKE_EARLY, 'HOLD must exceed BRAKE_EARLY for steady car');
});

test('R1-3: Lateral shifts left and right decisively increase DEFEND_LEFT and DEFEND_RIGHT', () => {
  const engineLeft = new NovaBeliefEngine();
  const engineRight = new NovaBeliefEngine();
  const ego = { s: 400, q: 0.0, v: 40 };

  // Rival 1 shifts left (dq < -0.3 m/s)
  for (let step = 0; step < 8; step++) {
    const opp = { id: 'rival-left', s: 420 + step * 2, q: -0.5 - step * 0.05, v: 40, dq: -0.35, dv: 0 };
    engineLeft.update([opp], ego, 0.05);
  }
  const bLeft = engineLeft.getBelief('rival-left');
  assert.ok(bLeft.DEFEND_LEFT > DEFAULT_PRIOR.DEFEND_LEFT * 1.5, `P(DEFEND_LEFT) (${bLeft.DEFEND_LEFT.toFixed(3)}) must increase significantly`);
  assert.ok(bLeft.DEFEND_LEFT > bLeft.DEFEND_RIGHT, 'DEFEND_LEFT must exceed DEFEND_RIGHT when moving left');

  // Rival 2 shifts right (dq > 0.3 m/s)
  for (let step = 0; step < 8; step++) {
    const opp = { id: 'rival-right', s: 420 + step * 2, q: 0.5 + step * 0.05, v: 40, dq: 0.35, dv: 0 };
    engineRight.update([opp], ego, 0.05);
  }
  const bRight = engineRight.getBelief('rival-right');
  assert.ok(bRight.DEFEND_RIGHT > DEFAULT_PRIOR.DEFEND_RIGHT * 1.5, `P(DEFEND_RIGHT) (${bRight.DEFEND_RIGHT.toFixed(3)}) must increase significantly`);
  assert.ok(bRight.DEFEND_RIGHT > bRight.DEFEND_LEFT, 'DEFEND_RIGHT must exceed DEFEND_LEFT when moving right');
});

test('R1-4: Rapid deceleration before corner decisively increases BRAKE_EARLY', () => {
  const engine = new NovaBeliefEngine();
  const ego = { s: 780, q: -2.0, v: 50 };

  // Opponent decelerating heavily at -4 m/s^2 before braking zone
  for (let step = 0; step < 6; step++) {
    const opp = { id: 'rival-brake', s: 820 + step * 2, q: -2.0, v: 50 - step * 1.5, dq: 0, dv: -4.0 };
    engine.update([opp], ego, 0.05);
  }

  const b = engine.getBelief('rival-brake');
  assert.ok(b.BRAKE_EARLY > DEFAULT_PRIOR.BRAKE_EARLY * 1.8, `P(BRAKE_EARLY) (${b.BRAKE_EARLY.toFixed(3)}) must rise significantly on hard braking`);
  assert.ok(b.BRAKE_EARLY > b.BRAKE_NORMAL, 'BRAKE_EARLY must exceed BRAKE_NORMAL under early deceleration');
});

test('R1-5: Multimodal space-time occupancy tubes expand physical uncertainty and test occupancy', () => {
  const engine = new NovaBeliefEngine();
  const opp = { id: 'rival-tube', s: 500, q: 0.0, v: 30, dq: 0, dv: 0 };
  const ego = { s: 470, q: 0.0, v: 35 };

  const tubes = engine.update([opp], ego, 0.1);
  assert.ok(Array.isArray(tubes) && tubes.length === 1, 'Must generate occupancy tubes for rival');

  const oppTube = tubes[0];
  assert.equal(oppTube.id, 'rival-tube');
  assert.ok(oppTube.tubes.length >= 10, 'Must have time-discretized segments');

  // Verify uncertainty growth
  const seg0 = oppTube.tubes[0];
  const segEnd = oppTube.tubes[oppTube.tubes.length - 1];
  assert.ok(segEnd.sigma_s > seg0.sigma_s, 'Longitudinal uncertainty sigma_s must grow over time horizon');
  assert.ok(segEnd.sigma_q > seg0.sigma_q, 'Lateral uncertainty sigma_q must grow over time horizon');

  // Spatio-temporal occupancy test
  // At t = 0.5s: opponent is at s = 500 + 30 * 0.5 = 515, q = 0.0
  assert.ok(engine.isOccupied(515, 0.0, 0.5), 'Point (515, 0.0) at t=0.5s must be occupied');
  assert.ok(!engine.isOccupied(515, 5.0, 0.5), 'Point (515, 5.0) at t=0.5s must be free');

  // Clearance corridor check at encounter s = 515
  const corridors = engine.getClearanceCorridors(515, -8.2, 8.2);
  assert.ok(Array.isArray(corridors) && corridors.length >= 1, 'Must produce clearance corridors');
  for (const [qMin, qMax] of corridors) {
    assert.ok(qMax > qMin, 'Corridor must have positive width');
    assert.ok(qMin >= -8.2 && qMax <= 8.2, 'Corridor must remain within legal track limits');
  }
});

test('R1-6: Generates verified artifact artifacts/racecraft-r1-beliefs.json', () => {
  const engine = new NovaBeliefEngine();
  const ego = { s: 500, q: 0.0, v: 42 };

  const scenarios = [
    { name: 'steady_hold', opp: { id: 'steady', s: 530, q: 0.0, v: 42, dq: 0.0, dv: 0.0 }, steps: 10 },
    { name: 'defense_left', opp: { id: 'def_left', s: 530, q: -1.5, v: 42, dq: -0.4, dv: 0.0 }, steps: 8 },
    { name: 'defense_right', opp: { id: 'def_right', s: 530, q: 1.5, v: 42, dq: 0.4, dv: 0.0 }, steps: 8 },
    { name: 'early_brake', opp: { id: 'early_brk', s: 530, q: 0.0, v: 38, dq: 0.0, dv: -3.5 }, steps: 6 },
    { name: 'attack_chase', opp: { id: 'attacker', s: 480, q: 0.5, v: 46, dq: 0.1, dv: 1.0 }, steps: 8 }
  ];

  const scenarioResults = {};

  for (const sc of scenarios) {
    const scEngine = new NovaBeliefEngine();
    for (let i = 0; i < sc.steps; i++) {
      const liveOpp = {
        id: sc.opp.id,
        s: sc.opp.s + i * sc.opp.v * 0.05,
        q: sc.opp.q + i * sc.opp.dq * 0.05,
        v: sc.opp.v + i * sc.opp.dv * 0.05,
        dq: sc.opp.dq,
        dv: sc.opp.dv
      };
      scEngine.update([liveOpp], ego, 0.05);
    }

    const b = scEngine.getBelief(sc.opp.id);
    const phys = scEngine.getPhysicalState(sc.opp.id);
    const tubes = scEngine.latestTubes;

    scenarioResults[sc.name] = {
      opponentId: sc.opp.id,
      steps: sc.steps,
      finalPhysicalState: {
        s: +phys.s.toFixed(2),
        q: +phys.q.toFixed(2),
        v: +phys.v.toFixed(2),
        qDot: +phys.qDot.toFixed(3),
        vDot: +phys.vDot.toFixed(3),
        sigma_s0: phys.sigma_s0,
        sigma_q0: phys.sigma_q0
      },
      intentPosterior: Object.fromEntries(
        INTENT_MODES.map(m => [m, +b[m].toFixed(4)])
      ),
      occupancyTubeSummary: {
        numSegments: tubes[0]?.tubes?.length ?? 0,
        horizonS: 3.0,
        t0_bounds: {
          s_min: +tubes[0]?.tubes[0]?.s_min.toFixed(2),
          s_max: +tubes[0]?.tubes[0]?.s_max.toFixed(2),
          q_min: +tubes[0]?.tubes[0]?.q_min.toFixed(2),
          q_max: +tubes[0]?.tubes[0]?.q_max.toFixed(2)
        },
        tEnd_bounds: {
          s_min: +tubes[0]?.tubes?.at(-1)?.s_min.toFixed(2),
          s_max: +tubes[0]?.tubes?.at(-1)?.s_max.toFixed(2),
          q_min: +tubes[0]?.tubes?.at(-1)?.q_min.toFixed(2),
          q_max: +tubes[0]?.tubes?.at(-1)?.q_max.toFixed(2)
        }
      }
    };
  }

  const artifact = {
    wave: 'R1',
    title: 'Opponent Physical-State Estimation & Latent Intent Posterior Verification',
    timestamp: new Date().toISOString(),
    modes: INTENT_MODES,
    defaultPrior: DEFAULT_PRIOR,
    scenarios: scenarioResults
  };

  const artifactPath = resolve('artifacts/racecraft-r1-beliefs.json');
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  assert.ok(scenarioResults.steady_hold.intentPosterior.HOLD > 0.40);
  assert.ok(scenarioResults.defense_left.intentPosterior.DEFEND_LEFT > 0.20);
  assert.ok(scenarioResults.defense_right.intentPosterior.DEFEND_RIGHT > 0.20);
  assert.ok(scenarioResults.early_brake.intentPosterior.BRAKE_EARLY > 0.25);
  assert.ok(scenarioResults.attack_chase.intentPosterior.ATTACK > 0.20);
});
