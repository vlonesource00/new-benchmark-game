// tools/catch-to-pass-forensics.mjs
// NOVA V4.1 — GEMINI CATCH-TO-PASS FORENSICS
// Rigorous, high-frequency empirical analysis of every catch, attack initiation failure,
// cost decomposition, momentum loss event, and corner exit dynamic between NOVA and Gemini.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('../benchmark');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Track } = await load('host/astra/src/sim/track.js');
const { Session } = await load('host/astra/src/sim/session.js');
const { createField, TRIAD_CANDIDATES } = await load('sandbox/bridges/index.js');
const { NOVA_FREE_AIR } = await import('../src/tracks/lines/harbor-ring-nova.js');

const DT = 1 / 120;
const TRACK_LENGTH = 2704.62;
const ROAD_HALF_WIDTH = 8.2;
const LEGAL_Q = 6.8;

function wrapTrackDelta(ds, trackLength = TRACK_LENGTH) {
  let d = ((ds % trackLength) + trackLength) % trackLength;
  if (d > trackLength * 0.5) d -= trackLength;
  return d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Corner definitions on Harbor Ring GT
const CORNER_ZONES = [
  { id: 'T1_DOCK_HAIRPIN', name: 'Turn 1/2 Dock Hairpin', entryS: 650, apexS: 885, exitS: 1020, nominalApexV: 12.4 },
  { id: 'T3_ESSES_ENTRY', name: 'Turn 4/5 Container Esses Entry', entryS: 1300, apexS: 1420, exitS: 1540, nominalApexV: 11.5 },
  { id: 'T4_ESSES_EXIT', name: 'Turn 6 Infield Kink', entryS: 1560, apexS: 1595, exitS: 1720, nominalApexV: 14.1 },
  { id: 'T5_WAREHOUSE_LOOP', name: 'Turn 7/8 Warehouse Loop', entryS: 2200, apexS: 2295, exitS: 2350, nominalApexV: 12.3 },
  { id: 'T6_HARBOR_CHICANE', name: 'Turn 9/10 Harbor Chicane', entryS: 2340, apexS: 2365, exitS: 2470, nominalApexV: 8.8 }
];

function getCornerAt(s) {
  const normS = ((s % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
  for (const c of CORNER_ZONES) {
    if (normS >= c.entryS && normS <= c.exitS) return c;
  }
  return null;
}

// Step 1: Run Free-Air Solo Baseline for NOVA
console.log('================================================================================');
console.log('NOVA V4.1 — GEMINI CATCH-TO-PASS FORENSICS');
console.log('================================================================================');
console.log('1. Gathering high-resolution Free-Air Solo baseline for NOVA...');

function runFreeAirBaseline() {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = 2;
  session.field = 1;
  session.cars = session.cars.slice(0, 1);
  session.drivers = session.drivers.slice(0, 1);
  session.autopilot = true;

  const field = createField({
    session,
    hostTrack: track,
    order: ['nova'],
    candidatesList: TRIAD_CANDIDATES
  });
  session.start({ freshTrack: true });
  field.attach(true);
  session.phase = 'racing';
  session.countdown = 0;

  const samples = new Map(); // station rounded to 0.5m -> { speed, throttle, brake, steer, q, time }
  const maxSteps = Math.ceil(200 / DT);
  let steps = 0;
  const car = session.cars[0];

  while (steps < maxSteps) {
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    steps++;
    if (car.race.lap >= 2 && car.race.lap < 3) {
      // Record flying lap 2
      const sKey = Math.round(car.s * 2) / 2;
      if (!samples.has(sKey)) {
        samples.set(sKey, {
          s: car.s,
          speed: car.speed,
          throttle: car.controls.throttle,
          brake: car.controls.brake,
          steer: car.controls.steer,
          q: car.lateral,
          t: session.time
        });
      }
    }
    if (car.race.lap >= 3 || car.race.finishTime !== null) break;
  }
  console.log(`   Captured ${samples.size} free-air spatial slices on flying lap.`);
  return samples;
}

const freeAirBaseline = runFreeAirBaseline();

function getFreeAirAt(s) {
  const sKey = Math.round((((s % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH) * 2) / 2;
  return freeAirBaseline.get(sKey) ?? null;
}

// Step 2: High-Frequency Instrumented Simulation Harness
console.log('2. Running instrumented multi-heat head-to-head simulations...');

// Opportunity and Funnel Data Structures
const STAGES = {
  OPPORTUNITY: 1,
  ATTACK_WINDOW_OPEN: 2,
  ATTACK_COMMITTED: 3,
  PRE_OVERLAP: 4,
  DOOR_TO_DOOR: 5,
  NOSE_AHEAD: 6,
  FULL_CLEAR: 7,
  RETAINED: 8
};

const STAGE_NAMES = [
  'NONE',
  'OPPORTUNITY',
  'ATTACK WINDOW OPEN',
  'ATTACK COMMITTED',
  'PRE_OVERLAP',
  'DOOR-TO-DOOR',
  'NOSE AHEAD',
  'FULL CLEAR',
  'RETAINED'
];

// Heats to execute: canonical grids covering NOVA hunting Gemini and Gemini hunting NOVA
const HEAT_CONFIGS = [
  // NOVA hunting Gemini (primary forensic focus)
  { id: 'H1_3L', grid: ['gemini-supreme', 'nova', 'astra'], laps: 3, hunter: 'nova', prey: 'gemini-supreme' },
  { id: 'H2_3L', grid: ['gemini-supreme', 'astra', 'nova'], laps: 3, hunter: 'nova', prey: 'gemini-supreme' },
  { id: 'H3_3L', grid: ['astra', 'gemini-supreme', 'nova'], laps: 3, hunter: 'nova', prey: 'gemini-supreme' },
  { id: 'H1_5L', grid: ['gemini-supreme', 'nova', 'astra'], laps: 5, hunter: 'nova', prey: 'gemini-supreme' },
  { id: 'H2_5L', grid: ['gemini-supreme', 'astra', 'nova'], laps: 5, hunter: 'nova', prey: 'gemini-supreme' },
  { id: 'H3_5L', grid: ['astra', 'gemini-supreme', 'nova'], laps: 5, hunter: 'nova', prey: 'gemini-supreme' },

  // Gemini hunting NOVA (for direct symmetrical comparison)
  { id: 'G1_3L', grid: ['nova', 'gemini-supreme', 'astra'], laps: 3, hunter: 'gemini-supreme', prey: 'nova' },
  { id: 'G2_3L', grid: ['nova', 'astra', 'gemini-supreme'], laps: 3, hunter: 'gemini-supreme', prey: 'nova' },
  { id: 'G3_3L', grid: ['astra', 'nova', 'gemini-supreme'], laps: 3, hunter: 'gemini-supreme', prey: 'nova' },
  { id: 'G1_5L', grid: ['nova', 'gemini-supreme', 'astra'], laps: 5, hunter: 'gemini-supreme', prey: 'nova' },
  { id: 'G2_5L', grid: ['nova', 'astra', 'gemini-supreme'], laps: 5, hunter: 'gemini-supreme', prey: 'nova' },
  { id: 'G3_5L', grid: ['astra', 'nova', 'gemini-supreme'], laps: 5, hunter: 'gemini-supreme', prey: 'nova' }
];

// Aggregated forensic registries
const novaOpportunities = [];
const geminiOpportunities = [];

const novaReasons = new Map(); // reason -> { count, totalSeconds, termBreakdown: [] }
const costDecompositionSamples = []; // { heat, t, s, gap, closing, candidates: { H_FOLLOW, H_INSIDE, H_OUTSIDE, H_SWITCHBACK }, winner }

const momentumLossEvents = []; // Catch < 12m, fallback > 18m
const cornerExitComparisons = []; // Per corner entry/exit pairs

let totalNovaOpportunitySeconds = 0;
let totalNovaAttackCommittedSeconds = 0;
let totalNovaOverlapSeconds = 0;

let totalGeminiOpportunitySeconds = 0;
let totalGeminiAttackCommittedSeconds = 0;
let totalGeminiOverlapSeconds = 0;

function evaluateCorridorAvailability(leadQ, legalQ = LEGAL_Q) {
  const leftSpace = leadQ - (-legalQ) - 1.41;
  const rightSpace = legalQ - leadQ - 1.41;
  const hasLeft = leftSpace >= 2.40;
  const hasRight = rightSpace >= 2.40;
  return { hasLeft, hasRight, hasCorridor: hasLeft || hasRight, leftSpace, rightSpace };
}

function runInstrumentedHeat(config) {
  const { id: heatId, grid, laps, hunter: targetHunter, prey: targetPrey } = config;
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = laps;
  session.field = 3;
  session.cars = session.cars.slice(0, 3);
  session.drivers = session.drivers.slice(0, 3);
  session.autopilot = true;

  const field = createField({
    session,
    hostTrack: track,
    order: grid,
    candidatesList: TRIAD_CANDIDATES
  });
  session.start({ freshTrack: true });
  field.attach(true);
  session.phase = 'racing';
  session.countdown = 0;

  const novaIndex = grid.indexOf('nova');
  const geminiIndex = grid.indexOf('gemini-supreme');
  const novaCar = session.cars[novaIndex];
  const geminiCar = session.cars[geminiIndex];
  const novaBridge = field.bridges[novaIndex];
  const geminiBridge = field.bridges[geminiIndex];
  const novaDriver = novaBridge.driver;
  const geminiController = geminiBridge.controller;

  const maxSteps = Math.ceil((laps * 90 + 30) / DT);
  let steps = 0;

  // Opportunity Tracker State
  let currentNovaOpp = null;
  let currentGeminiOpp = null;

  // Momentum Loss Tracker State (for NOVA)
  let activeCatch = null; // { startT, startGap, minGap: Infinity, minGapT, maxClosing: 0, brakingSec: 0, capReasons: Set(), throttleSuppressionSec: 0, corner: null, samples: [] }

  // Corner exit tracking
  const activeCornerPass = new Map(); // cornerId -> { nova: {}, gemini: {} }

  while (steps < maxSteps) {
    if (session.phase === 'finished' && !session.activeCars.every(c => c.race.finishTime !== null)) {
      session.phase = 'racing';
    }
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    const t = session.time;
    if (novaCar.race.finishTime !== null && geminiCar.race.finishTime !== null) break;

    // Relative kinematics between NOVA and Gemini
    const dsNovaToGemini = wrapTrackDelta(geminiCar.s - novaCar.s, TRACK_LENGTH);
    const dsGeminiToNova = -dsNovaToGemini;
    const closingNova = novaCar.speed - geminiCar.speed;
    const closingGemini = geminiCar.speed - novaCar.speed;

    const novaTopology = novaDriver.topologyResult;
    const novaPhase = novaTopology?.phase ?? 'FREE';
    const novaPlan = novaTopology;
    const novaBrake = novaCar.controls.brake;
    const novaThrottle = novaCar.controls.throttle;
    const novaSpeedCap = novaTopology?.targetSpeedCap ?? Infinity;
    const novaCapReason = novaTopology?.targetSpeedCapReason ?? null;

    const geminiTactical = geminiController?._lastTactical ?? {};
    const geminiTacticalMode = geminiController?._lastTacticalMode ?? 'PACE';
    const geminiAttackMode = geminiTactical?.attackMode ?? 'NONE';
    const geminiBrake = geminiCar.controls.brake;
    const geminiThrottle = geminiCar.controls.throttle;

    // =========================================================================
    // 1. FORENSIC TRACKING: NOVA HUNTING GEMINI
    // =========================================================================
    const isGeminiAhead = dsNovaToGemini > 0 && dsNovaToGemini <= 40.0;
    const corridorInfoNova = evaluateCorridorAvailability(geminiCar.lateral);
    const reachableCorridorNova = corridorInfoNova.hasCorridor;

    // Projected braking & exit advantage
    const freeAirNova = getFreeAirAt(novaCar.s);
    const currentCorner = getCornerAt(novaCar.s);
    const brakingAdvantageNova = currentCorner && (novaCar.s < currentCorner.apexS) &&
      (closingNova > 0 || (freeAirNova && freeAirNova.brake === 0 && geminiBrake > 0.1));
    const exitAdvantageNova = currentCorner && (novaCar.s >= currentCorner.apexS) &&
      (closingNova > -0.2 || (freeAirNova && freeAirNova.throttle > 0.5 && geminiThrottle < 0.5));
    const closingAdvantageNova = closingNova > 0.5;

    const hasOpportunityNova = isGeminiAhead &&
      (closingAdvantageNova || brakingAdvantageNova || exitAdvantageNova) &&
      reachableCorridorNova;

    if (hasOpportunityNova) {
      totalNovaOpportunitySeconds += DT;
      if (!currentNovaOpp) {
        currentNovaOpp = {
          heatId,
          startT: t,
          startS: novaCar.s,
          startGap: dsNovaToGemini,
          maxStage: STAGES.OPPORTUNITY,
          duration: 0,
          endReason: null,
          reachedAttackWindow: false,
          reachedAttackCommitted: false,
          reachedPreOverlap: false,
          reachedDoorToDoor: false,
          reachedNoseAhead: false,
          reachedFullClear: false,
          reachedRetained: false,
          dominantFailureReason: null,
          dominantTermBreakdown: null
        };
      }
      currentNovaOpp.duration += DT;

      // Update Funnel Milestones
      const attackWindowOpen = Boolean(
        novaPlan &&
        (novaPlan.candidates?.some(c => c.topology !== 'H_FOLLOW' && c.topology !== 'H_SWITCHBACK' && c.cost < (novaPlan.candidates.find(x => x.topology === 'H_FOLLOW')?.cost ?? 999) + 2.0))
      );
      if (attackWindowOpen && currentNovaOpp.maxStage < STAGES.ATTACK_WINDOW_OPEN) {
        currentNovaOpp.maxStage = STAGES.ATTACK_WINDOW_OPEN;
        currentNovaOpp.reachedAttackWindow = true;
      }

      const isAttackCommitted = novaPhase === 'ATTACK_COMMITTED' || novaTopology?.activeTopology === 'H_INSIDE' || novaTopology?.activeTopology === 'H_OUTSIDE' || novaDriver.topologyPlanner?.selectedSide !== 0;
      if (isAttackCommitted) {
        totalNovaAttackCommittedSeconds += DT;
        if (currentNovaOpp.maxStage < STAGES.ATTACK_COMMITTED) {
          currentNovaOpp.maxStage = STAGES.ATTACK_COMMITTED;
          currentNovaOpp.reachedAttackCommitted = true;
        }
      }

      if (isAttackCommitted && dsNovaToGemini < 5.2 && dsNovaToGemini > 0) {
        if (currentNovaOpp.maxStage < STAGES.PRE_OVERLAP) {
          currentNovaOpp.maxStage = STAGES.PRE_OVERLAP;
          currentNovaOpp.reachedPreOverlap = true;
        }
      }

      const isDoorToDoor = Math.abs(dsNovaToGemini) <= 4.65;
      if (isDoorToDoor) {
        totalNovaOverlapSeconds += DT;
        if (currentNovaOpp.maxStage < STAGES.DOOR_TO_DOOR) {
          currentNovaOpp.maxStage = STAGES.DOOR_TO_DOOR;
          currentNovaOpp.reachedDoorToDoor = true;
        }
      }

      const isNoseAhead = dsNovaToGemini <= 0 && dsNovaToGemini > -5.2;
      if (isNoseAhead) {
        if (currentNovaOpp.maxStage < STAGES.NOSE_AHEAD) {
          currentNovaOpp.maxStage = STAGES.NOSE_AHEAD;
          currentNovaOpp.reachedNoseAhead = true;
        }
      }

      const isFullClear = dsNovaToGemini <= -5.2;
      if (isFullClear) {
        if (currentNovaOpp.maxStage < STAGES.FULL_CLEAR) {
          currentNovaOpp.maxStage = STAGES.FULL_CLEAR;
          currentNovaOpp.reachedFullClear = true;
          currentNovaOpp.clearStation = novaCar.s;
        }
      }

      if (currentNovaOpp.reachedFullClear && !currentNovaOpp.reachedRetained) {
        const distSinceClear = wrapTrackDelta(novaCar.s - currentNovaOpp.clearStation, TRACK_LENGTH);
        if (distSinceClear >= 100 || novaCar.race.finishTime !== null) {
          if (dsNovaToGemini < -5.2) {
            currentNovaOpp.reachedRetained = true;
            currentNovaOpp.maxStage = STAGES.RETAINED;
          }
        }
      }

      // If attack did NOT start, diagnose why
      if (!isAttackCommitted && novaTopology?.candidates) {
        const cands = novaTopology.candidates;
        const follow = cands.find(c => c.topology === 'H_FOLLOW');
        const attackCands = cands.filter(c => c.topology !== 'H_FOLLOW' && c.topology !== 'H_SWITCHBACK');
        const bestAtk = [...attackCands].sort((a, b) => a.cost - b.cost)[0] ?? null;

        let failureReason = 'other';
        const planner = novaDriver.topologyPlanner;
        const attackReachable = dsNovaToGemini < 30 || (dsNovaToGemini < 45 && closingNova > 0.5);

        if (!attackReachable) {
          failureReason = 'attackReachable false';
        } else if (planner && t < planner.attackCooldownUntil) {
          failureReason = 'attack cooldown';
        } else if (!bestAtk) {
          failureReason = 'no feasible attack candidate';
        } else if ((bestAtk.predicted?.physicalCollisionRisk ?? 0) >= 0.45) {
          failureReason = 'physicalCollisionRisk threshold';
        } else if (!bestAtk.trajectory?.corridorFeasible) {
          failureReason = 'corridor infeasible';
        } else if (bestAtk.rollout?.brakingDeficit > 0.5) {
          failureReason = 'braking deficit';
        } else if (bestAtk.rollout?.peakGrip > 1.05) {
          failureReason = 'grip deficit';
        } else if (bestAtk.cost >= (follow?.cost ?? 0) + 2.0) {
          failureReason = 'attack cost > FOLLOW';
        }

        // Record reason statistics
        if (!novaReasons.has(failureReason)) {
          novaReasons.set(failureReason, { count: 0, totalSeconds: 0, deltaCosts: [], dominantTerms: [] });
        }
        const rStats = novaReasons.get(failureReason);
        rStats.count += 1;
        rStats.totalSeconds += DT;

        if (bestAtk && follow) {
          const deltaCost = bestAtk.cost - follow.cost;
          rStats.deltaCosts.push(deltaCost);
        }

        currentNovaOpp.dominantFailureReason = failureReason;

        // Sample Cost Decomposition at regular intervals (every 0.25s)
        if (steps % 30 === 0 && bestAtk && follow) {
          const switchback = cands.find(c => c.topology === 'H_SWITCHBACK');
          const inside = cands.find(c => c.topology === 'H_INSIDE');
          const outside = cands.find(c => c.topology === 'H_OUTSIDE');

          const decompose = c => {
            if (!c) return null;
            const r = c.rollout || {};
            const p = c.predicted || {};
            const h = c.heuristicCost || 0;
            return {
              topology: c.topology,
              rolloutTime: +(10 * (r.duration || 0)).toFixed(2),
              exitSpeedContrib: +(-0.5 * (r.exitSpeed || 0)).toFixed(2),
              heuristicContrib: +(0.06 * h).toFixed(2),
              continuousRiskContrib: +(25 * (p.peakRisk || 0)).toFixed(2),
              collisionContrib: (p.physicalCollisionRisk >= 0.45 ? 400 : 0),
              corridorContrib: (!c.trajectory?.corridorFeasible ? 200 : 0),
              brakingDeficitContrib: (r.brakingDeficit > 0.5 ? +(20 * r.brakingDeficit).toFixed(2) : 0),
              gripDeficitContrib: (r.peakGrip > 1.05 ? +(15 * (r.peakGrip - 1.0)).toFixed(2) : 0),
              finalCost: +c.cost.toFixed(2)
            };
          };

          costDecompositionSamples.push({
            heatId,
            t: +t.toFixed(2),
            s: +novaCar.s.toFixed(1),
            gap: +dsNovaToGemini.toFixed(2),
            closing: +closingNova.toFixed(2),
            follow: decompose(follow),
            inside: decompose(inside),
            outside: decompose(outside),
            switchback: decompose(switchback),
            winner: cands[0]?.topology,
            failureReason
          });
        }
      }
    } else if (currentNovaOpp) {
      // Close opportunity episode
      currentNovaOpp.endReason = dsNovaToGemini > 40.0 ? 'GEMINI_ESCAPED_40M' : (!reachableCorridorNova ? 'NO_REACHABLE_CORRIDOR' : 'NO_CLOSING_OR_ADVANTAGE');
      novaOpportunities.push(currentNovaOpp);
      currentNovaOpp = null;
    }

    // =========================================================================
    // 2. MOMENTUM LOSS FORENSICS (Catch < 12m, fallback > 18m)
    // =========================================================================
    if (isGeminiAhead && dsNovaToGemini <= 12.0) {
      if (!activeCatch) {
        activeCatch = {
          heatId,
          startT: t,
          startS: novaCar.s,
          minGap: dsNovaToGemini,
          minGapT: t,
          minGapS: novaCar.s,
          maxClosing: Math.max(0, closingNova),
          brakingSec: 0,
          capReasons: new Set(),
          throttleSuppressionSec: 0,
          minCornerSpeed: novaCar.speed,
          apexSpeed: null,
          exitSpeed25m: null,
          exitSpeed50m: null,
          geminiApexSpeed: null,
          geminiExitSpeed25m: null,
          geminiExitSpeed50m: null,
          freeAirApexSpeed: null,
          freeAirExitSpeed25m: null,
          freeAirExitSpeed50m: null,
          corner: currentCorner?.id ?? 'STRAIGHT',
          samples: []
        };
      }
      if (dsNovaToGemini < activeCatch.minGap) {
        activeCatch.minGap = dsNovaToGemini;
        activeCatch.minGapT = t;
        activeCatch.minGapS = novaCar.s;
        activeCatch.minCornerSpeed = Math.min(activeCatch.minCornerSpeed, novaCar.speed);
      }
      activeCatch.maxClosing = Math.max(activeCatch.maxClosing, closingNova);
    }

    if (activeCatch) {
      if (novaBrake > 0.05) activeCatch.brakingSec += DT;
      if (novaCapReason) activeCatch.capReasons.add(novaCapReason);

      // Free air throttle comparison
      if (freeAirNova && freeAirNova.throttle > 0.8 && novaThrottle < 0.6) {
        activeCatch.throttleSuppressionSec += DT;
      }

      // Check corner markers
      const c = getCornerAt(activeCatch.minGapS);
      if (c) {
        activeCatch.corner = c.id;
        const dsFromApex = wrapTrackDelta(novaCar.s - c.apexS, TRACK_LENGTH);
        if (Math.abs(dsFromApex) < 2.0 && activeCatch.apexSpeed === null) {
          activeCatch.apexSpeed = novaCar.speed;
          activeCatch.geminiApexSpeed = geminiCar.speed;
          activeCatch.freeAirApexSpeed = getFreeAirAt(c.apexS)?.speed ?? c.nominalApexV;
        }
        if (dsFromApex >= 24 && dsFromApex <= 28 && activeCatch.exitSpeed25m === null) {
          activeCatch.exitSpeed25m = novaCar.speed;
          activeCatch.geminiExitSpeed25m = geminiCar.speed;
          activeCatch.freeAirExitSpeed25m = getFreeAirAt(c.apexS + 25)?.speed ?? null;
        }
        if (dsFromApex >= 48 && dsFromApex <= 54 && activeCatch.exitSpeed50m === null) {
          activeCatch.exitSpeed50m = novaCar.speed;
          activeCatch.geminiExitSpeed50m = geminiCar.speed;
          activeCatch.freeAirExitSpeed50m = getFreeAirAt(c.apexS + 50)?.speed ?? null;
        }
      }

      // Fallback threshold reached (> 18m)
      if (dsNovaToGemini > 18.0) {
        activeCatch.fallbackT = t;
        activeCatch.fallbackGap = dsNovaToGemini;
        activeCatch.duration = t - activeCatch.startT;

        // Exact seconds lost vs free air over same station interval
        const sDist = wrapTrackDelta(novaCar.s - activeCatch.startS, TRACK_LENGTH);
        const freeAirSampleStart = getFreeAirAt(activeCatch.startS);
        const freeAirSampleEnd = getFreeAirAt(novaCar.s);
        const freeAirDuration = (freeAirSampleStart && freeAirSampleEnd)
          ? Math.max(0.5, freeAirSampleEnd.t - freeAirSampleStart.t)
          : (sDist / (freeAirSampleStart?.speed || 35));
        activeCatch.secondsLost = Math.max(0, activeCatch.duration - freeAirDuration);

        momentumLossEvents.push({
          ...activeCatch,
          capReasons: Array.from(activeCatch.capReasons)
        });
        activeCatch = null;
      } else if (dsNovaToGemini <= 0) {
        // Pass completed without fallback!
        activeCatch = null;
      }
    }

    // =========================================================================
    // 3. CORNER EXIT COMPARISON (Major Corners)
    // =========================================================================
    for (const corner of CORNER_ZONES) {
      const inCornerNova = wrapTrackDelta(novaCar.s - corner.entryS, TRACK_LENGTH) >= 0 &&
        wrapTrackDelta(corner.exitS - novaCar.s, TRACK_LENGTH) >= 0;
      if (inCornerNova && isGeminiAhead && dsNovaToGemini < 18) {
        let rec = activeCornerPass.get(corner.id);
        if (!rec) {
          rec = {
            cornerId: corner.id,
            cornerName: corner.name,
            heatId,
            lap: novaCar.race.lap,
            nova: {
              brakeReleaseS: null,
              minSpeed: Infinity,
              apexS: corner.apexS,
              apexSpeed: null,
              throttlePickupS: null,
              steerUnwindRate: null,
              speed25m: null,
              speed50m: null
            },
            gemini: {
              brakeReleaseS: null,
              minSpeed: Infinity,
              apexS: corner.apexS,
              apexSpeed: null,
              throttlePickupS: null,
              steerUnwindRate: null,
              speed25m: null,
              speed50m: null
            },
            prevNovaSteer: novaCar.controls.steer,
            prevGeminiSteer: geminiCar.controls.steer
          };
          activeCornerPass.set(corner.id, rec);
        }

        rec.nova.minSpeed = Math.min(rec.nova.minSpeed, novaCar.speed);
        rec.gemini.minSpeed = Math.min(rec.gemini.minSpeed, geminiCar.speed);

        // Brake release
        if (novaBrake < 0.05 && rec.nova.brakeReleaseS === null && novaCar.s >= corner.entryS) {
          rec.nova.brakeReleaseS = +novaCar.s.toFixed(1);
        }
        if (geminiBrake < 0.05 && rec.gemini.brakeReleaseS === null && geminiCar.s >= corner.entryS) {
          rec.gemini.brakeReleaseS = +geminiCar.s.toFixed(1);
        }

        // Throttle pickup
        if (novaThrottle > 0.25 && rec.nova.throttlePickupS === null && novaCar.s >= corner.entryS + 30) {
          rec.nova.throttlePickupS = +novaCar.s.toFixed(1);
        }
        if (geminiThrottle > 0.25 && rec.gemini.throttlePickupS === null && geminiCar.s >= corner.entryS + 30) {
          rec.gemini.throttlePickupS = +geminiCar.s.toFixed(1);
        }

        // Apex speed
        if (Math.abs(wrapTrackDelta(novaCar.s - corner.apexS, TRACK_LENGTH)) < 3 && rec.nova.apexSpeed === null) {
          rec.nova.apexSpeed = +novaCar.speed.toFixed(2);
        }
        if (Math.abs(wrapTrackDelta(geminiCar.s - corner.apexS, TRACK_LENGTH)) < 3 && rec.gemini.apexSpeed === null) {
          rec.gemini.apexSpeed = +geminiCar.speed.toFixed(2);
        }

        // Apex +25m
        if (wrapTrackDelta(novaCar.s - (corner.apexS + 25), TRACK_LENGTH) >= 0 && rec.nova.speed25m === null) {
          rec.nova.speed25m = +novaCar.speed.toFixed(2);
        }
        if (wrapTrackDelta(geminiCar.s - (corner.apexS + 25), TRACK_LENGTH) >= 0 && rec.gemini.speed25m === null) {
          rec.gemini.speed25m = +geminiCar.speed.toFixed(2);
        }

        // Apex +50m
        if (wrapTrackDelta(novaCar.s - (corner.apexS + 50), TRACK_LENGTH) >= 0 && rec.nova.speed50m === null) {
          rec.nova.speed50m = +novaCar.speed.toFixed(2);
        }
        if (wrapTrackDelta(geminiCar.s - (corner.apexS + 50), TRACK_LENGTH) >= 0 && rec.gemini.speed50m === null) {
          rec.gemini.speed50m = +geminiCar.speed.toFixed(2);
        }

        // Steering unwind rate
        if (novaCar.s > corner.apexS && rec.nova.steerUnwindRate === null) {
          rec.nova.steerUnwindRate = +Math.abs((novaCar.controls.steer - rec.prevNovaSteer) / DT).toFixed(2);
        }
        if (geminiCar.s > corner.apexS && rec.gemini.steerUnwindRate === null) {
          rec.gemini.steerUnwindRate = +Math.abs((geminiCar.controls.steer - rec.prevGeminiSteer) / DT).toFixed(2);
        }

        rec.prevNovaSteer = novaCar.controls.steer;
        rec.prevGeminiSteer = geminiCar.controls.steer;
      } else if (activeCornerPass.has(corner.id)) {
        // Exited corner
        const p = activeCornerPass.get(corner.id);
        if (p.nova.speed25m !== null || p.nova.apexSpeed !== null) {
          cornerExitComparisons.push(p);
        }
        activeCornerPass.delete(corner.id);
      }
    }

    // =========================================================================
    // 4. FORENSIC TRACKING: GEMINI HUNTING NOVA (Direct Symmetry)
    // =========================================================================
    const isNovaAhead = dsGeminiToNova > 0 && dsGeminiToNova <= 40.0;
    const corridorInfoGemini = evaluateCorridorAvailability(novaCar.lateral);
    const reachableCorridorGemini = corridorInfoGemini.hasCorridor;

    const hasOpportunityGemini = isNovaAhead &&
      (closingGemini > 0.5 || (novaBrake > 0.1 && geminiBrake < 0.05)) &&
      reachableCorridorGemini;

    if (hasOpportunityGemini) {
      totalGeminiOpportunitySeconds += DT;
      if (!currentGeminiOpp) {
        currentGeminiOpp = {
          heatId,
          startT: t,
          startS: geminiCar.s,
          startGap: dsGeminiToNova,
          maxStage: STAGES.OPPORTUNITY,
          duration: 0,
          reachedAttackWindow: false,
          reachedAttackCommitted: false,
          reachedPreOverlap: false,
          reachedDoorToDoor: false,
          reachedNoseAhead: false,
          reachedFullClear: false,
          reachedRetained: false
        };
      }
      currentGeminiOpp.duration += DT;

      const isGeminiAttackWindow = geminiTacticalMode !== 'PACE' || geminiAttackMode !== 'NONE';
      if (isGeminiAttackWindow && currentGeminiOpp.maxStage < STAGES.ATTACK_WINDOW_OPEN) {
        currentGeminiOpp.maxStage = STAGES.ATTACK_WINDOW_OPEN;
        currentGeminiOpp.reachedAttackWindow = true;
      }

      const isGeminiCommitted = geminiAttackMode === 'SLINGSHOT' || geminiAttackMode === 'DIVEBOMB' || geminiAttackMode === 'SWITCHBACK' || geminiAttackMode === 'OVERTAKE' || geminiAttackMode === 'SIDE_BY_SIDE';
      if (isGeminiCommitted) {
        totalGeminiAttackCommittedSeconds += DT;
        if (currentGeminiOpp.maxStage < STAGES.ATTACK_COMMITTED) {
          currentGeminiOpp.maxStage = STAGES.ATTACK_COMMITTED;
          currentGeminiOpp.reachedAttackCommitted = true;
        }
      }

      if (isGeminiCommitted && dsGeminiToNova < 5.2 && dsGeminiToNova > 0) {
        if (currentGeminiOpp.maxStage < STAGES.PRE_OVERLAP) {
          currentGeminiOpp.maxStage = STAGES.PRE_OVERLAP;
          currentGeminiOpp.reachedPreOverlap = true;
        }
      }

      const isDoorToDoorG = Math.abs(dsGeminiToNova) <= 4.65;
      if (isDoorToDoorG) {
        totalGeminiOverlapSeconds += DT;
        if (currentGeminiOpp.maxStage < STAGES.DOOR_TO_DOOR) {
          currentGeminiOpp.maxStage = STAGES.DOOR_TO_DOOR;
          currentGeminiOpp.reachedDoorToDoor = true;
        }
      }

      const isNoseAheadG = dsGeminiToNova <= 0 && dsGeminiToNova > -5.2;
      if (isNoseAheadG) {
        if (currentGeminiOpp.maxStage < STAGES.NOSE_AHEAD) {
          currentGeminiOpp.maxStage = STAGES.NOSE_AHEAD;
          currentGeminiOpp.reachedNoseAhead = true;
        }
      }

      const isFullClearG = dsGeminiToNova <= -5.2;
      if (isFullClearG) {
        if (currentGeminiOpp.maxStage < STAGES.FULL_CLEAR) {
          currentGeminiOpp.maxStage = STAGES.FULL_CLEAR;
          currentGeminiOpp.reachedFullClear = true;
          currentGeminiOpp.clearStation = geminiCar.s;
        }
      }

      if (currentGeminiOpp.reachedFullClear && !currentGeminiOpp.reachedRetained) {
        const distSinceClearG = wrapTrackDelta(geminiCar.s - currentGeminiOpp.clearStation, TRACK_LENGTH);
        if (distSinceClearG >= 100 || geminiCar.race.finishTime !== null) {
          if (dsGeminiToNova < -5.2) {
            currentGeminiOpp.reachedRetained = true;
            currentGeminiOpp.maxStage = STAGES.RETAINED;
          }
        }
      }
    } else if (currentGeminiOpp) {
      geminiOpportunities.push(currentGeminiOpp);
      currentGeminiOpp = null;
    }
  }

  if (currentNovaOpp) novaOpportunities.push(currentNovaOpp);
  if (currentGeminiOpp) geminiOpportunities.push(currentGeminiOpp);
  console.log(`   Heat ${heatId} [${grid.join('/')}] complete (${steps} ticks).`);
}

// Run all heats
for (const config of HEAT_CONFIGS) {
  runInstrumentedHeat(config);
}

// =============================================================================
// COMPUTE FUNNEL STATISTICS
// =============================================================================
function computeFunnel(oppList) {
  const total = oppList.length;
  if (total === 0) return {};
  const reached = stage => oppList.filter(o => o.maxStage >= stage).length;

  const nOpp = total;
  const nWindow = reached(STAGES.ATTACK_WINDOW_OPEN);
  const nCommit = reached(STAGES.ATTACK_COMMITTED);
  const nPreOverlap = reached(STAGES.PRE_OVERLAP);
  const nDoor = reached(STAGES.DOOR_TO_DOOR);
  const nNose = reached(STAGES.NOSE_AHEAD);
  const nClear = reached(STAGES.FULL_CLEAR);
  const nRetain = reached(STAGES.RETAINED);

  return {
    totalOpportunities: nOpp,
    attackWindowOpen: nWindow,
    attackCommitted: nCommit,
    preOverlap: nPreOverlap,
    doorToDoor: nDoor,
    noseAhead: nNose,
    fullClear: nClear,
    retained: nRetain,
    // Step-by-step conversion percentages
    pctOppToWindow: +(100 * nWindow / nOpp).toFixed(1),
    pctWindowToCommit: +(nWindow > 0 ? 100 * nCommit / nWindow : 0).toFixed(1),
    pctCatchToCommit: +(100 * nCommit / nOpp).toFixed(1),
    pctCommitToPreOverlap: +(nCommit > 0 ? 100 * nPreOverlap / nCommit : 0).toFixed(1),
    pctPreOverlapToDoor: +(nPreOverlap > 0 ? 100 * nDoor / nPreOverlap : 0).toFixed(1),
    pctCommitToOverlap: +(nCommit > 0 ? 100 * nDoor / nCommit : 0).toFixed(1),
    pctDoorToNoseAhead: +(nDoor > 0 ? 100 * nNose / nDoor : 0).toFixed(1),
    pctNoseAheadToClear: +(nNose > 0 ? 100 * nClear / nNose : 0).toFixed(1),
    pctOverlapToClear: +(nDoor > 0 ? 100 * nClear / nDoor : 0).toFixed(1),
    pctClearToRetain: +(nClear > 0 ? 100 * nRetain / nClear : 0).toFixed(1)
  };
}

const novaFunnel = computeFunnel(novaOpportunities);
const geminiFunnel = computeFunnel(geminiOpportunities);

// Opportunity-Adjusted Combat Rates
const novaCommitRatio = totalNovaOpportunitySeconds > 0
  ? +(totalNovaAttackCommittedSeconds / totalNovaOpportunitySeconds).toFixed(3)
  : 0;
const geminiCommitRatio = totalGeminiOpportunitySeconds > 0
  ? +(totalGeminiAttackCommittedSeconds / totalGeminiOpportunitySeconds).toFixed(3)
  : 0;

// Ranked Reasons Table
const rankedReasons = Array.from(novaReasons.entries())
  .map(([reason, data]) => {
    const meanDeltaCost = data.deltaCosts.length > 0
      ? +(data.deltaCosts.reduce((a, b) => a + b, 0) / data.deltaCosts.length).toFixed(2)
      : null;
    return {
      reason,
      count: data.count,
      totalSeconds: +data.totalSeconds.toFixed(2),
      meanDeltaCost
    };
  })
  .sort((a, b) => b.totalSeconds - a.totalSeconds);

// Top 10 Momentum Loss Events
momentumLossEvents.sort((a, b) => b.secondsLost - a.secondsLost);
const top10MomentumLoss = momentumLossEvents.slice(0, 10);

// Aggregated Corner Exit Dynamics
const cornerSummary = {};
for (const c of CORNER_ZONES) {
  const cornerEvents = cornerExitComparisons.filter(e => e.cornerId === c.id);
  if (cornerEvents.length === 0) continue;

  const avg = (arr, key, subkey) => {
    const valid = arr.map(e => e[key][subkey]).filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100);
    return valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2) : null;
  };

  cornerSummary[c.id] = {
    name: c.name,
    eventsCount: cornerEvents.length,
    nova: {
      minSpeed: avg(cornerEvents, 'nova', 'minSpeed'),
      apexSpeed: avg(cornerEvents, 'nova', 'apexSpeed'),
      speed25m: avg(cornerEvents, 'nova', 'speed25m'),
      speed50m: avg(cornerEvents, 'nova', 'speed50m'),
      throttlePickupS: avg(cornerEvents, 'nova', 'throttlePickupS'),
      steerUnwindRate: avg(cornerEvents, 'nova', 'steerUnwindRate')
    },
    gemini: {
      minSpeed: avg(cornerEvents, 'gemini', 'minSpeed'),
      apexSpeed: avg(cornerEvents, 'gemini', 'apexSpeed'),
      speed25m: avg(cornerEvents, 'gemini', 'speed25m'),
      speed50m: avg(cornerEvents, 'gemini', 'speed50m'),
      throttlePickupS: avg(cornerEvents, 'gemini', 'throttlePickupS'),
      steerUnwindRate: avg(cornerEvents, 'gemini', 'steerUnwindRate')
    }
  };
}

// Generate Forensic Bundle
const forensicReport = {
  timestamp: new Date().toISOString(),
  metrics: {
    nova: {
      opportunityCount: novaFunnel.totalOpportunities,
      opportunitySeconds: +totalNovaOpportunitySeconds.toFixed(2),
      attackCommittedSeconds: +totalNovaAttackCommittedSeconds.toFixed(2),
      overlapSeconds: +totalNovaOverlapSeconds.toFixed(2),
      combatCommitRatio: novaCommitRatio,
      funnel: novaFunnel
    },
    gemini: {
      opportunityCount: geminiFunnel.totalOpportunities,
      opportunitySeconds: +totalGeminiOpportunitySeconds.toFixed(2),
      attackCommittedSeconds: +totalGeminiAttackCommittedSeconds.toFixed(2),
      overlapSeconds: +totalGeminiOverlapSeconds.toFixed(2),
      combatCommitRatio: geminiCommitRatio,
      funnel: geminiFunnel
    }
  },
  rankedReasons,
  top10MomentumLoss,
  cornerSummary,
  costDecompositionSamples: costDecompositionSamples.slice(0, 30)
};

const artifactPath = resolve('artifacts/gemini-catch-to-pass-forensics.json');
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(artifactPath, JSON.stringify(forensicReport, null, 2));
console.log(`Saved comprehensive forensic data to ${artifactPath}`);

// Also print the console summary
console.log('\n================================================================================');
console.log('CATCH-TO-PASS FUNNEL COMPARISON (NOVA vs GEMINI)');
console.log('================================================================================');
console.log(`Metric                          | DeepSeek NOVA      | Gemini Supreme`);
console.log(`--------------------------------+--------------------+--------------------`);
console.log(`Combat Opportunity Count        | ${String(novaFunnel.totalOpportunities).padStart(18)} | ${String(geminiFunnel.totalOpportunities).padStart(18)}`);
console.log(`Opportunity Seconds (s)         | ${totalNovaOpportunitySeconds.toFixed(2).padStart(18)} | ${totalGeminiOpportunitySeconds.toFixed(2).padStart(18)}`);
console.log(`Attack Committed Seconds (s)    | ${totalNovaAttackCommittedSeconds.toFixed(2).padStart(18)} | ${totalGeminiAttackCommittedSeconds.toFixed(2).padStart(18)}`);
console.log(`Overlap Seconds (s)             | ${totalNovaOverlapSeconds.toFixed(2).padStart(18)} | ${totalGeminiOverlapSeconds.toFixed(2).padStart(18)}`);
console.log(`Combat Commit Ratio             | ${(novaCommitRatio * 100).toFixed(1).padStart(17)}% | ${(geminiCommitRatio * 100).toFixed(1).padStart(17)}%`);
console.log(`--------------------------------+--------------------+--------------------`);
console.log(`Catch → Commit Conversion       | ${(novaFunnel.pctCatchToCommit || 0).toFixed(1).padStart(17)}% | ${(geminiFunnel.pctCatchToCommit || 0).toFixed(1).padStart(17)}%`);
console.log(`Commit → Overlap Conversion     | ${(novaFunnel.pctCommitToOverlap || 0).toFixed(1).padStart(17)}% | ${(geminiFunnel.pctCommitToOverlap || 0).toFixed(1).padStart(17)}%`);
console.log(`Overlap → Clear Conversion      | ${(novaFunnel.pctOverlapToClear || 0).toFixed(1).padStart(17)}% | ${(geminiFunnel.pctOverlapToClear || 0).toFixed(1).padStart(17)}%`);
console.log(`Clear → Retain Conversion       | ${(novaFunnel.pctClearToRetain || 0).toFixed(1).padStart(17)}% | ${(geminiFunnel.pctClearToRetain || 0).toFixed(1).padStart(17)}%`);
console.log('================================================================================\n');

console.log('RANKED REASONS ATTACK DID NOT START (NOVA):');
console.log('--------------------------------------------------------------------------------');
console.log('REASON                          | TICK COUNT | SECONDS LOST | MEAN ΔCOST (ATK-FOL)');
console.log('--------------------------------+------------+--------------+---------------------');
for (const r of rankedReasons) {
  console.log(
    `${r.reason.padEnd(31)} | ` +
    `${String(r.count).padStart(10)} | ` +
    `${r.totalSeconds.toFixed(2).padStart(12)} | ` +
    `${r.meanDeltaCost !== null ? ('+' + r.meanDeltaCost.toFixed(2)).padStart(21) : '                  N/A'}`
  );
}
console.log('================================================================================\n');
