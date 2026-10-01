/**
 * Racecraft V4.1 Regression & Feature Test Suite
 * 
 * Verifies all interaction-centric racecraft correctness requirements:
 * 1. Longitudinal clearance dimensioning
 * 2. Separation of competitiveRole (ACTIVE_RACER/FINISHED_CAR) from dynamicState (NORMAL/SLOW/STOPPED/STRANDED/REJOINING)
 * 3. Full progression against numeric ID 0 (BEHIND -> PRE_OVERLAP -> OVERLAPPING -> CLEARING -> PASS_COMPLETE)
 * 4. Real track-relative lateral velocity dq = vx * nx + vz * nz and convergence detection
 * 5. Rejoining cars handled as dynamic hazards (not active rivals, not static obstacles)
 * 6. Multi-obstacle regression (3 stopped cars, smooth momentum vs. blocked braking)
 * 7. Three-wide overlap diagnostics
 * 8. Deterministic side-by-side corner corridor ownership (Scenarios A through E)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEMANTIC_ROLE,
  COMPETITIVE_ROLE,
  DYNAMIC_STATE,
  classifyCompetitor,
  classifyOpponentRole,
  isObstacleRole,
  isRacingCompetitor,
  isDynamicHazard,
  InteractionEpisode,
  RELATIVE_BODY_STATE,
  ATTACK_PHASE,
  EpisodeTracker,
  NovaTopologyPlanner,
  RACECRAFT_PHASE
} from '../src/ai/nova/index.js';
import { observeVehicle } from '../src/sim/native-adapter.js';
import { NOVA_FREE_AIR } from '../src/tracks/lines/harbor-ring-nova.js';
import { NovaBeliefEngine } from '../src/ai/nova/belief-occupancy.js';

test('V4-1: Longitudinal clearance uses body lengths (egoHalfLength + rivalHalfLength), not half-width', () => {
  const ego = { id: 0, s: 500, q: 0, speed: 40, halfLength: 2.325, halfWidth: 1.01 };
  const rival = { id: 1, s: 504.0, q: 0, speed: 40, halfLength: 2.325, halfWidth: 1.01 };
  
  const ep = new InteractionEpisode(rival.id, SEMANTIC_ROLE.ACTIVE_RACER, 0);
  ep.update({ ego, rival, currentTime: 0, dt: 1 / 120, trackLength: 2704.62, legalQ: 6.2, freeExitAvailable: true });
  
  assert.equal(ep.bodyState, RELATIVE_BODY_STATE.OVERLAPPING, 'Longitudinal overlap must detect body collision at ds = 4.0m');
  assert.ok(ep.longitudinalOverlap > 0.5, 'Physical longitudinal overlap depth must be positive');
});

test('V4.1-2: Separates competitiveRole from dynamicState (braking rivals remain ACTIVE_RACER)', () => {
  const ego = { id: 1, s: 500, q: 0, speed: 52, v: 52 };

  // 1. Gemini braking heavily into hairpin (speed deficit > 20 m/s):
  // MUST remain ACTIVE_RACER + SLOW, must NOT leave tactical racecraft!
  const geminiBraking = { id: 2, s: 525, q: 1.5, speed: 28, v: 28, finished: false, raceActive: true };
  const cGemini = classifyCompetitor(geminiBraking, ego);
  assert.equal(cGemini.competitiveRole, COMPETITIVE_ROLE.ACTIVE_RACER);
  assert.equal(cGemini.dynamicState, DYNAMIC_STATE.SLOW);
  assert.ok(isRacingCompetitor(cGemini), 'Heavy braking rival must remain in tactical racecraft');
  assert.equal(isObstacleRole(cGemini), false, 'Heavy braking rival must not be an obstacle');
  assert.equal(isDynamicHazard(cGemini), false);

  // 2. Finished car crawling after chequered flag:
  // MUST be FINISHED_CAR + SLOW and leave tactical racecraft!
  const finishedCar = { id: 3, s: 520, q: 2, speed: 12, finished: true };
  const cFinished = classifyCompetitor(finishedCar, ego);
  assert.equal(cFinished.competitiveRole, COMPETITIVE_ROLE.FINISHED_CAR);
  assert.equal(cFinished.dynamicState, DYNAMIC_STATE.SLOW);
  assert.equal(isRacingCompetitor(cFinished), false, 'Finished car must not be a tactical combat rival');
  assert.ok(isObstacleRole(cFinished), 'Finished car must be an obstacle to bypass');
  assert.equal(isDynamicHazard(cFinished), false);

  // 3. Rejoining car returning to track:
  // MUST be dynamic hazard, neither active combat rival nor static obstacle!
  const rejoiningCar = { id: 4, s: 540, q: 7.8, dq: -1.5, speed: 22, finished: false, raceActive: true };
  const cRejoining = classifyCompetitor(rejoiningCar, ego);
  assert.equal(cRejoining.dynamicState, DYNAMIC_STATE.REJOINING);
  assert.ok(isDynamicHazard(cRejoining), 'Rejoining car must be classified as a dynamic hazard');
  assert.equal(isRacingCompetitor(cRejoining), false, 'Rejoining car must not be an overtaking rival');
  assert.equal(isObstacleRole(cRejoining), false, 'Rejoining car must not be a static obstacle');

  // 4. Stranded / stopped vehicle on or off track:
  const stoppedCar = { id: 5, s: 530, q: 1.0, speed: 0.5 };
  const cStopped = classifyCompetitor(stoppedCar, ego);
  assert.equal(cStopped.dynamicState, DYNAMIC_STATE.STOPPED);
  assert.ok(isObstacleRole(cStopped), 'Stopped car must be an obstacle');
  assert.equal(isRacingCompetitor(cStopped), false);
});

test('V4.1-1: Host car ID 0 and rival ID 0 full progression BEHIND -> PRE_OVERLAP -> OVERLAPPING -> CLEARING -> PASS_COMPLETE', () => {
  const tracker = new EpisodeTracker();
  // Ego has id: 1, Rival has id: 0
  const ego = { id: 1, s: 500, q: -2.0, speed: 45, v: 45, halfLength: 2.325, halfWidth: 1.01 };
  const rival = { id: 0, s: 512, q: 2.0, speed: 40, v: 40, halfLength: 2.325, halfWidth: 1.01 };

  // Frame 1: Approach from behind (ds = +12m)
  tracker.update({ ego, opponents: [rival], currentTime: 0, dt: 0.1 });
  assert.notEqual(tracker.getEpisode(0), null, 'getEpisode(0) must not return null');
  const episode = tracker.getEpisode(0);
  assert.equal(episode.rivalId, 0, 'Episode rivalId must be numeric 0');
  
  episode.hasInitiatedAttack = true;
  episode.selectedSide = -1;
  episode.attackPhase = ATTACK_PHASE.COMMITTED;
  tracker.activeRivalId = 0;
  assert.equal(tracker.activeRivalId, 0);
  assert.equal(tracker.getActiveEpisode(), episode, 'getActiveEpisode() must return episode for ID 0');
  assert.equal(episode.bodyState, RELATIVE_BODY_STATE.BEHIND);

  // Frame 2: Closing in, pre-overlap (ds = +6.0m)
  rival.s = 506.0;
  tracker.update({ ego, opponents: [rival], currentTime: 0.5, dt: 0.1 });
  assert.equal(episode.bodyState, RELATIVE_BODY_STATE.PRE_OVERLAP);
  assert.equal(tracker.activeRivalId, 0);

  // Frame 3: Longitudinal overlap (ds = +2.0m)
  rival.s = 502.0;
  tracker.update({ ego, opponents: [rival], currentTime: 1.0, dt: 0.1 });
  assert.equal(episode.bodyState, RELATIVE_BODY_STATE.OVERLAPPING);
  assert.equal(episode.attackPhase, ATTACK_PHASE.SIDE_BY_SIDE);
  assert.equal(tracker.activeRivalId, 0);
  assert.equal(tracker.getActiveEpisode(), episode);

  // Frame 4: Clearing past rival front bumper (ds = -6.0m)
  rival.s = 494.0;
  tracker.update({ ego, opponents: [rival], currentTime: 1.5, dt: 0.1 });
  assert.equal(episode.bodyState, RELATIVE_BODY_STATE.CLEARING);
  assert.equal(episode.attackPhase, ATTACK_PHASE.CLEARING);
  assert.equal(tracker.activeRivalId, 0);

  // Frame 5: Fully clear with > 1.8m rear bumper clearance (ds = -8.5m)
  rival.s = 491.5;
  tracker.update({ ego, opponents: [rival], currentTime: 2.0, dt: 0.1 });
  assert.equal(episode.bodyState, RELATIVE_BODY_STATE.PASS_COMPLETE);
  assert.equal(episode.attackPhase, ATTACK_PHASE.COMPLETED);
  assert.equal(episode.passCompleted, true);
});

test('V4.1-3: Real track-relative lateral velocity dq = vx * nx + vz * nz computed in native adapter', () => {
  const car = {
    id: 0, x: 100, z: 200, s: 50, lateral: 1.5,
    vx: 15.0, vz: 20.0, speed: 25.0, yaw: 0,
    controls: { throttle: 0, brake: 0, steer: 0 },
    wheels: []
  };
  const rival = {
    id: 1, x: 105, z: 205, s: 55, lateral: -1.0,
    vx: -8.0, vz: 18.0, speed: 19.7, yaw: 0,
    controls: { throttle: 0, brake: 0, steer: 0 },
    wheels: []
  };

  // Mock track context providing normal n = (0.6, 0.8) and tangent t = (0.8, -0.6)
  const context = {
    projections: new Map([
      [0, { nx: 0.6, nz: 0.8, tx: 0.8, tz: -0.6 }],
      [1, { nx: 0.6, nz: 0.8, tx: 0.8, tz: -0.6 }]
    ]),
    time: 1.0
  };

  const obs = observeVehicle(car, [car, rival], context, 1 / 120);

  // Ego: vx*nx + vz*nz = 15*0.6 + 20*0.8 = 9 + 16 = 25.0 m/s
  assert.ok(Math.abs(obs.ego.lateralVelocity - 25.0) < 1e-4);
  assert.ok(Math.abs(obs.ego.dq - 25.0) < 1e-4);

  // Rival: vx*nx + vz*nz = -8*0.6 + 18*0.8 = -4.8 + 14.4 = 9.6 m/s
  const rObs = obs.rivals[0];
  assert.ok(Math.abs(rObs.lateralVelocity - 9.6) < 1e-4);
  assert.ok(Math.abs(rObs.dq - 9.6) < 1e-4);
  assert.ok(Number.isFinite(rObs.longitudinalVelocity));
});

test('V4.1-4: Three-wide overlap condition generates explicit diagnostics', () => {
  const tracker = new EpisodeTracker();
  const ego = { id: 0, s: 500, q: 0.0, speed: 40, v: 40, halfLength: 2.325, halfWidth: 1.01 };
  const rivalLeft = { id: 1, s: 500.5, q: -2.8, speed: 40, v: 40, halfLength: 2.325, halfWidth: 1.01 };
  const rivalRight = { id: 2, s: 499.5, q: +2.8, speed: 40, v: 40, halfLength: 2.325, halfWidth: 1.01 };

  tracker.update({ ego, opponents: [rivalLeft, rivalRight], currentTime: 0, dt: 1 / 120 });

  assert.equal(tracker.isThreeWide, true, 'Must detect three-wide sandwich');
  assert.ok(tracker.threeWideDetails !== null);
  assert.equal(tracker.threeWideDetails.leftRivalId, 1);
  assert.equal(tracker.threeWideDetails.rightRivalId, 2);
  assert.ok(tracker.threeWideDetails.availableWidth > 3.0);
});

test('V4.1-5: Multi-obstacle regression: continuous momentum when passable vs threshold braking when blocked', () => {
  const planner = new NovaTopologyPlanner();
  const ego = { id: 0, s: 500, q: 0, speed: 38, v: 38, halfLength: 2.325, halfWidth: 1.01 };

  // Case A: 3 staggered stopped cars with alternating feasible corridor (-2.0, +2.5, -2.0)
  const passableObstacles = [
    { id: 1, s: 525, q: -2.0, speed: 0, finished: true, halfLength: 2.325, halfWidth: 1.01 },
    { id: 2, s: 550, q: +2.5, speed: 0, finished: true, halfLength: 2.325, halfWidth: 1.01 },
    { id: 3, s: 575, q: -2.0, speed: 0, finished: true, halfLength: 2.325, halfWidth: 1.01 }
  ];

  const planA = planner.plan(ego, passableObstacles, null, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.notEqual(planA.targetSpeedCapReason, 'OBSTACLES_BLOCKING_TRACK', 'Must not panic brake when passable corridor exists');
  assert.ok(planA.targetSpeedCap > 20, 'Must maintain continuous speed through passable weave');

  // Case B: Road genuinely blocked by stopped cars walling off track
  planner.reset();
  const blockingObstacles = [
    { id: 1, s: 535, q: -2.5, speed: 0, finished: true, halfLength: 2.325, halfWidth: 2.5 },
    { id: 2, s: 536, q: +2.5, speed: 0, finished: true, halfLength: 2.325, halfWidth: 2.5 }
  ];

  const planB = planner.plan(ego, blockingObstacles, null, null, NOVA_FREE_AIR, 0, 1 / 120);
  assert.equal(planB.targetSpeedCapReason, 'OBSTACLES_BLOCKING_TRACK', 'Must command threshold braking when road is blocked');
  assert.ok(planB.targetSpeedCap < ego.speed, 'Target speed must be capped to brake before blockage');
});

test('V4-5: Side-by-side corner corridor ownership (Scenarios A through E)', () => {
  const planner = new NovaTopologyPlanner();

  // Scenario A: Ego inside (left, q = -2.5), Rival outside (right, q = 2.0)
  {
    const ego = { id: 0, s: 1300, q: -2.5, speed: 35, v: 35, halfLength: 2.325, halfWidth: 1.01 };
    const rival = { id: 1, s: 1301, q: 2.0, speed: 35, v: 35, halfLength: 2.325, halfWidth: 1.01 };
    planner.selectedSide = -1;
    const plan = planner.plan(ego, [rival], null, null, NOVA_FREE_AIR, 0, 1 / 120);
    assert.equal(plan.phase, RACECRAFT_PHASE.OVERLAP);
    assert.ok(plan.targetQ < 0.5, `Scenario A: Inside ego must hold inside corridor, got ${plan.targetQ}`);
    assert.equal(plan.targetSpeedCap, Infinity, 'Disjoint corridors must not cap speed');
  }

  // Scenario B: Ego outside (right, q = 3.0), Rival inside (left, q = -1.5)
  {
    planner.reset();
    const ego = { id: 0, s: 1300, q: 3.0, speed: 35, v: 35, halfLength: 2.325, halfWidth: 1.01 };
    const rival = { id: 1, s: 1301, q: -1.5, speed: 35, v: 35, halfLength: 2.325, halfWidth: 1.01 };
    planner.selectedSide = 1;
    const plan = planner.plan(ego, [rival], null, null, NOVA_FREE_AIR, 0, 1 / 120);
    assert.equal(plan.phase, RACECRAFT_PHASE.OVERLAP);
    assert.ok(plan.targetQ > 1.0, `Scenario B: Outside ego must hold outside corridor, got ${plan.targetQ}`);
    assert.equal(plan.targetSpeedCap, Infinity);
  }

  // Scenario C: Dynamic lateral squeeze / converging paths
  {
    planner.reset();
    const ego = { id: 0, s: 500, q: 0.0, speed: 45, v: 45, halfLength: 2.325, halfWidth: 1.01 };
    const rival = { id: 1, s: 499, q: 3.0, dq: -2.5, speed: 48, halfLength: 2.325, halfWidth: 1.01 };
    const belief = new NovaBeliefEngine();
    belief.update([rival], ego, 1 / 120);
    const plan = planner.plan(ego, [rival], null, belief, NOVA_FREE_AIR, 0, 1 / 120);
    assert.equal(plan.phase, RACECRAFT_PHASE.CONCEDE);
    assert.ok(plan.targetSpeedCap < rival.speed, 'Must yield longitudinally to resolve squeeze');
  }

  // Scenario D: Switchback (rival defends inside, ego cuts back)
  {
    planner.reset();
    const ego = { id: 0, s: 1280, q: 2.5, speed: 42, v: 42 };
    const rival = { id: 1, s: 1295, q: -3.5, speed: 36, v: 36 };
    const traj = planner._trajectory('H_SWITCHBACK', ego, rival, 15, null, NOVA_FREE_AIR, 6.2);
    assert.ok(traj.length > 0);
    assert.ok(traj.at(-1).s > ego.s + 30);
  }

  // Scenario E: Exit merge holds corridor until rear bumper clearance
  {
    planner.reset();
    planner.selectedSide = -1;
    planner.lastAttackId = 1;
    const ego = { id: 0, s: 506, q: -2.0, speed: 38, v: 38 };
    const rival = { id: 1, s: 500, q: 2.0, speed: 35, v: 35 };
    const plan = planner.plan(ego, [rival], null, null, NOVA_FREE_AIR, 0, 1 / 120);
    assert.equal(plan.phase, RACECRAFT_PHASE.CLEARING, 'Must hold CLEARING until rear bumper margin satisfied');
    assert.ok(plan.targetQAt(ego.s) < -0.5, 'Must not snap immediately back to centerline during CLEARING');
    assert.ok(plan.selectedCorridor !== undefined);
  }
});

test('V4.2 Corridor Graph Reachability (Scenarios A through E) & High-Closing Pull-out', () => {
  const planner = new NovaTopologyPlanner();
  const legalQ = 6.8;

  // Scenario A: directly behind rival, left corridor open
  {
    const ego = { id: 0, s: 500, q: 0.0, dq: 0.0, speed: 30, v: 30 };
    const mockBeliefA = {
      freeIntervalsAt: (station, t) => [[-6.8, -1.8]]
    };
    const graphA = planner._corridorGraph(ego, mockBeliefA, NOVA_FREE_AIR, legalQ);
    assert.ok(graphA.layers.length > 0);
    const encounterIntervalsA = graphA.layers[4].intervals; // t ~ 1.0s
    assert.ok(encounterIntervalsA.some(int => int.reachable), 'Scenario A: Left corridor must be reachable from draft');
  }

  // Scenario B: directly behind rival, right corridor open
  {
    const ego = { id: 0, s: 500, q: 0.0, dq: 0.0, speed: 30, v: 30 };
    const mockBeliefB = {
      freeIntervalsAt: (station, t) => [[1.8, 6.8]]
    };
    const graphB = planner._corridorGraph(ego, mockBeliefB, NOVA_FREE_AIR, legalQ);
    const encounterIntervalsB = graphB.layers[4].intervals;
    assert.ok(encounterIntervalsB.some(int => int.reachable), 'Scenario B: Right corridor must be reachable from draft');
  }

  // Scenario C: both corridors open
  {
    const ego = { id: 0, s: 500, q: 0.0, dq: 0.0, speed: 30, v: 30 };
    const mockBeliefC = {
      freeIntervalsAt: (station, t) => [[-6.8, -1.8], [1.8, 6.8]]
    };
    const graphC = planner._corridorGraph(ego, mockBeliefC, NOVA_FREE_AIR, legalQ);
    const encounterIntervalsC = graphC.layers[4].intervals;
    assert.equal(encounterIntervalsC.filter(int => int.reachable).length, 2, 'Scenario C: Both corridors must be reachable');
  }

  // Scenario D: corridor geometrically open but dynamically unreachable (>30G away in time t)
  {
    const ego = { id: 0, s: 500, q: 0.0, dq: 0.0, speed: 30, v: 30 };
    const mockBeliefD = {
      freeIntervalsAt: (station, t) => {
        if (t <= 0.3) return [[6.0, 6.8]];
        return [];
      }
    };
    const graphD = planner._corridorGraph(ego, mockBeliefD, NOVA_FREE_AIR, legalQ);
    const layer1 = graphD.layers[1]; // t = 0.25s
    assert.ok(!layer1.intervals.some(int => int.reachable), 'Scenario D: Dynamically unreachable corridor (>30G) must be infeasible');
  }

  // Scenario E: genuinely blocked road
  {
    const ego = { id: 0, s: 500, q: 0.0, dq: 0.0, speed: 30, v: 30 };
    const mockBeliefE = {
      freeIntervalsAt: (station, t) => [] // zero free intervals across road
    };
    const graphE = planner._corridorGraph(ego, mockBeliefE, NOVA_FREE_AIR, legalQ);
    for (const layer of graphE.layers) {
      assert.equal(layer.intervals.length, 0, 'Scenario E: Genuinely blocked road has zero intervals');
    }
  }

  // Straightaway high-closing (>10 m/s) pull-out regression
  {
    planner.reset();
    const ego = { id: 0, s: 1850, q: 0.0, dq: 0.0, speed: 50, v: 50, halfLength: 2.325, halfWidth: 1.01 };
    const rival = { id: 1, s: 1875, q: 0.0, dq: 0.0, speed: 38, v: 38, halfLength: 2.325, halfWidth: 1.01 }; // closing 12 m/s
    const belief = new NovaBeliefEngine();
    belief.update([rival], ego, 1 / 120);
    const plan = planner.plan(ego, [rival], null, belief, NOVA_FREE_AIR, 0, 1 / 120);
    assert.ok(plan.activeTopology === 'H_OUTSIDE' || plan.activeTopology === 'H_INSIDE', 'High-closing straightaway must select attack corridor');
    assert.equal(plan.phase, RACECRAFT_PHASE.ATTACK_COMMITTED);
    assert.equal(plan.targetSpeedCap, Infinity, 'Must not brake behind rival when pulling out early into legal corridor');
  }

  // Late high-closing impossible pull-out (imminent collision within rear bumper)
  {
    planner.reset();
    const ego = { id: 0, s: 1850, q: 0.0, dq: 0.0, speed: 50, v: 50, halfLength: 2.325, halfWidth: 1.01 };
    const rival = { id: 1, s: 1860, q: 0.0, dq: 0.0, speed: 20, v: 20, halfLength: 2.325, halfWidth: 1.01 }; // closing 30 m/s at 10m gap
    const belief = new NovaBeliefEngine();
    belief.update([rival], ego, 1 / 120);
    const plan = planner.plan(ego, [rival], null, belief, NOVA_FREE_AIR, 0, 1 / 120);
    assert.ok(plan.targetSpeedCap < ego.speed, 'Must intervene with braking when pull-out before impact is physically impossible');
  }
});

