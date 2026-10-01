import { writeFileSync, mkdirSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';
import { Circuit } from '../../gemini gauntlet/src/simulation/Track.js';
import { Vehicle as GeminiVehicle } from '../../gemini gauntlet/src/simulation/Vehicle.js';
import { NextGenAIController } from '../../gemini gauntlet/src/ai/v2/NextGenAIController.js';
import { HARBOR_RING } from '../../gemini gauntlet/src/scenarios/HarborRing.js';
import { HARBOR_COMPLEXES } from './nova-pace-analyzer.mjs';

const DT = 1 / 120;
const TRACK_LEN = 2704.619248914569;

console.log('======================================================================');
console.log('       HARBOR RING: GEMINI v3.2 vs NOVA FEASIBILITY WITNESS           ');
console.log('======================================================================\n');

// ----------------------------------------------------------------------------
// 1. Run Gemini v3.2 Flying Lap Simulation
// ----------------------------------------------------------------------------
console.log('1. Simulating Gemini v3.2 (GT Class on Harbor Ring)...');
const geminiTrack = new Circuit(HARBOR_RING);
const geminiVehicle = new GeminiVehicle({ id: 'gemini-gt', spec: 'gt', player: false });
const geminiController = new NextGenAIController('gemini-gt', { track: geminiTrack, aggression: 0.96, skill: 1.0 });

// Place on racing line with flying speed
const geminiStart = geminiController.optimalEngine.sampleAtDistance(0, 'gt');
geminiVehicle.resetTo(geminiTrack, 0, geminiStart.lateral);
const geminiFwd = { x: Math.sin(geminiVehicle.yaw), z: Math.cos(geminiVehicle.yaw) };
const geminiFlySpeed = geminiStart.targetSpeed * 0.95;
geminiVehicle.velocity.x = geminiFwd.x * geminiFlySpeed;
geminiVehicle.velocity.z = geminiFwd.z * geminiFlySpeed;
geminiVehicle.speed = geminiFlySpeed;
geminiVehicle.gear = 4;
geminiVehicle.rpm = 5800;
geminiVehicle.controls.throttle = 1.0;

let geminiLaps = 0;
let geminiLapTime = 0;
let geminiLastDist = 0;
const geminiRawTelemetry = [];
let geminiRecording = false;
let geminiFlyingLapTime = null;
const geminiRace = { raceTime: 0, elapsed: 0, phase: 'racing' };

for (let t = 0; t < 220; t += DT) {
  geminiRace.raceTime = t;
  geminiRace.elapsed = t;
  geminiController.update(geminiVehicle, [geminiVehicle], geminiTrack, geminiRace, DT);
  geminiVehicle.step(DT, geminiTrack, true);
  geminiLapTime += DT;

  if (geminiLastDist > TRACK_LEN * 0.85 && geminiVehicle.distance < TRACK_LEN * 0.15 && geminiLapTime > 30.0) {
    geminiLaps++;
    console.log(`   [Gemini] Lap ${geminiLaps} completed in ${geminiLapTime.toFixed(3)}s`);
    if (geminiLaps === 1) {
      geminiRecording = true;
      geminiLapTime = 0;
    } else if (geminiLaps === 2) {
      geminiFlyingLapTime = geminiLapTime;
      break;
    }
  }
  geminiLastDist = geminiVehicle.distance;

  if (geminiRecording) {
    const sNorm = ((geminiVehicle.distance % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
    const q = geminiVehicle.surface?.lateral || 0;
    const margin = 8.2 - (Math.abs(q) + 0.99);
    const beta = Math.atan2(
      geminiVehicle.localVelocity?.x || 0,
      Math.max(0.1, Math.abs(geminiVehicle.localVelocity?.z || geminiVehicle.speed))
    );
    const w = geminiVehicle.wheels || [];
    const frontUtil = w.length >= 2 ? (w[0].utilisation + w[1].utilisation) * 0.5 : 0;
    const rearUtil = w.length >= 4 ? (w[2].utilisation + w[3].utilisation) * 0.5 : 0;

    geminiRawTelemetry.push({
      t: geminiLapTime,
      s: sNorm,
      speed: geminiVehicle.speed,
      speedKmh: geminiVehicle.speed * 3.6,
      q,
      x: geminiVehicle.position.x,
      z: geminiVehicle.position.z,
      throttle: geminiVehicle.controls.throttle,
      brake: geminiVehicle.controls.brake,
      steer: geminiVehicle.controls.steer,
      yaw: geminiVehicle.yaw,
      yawRate: geminiVehicle.yawRate,
      beta,
      ax: (geminiVehicle.localAcceleration?.z || 0) / 9.81,
      ay: (geminiVehicle.localAcceleration?.x || 0) / 9.81,
      margin,
      frontUtil,
      rearUtil,
    });
  }
}
console.log(`   [Gemini] Flying Lap Time: ${geminiFlyingLapTime?.toFixed(3)}s (${geminiRawTelemetry.length} raw samples)\n`);

// ----------------------------------------------------------------------------
// 2. Run NOVA Flying Lap Simulation
// ----------------------------------------------------------------------------
console.log('2. Simulating NOVA (GT Class on Harbor Ring)...');
const novaTrack = new Track('harbor-ring');
const novaSession = new Session(novaTrack, { classId: 'gt' });
novaSession.mode = 'practice';
novaSession.laps = 3;
novaSession.autopilot = true;
novaSession.aiKind = 'nova';
novaSession.aiOptions = { novaSpeedScale: 1.0, strict: true, trace: true, lineVariant: 'measured' };
novaSession.start();

const novaCar = novaSession.cars[0];
novaSession.drivers = novaSession.cars.map((c) => novaSession.makeDriver(c));
const novaAi = novaSession.drivers[0].ai;

let novaLaps = 0;
let novaLapTime = 0;
let novaPrevLap = novaCar.race?.lap ?? 1;
const novaRawTelemetry = [];
let novaRecording = false;
let novaFlyingLapTime = null;

for (let step = 0; step < 220 * 120 && novaLaps < 2 && !novaAi.strictFail; step++) {
  novaSession.step(DT, { throttle: 0, brake: 0, steer: 0 });
  novaLapTime += DT;

  const currentLap = novaCar.race?.lap ?? 0;
  if (currentLap > novaPrevLap) {
    novaLaps++;
    const finishedTime = novaCar.race?.lastLap ?? novaLapTime;
    console.log(`   [NOVA] Lap ${novaLaps} completed in ${finishedTime.toFixed(3)}s`);
    novaPrevLap = currentLap;
    if (novaLaps === 1) {
      novaRecording = true;
      novaLapTime = 0;
      novaRawTelemetry.length = 0;
    } else if (novaLaps === 2) {
      novaFlyingLapTime = finishedTime;
      break;
    }
  }

  if (novaRecording) {
    const sNorm = ((novaCar.s % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
    const q = novaCar.lateral;
    const margin = 8.2 - (Math.abs(q) + 0.99);
    const beta = Math.atan2(novaCar.v || 0, Math.max(0.1, Math.abs(novaCar.u || novaCar.speed)));
    const w = novaCar.wheels || [];
    const frontUtil = w.length >= 2 ? (w[0].tyre?.utilisation + w[1].tyre?.utilisation) * 0.5 : 0;
    const rearUtil = w.length >= 4 ? (w[2].tyre?.utilisation + w[3].tyre?.utilisation) * 0.5 : 0;

    const cc = novaAi?.coupledController;
    const ccState = cc?.state || novaAi?.state || {};

    novaRawTelemetry.push({
      t: novaLapTime,
      s: sNorm,
      speed: novaCar.speed,
      speedKmh: novaCar.speed * 3.6,
      q,
      x: novaCar.x,
      z: novaCar.z,
      throttle: novaCar.controls.throttle,
      brake: novaCar.controls.brake,
      steer: novaCar.controls.steer,
      yaw: novaCar.yaw,
      yawRate: novaCar.yawRate,
      beta,
      ax: (novaCar.ax || 0) / 9.81,
      ay: (novaCar.ay || 0) / 9.81,
      margin,
      frontUtil,
      rearUtil,
      // NOVA internal state channels
      refSpeed: +(ccState.refSpeed ?? 0),
      refSpeedKmh: +(ccState.refSpeed ?? 0) * 3.6,
      vTarget: +(ccState.targetSpeed ?? 0),
      vTargetKmh: +(ccState.targetSpeed ?? 0) * 3.6,
      vAllow: +(ccState.vAllow0 ?? 0),
      vGrip: +(ccState.vGrip ?? 0),
      brakingMargin: +(ccState.brakingMargin ?? 0),
      targetLimitReason: ccState.targetLimitReason ?? 'NONE',
      throttleLimitReason: ccState.throttleLimitReason ?? 'NONE',
      brakeReason: ccState.brakeReason ?? 'NONE',
    });
  }
}
console.log(`   [NOVA] Flying Lap Time: ${novaFlyingLapTime?.toFixed(3)}s (${novaRawTelemetry.length} raw samples)\n`);

// ----------------------------------------------------------------------------
// 3. Resample Both Trajectories at 1.0m Station Intervals
// ----------------------------------------------------------------------------
console.log('3. Resampling trajectories at 1.0m station intervals (s = 0, 1, ..., 2704)...');

function resampleAtStations(rawTelemetry) {
  // Sort by station s
  const sorted = [...rawTelemetry].sort((a, b) => a.s - b.s);
  const nStations = Math.floor(TRACK_LEN);
  const stationMap = new Array(nStations);

  for (let s = 0; s < nStations; s++) {
    let afterIdx = sorted.findIndex((p) => p.s >= s);
    if (afterIdx === -1) afterIdx = 0;
    const beforeIdx = (afterIdx - 1 + sorted.length) % sorted.length;

    const p0 = sorted[beforeIdx];
    const p1 = sorted[afterIdx];

    let ds = p1.s - p0.s;
    if (ds < 0) ds += TRACK_LEN;
    let sDiff = s - p0.s;
    if (sDiff < 0) sDiff += TRACK_LEN;
    const t = ds > 1e-6 ? Math.min(1, Math.max(0, sDiff / ds)) : 0;

    const interp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + (b - a) * t : a);

    stationMap[s] = {
      s,
      speed: +interp(p0.speed, p1.speed).toFixed(3),
      speedKmh: +interp(p0.speedKmh, p1.speedKmh).toFixed(1),
      q: +interp(p0.q, p1.q).toFixed(3),
      x: +interp(p0.x, p1.x).toFixed(3),
      z: +interp(p0.z, p1.z).toFixed(3),
      throttle: +interp(p0.throttle, p1.throttle).toFixed(3),
      brake: +interp(p0.brake, p1.brake).toFixed(3),
      steer: +interp(p0.steer, p1.steer).toFixed(3),
      yaw: +interp(p0.yaw, p1.yaw).toFixed(4),
      yawRate: +interp(p0.yawRate, p1.yawRate).toFixed(4),
      beta: +interp(p0.beta, p1.beta).toFixed(4),
      ax: +interp(p0.ax, p1.ax).toFixed(3),
      ay: +interp(p0.ay, p1.ay).toFixed(3),
      margin: +interp(p0.margin, p1.margin).toFixed(3),
      frontUtil: +interp(p0.frontUtil, p1.frontUtil).toFixed(3),
      rearUtil: +interp(p0.rearUtil, p1.rearUtil).toFixed(3),
    };

    if (p0.targetLimitReason !== undefined) {
      stationMap[s].refSpeed = +interp(p0.refSpeed ?? 0, p1.refSpeed ?? 0).toFixed(3);
      stationMap[s].refSpeedKmh = +interp(p0.refSpeedKmh ?? 0, p1.refSpeedKmh ?? 0).toFixed(1);
      stationMap[s].vTarget = +interp(p0.vTarget ?? 0, p1.vTarget ?? 0).toFixed(3);
      stationMap[s].vTargetKmh = +interp(p0.vTargetKmh ?? 0, p1.vTargetKmh ?? 0).toFixed(1);
      stationMap[s].vAllow = +interp(p0.vAllow ?? 0, p1.vAllow ?? 0).toFixed(3);
      stationMap[s].vGrip = +interp(p0.vGrip ?? 0, p1.vGrip ?? 0).toFixed(3);
      stationMap[s].brakingMargin = +interp(p0.brakingMargin ?? 0, p1.brakingMargin ?? 0).toFixed(3);
      stationMap[s].targetLimitReason = t > 0.5 ? p1.targetLimitReason : p0.targetLimitReason;
      stationMap[s].throttleLimitReason = t > 0.5 ? p1.throttleLimitReason : p0.throttleLimitReason;
      stationMap[s].brakeReason = t > 0.5 ? p1.brakeReason : p0.brakeReason;
    }
  }
  return stationMap;
}

const geminiStation = resampleAtStations(geminiRawTelemetry);
const novaStation = resampleAtStations(novaRawTelemetry);
const nStations = Math.min(geminiStation.length, novaStation.length);

// ----------------------------------------------------------------------------
// 4. Calculate Delta-T by Station (dt/ds = 1 / v) and Cumulative Delta
// ----------------------------------------------------------------------------
console.log('4. Integrating dt/ds = 1/v around the lap...');

let cumDelta = 0;
const stationDeltas = new Array(nStations);
const falseConservatismWitnesses = [];

for (let s = 0; s < nStations; s++) {
  const g = geminiStation[s];
  const n = novaStation[s];

  const dtG = 1.0 / Math.max(1.0, g.speed);
  const dtN = 1.0 / Math.max(1.0, n.speed);
  const deltaDt = dtN - dtG;
  cumDelta += deltaDt;

  stationDeltas[s] = {
    s,
    geminiSpeedKmh: g.speedKmh,
    novaSpeedKmh: n.speedKmh,
    speedDeltaKmh: +(n.speedKmh - g.speedKmh).toFixed(1),
    dtGemini: +dtG.toFixed(5),
    dtNova: +dtN.toFixed(5),
    stationDeltaSec: +deltaDt.toFixed(5),
    cumulativeDeltaSec: +cumDelta.toFixed(4),
  };

  if (g.speedKmh >= n.speedKmh + 15.0 || g.speedKmh >= (n.vTargetKmh || 0) + 10.0) {
    falseConservatismWitnesses.push({
      s,
      geminiSpeedKmh: g.speedKmh,
      novaSpeedKmh: n.speedKmh,
      novaTargetSpeedKmh: n.vTargetKmh ?? null,
      speedDeficitKmh: +(g.speedKmh - n.speedKmh).toFixed(1),
      novaTargetLimitReason: n.targetLimitReason ?? 'NONE',
      novaThrottleLimitReason: n.throttleLimitReason ?? 'NONE',
      novaBrakeReason: n.brakeReason ?? 'NONE',
    });
  }
}

// ----------------------------------------------------------------------------
// 5. Complex Metrics & Comparison
// ----------------------------------------------------------------------------
console.log('5. Evaluating Harbor Complexes...');
const complexComparisons = HARBOR_COMPLEXES.map((comp) => {
  const sStart = comp.sStart;
  const sEnd = Math.min(nStations, comp.sEnd);
  const dist = sEnd - sStart;

  let timeG = 0;
  let timeN = 0;
  const gSpeeds = [];
  const nSpeeds = [];

  for (let s = Math.floor(sStart); s < Math.floor(sEnd); s++) {
    timeG += 1.0 / Math.max(1.0, geminiStation[s].speed);
    timeN += 1.0 / Math.max(1.0, novaStation[s].speed);
    gSpeeds.push(geminiStation[s].speedKmh);
    nSpeeds.push(novaStation[s].speedKmh);
  }

  const delta = timeN - timeG;

  return {
    id: comp.id,
    name: comp.name,
    sStart,
    sEnd,
    distanceM: dist,
    geminiTimeSec: +timeG.toFixed(3),
    novaTimeSec: +timeN.toFixed(3),
    deltaSec: +delta.toFixed(3),
    geminiMinSpeedKmh: +Math.min(...gSpeeds).toFixed(1),
    novaMinSpeedKmh: +Math.min(...nSpeeds).toFixed(1),
    geminiMaxSpeedKmh: +Math.max(...gSpeeds).toFixed(1),
    novaMaxSpeedKmh: +Math.max(...nSpeeds).toFixed(1),
  };
});

// ----------------------------------------------------------------------------
// 6. Identify Top 10 NOVA Loss Zones (using 25m sliding windows)
// ----------------------------------------------------------------------------
const WINDOW_M = 25;
const lossWindows = [];
for (let s = 0; s < nStations - WINDOW_M; s += 10) {
  let loss = 0;
  let gSum = 0, nSum = 0;
  for (let k = 0; k < WINDOW_M; k++) {
    loss += stationDeltas[s + k].stationDeltaSec;
    gSum += geminiStation[s + k].speedKmh;
    nSum += novaStation[s + k].speedKmh;
  }
  lossWindows.push({
    sStart: s,
    sEnd: s + WINDOW_M,
    lossSec: +loss.toFixed(3),
    geminiAvgSpeedKmh: +(gSum / WINDOW_M).toFixed(1),
    novaAvgSpeedKmh: +(nSum / WINDOW_M).toFixed(1),
    speedDeficitKmh: +((gSum - nSum) / WINDOW_M).toFixed(1),
  });
}

lossWindows.sort((a, b) => b.lossSec - a.lossSec);

const top10LossZones = [];
for (const w of lossWindows) {
  const overlaps = top10LossZones.some((z) => Math.abs(z.sStart - w.sStart) < WINDOW_M);
  if (!overlaps && w.lossSec > 0.05) {
    top10LossZones.push({
      rank: top10LossZones.length + 1,
      ...w,
      dominantReason: novaStation[Math.floor((w.sStart + w.sEnd) / 2)].targetLimitReason || 'NONE',
    });
    if (top10LossZones.length === 10) break;
  }
}

// ----------------------------------------------------------------------------
// 7. Named Probes Around User-Observed Corners
// ----------------------------------------------------------------------------
function evaluateProbe(name, sStart, sEnd) {
  const gPts = geminiRawTelemetry.filter((p) => p.s >= sStart && p.s <= sEnd);
  const nPts = novaRawTelemetry.filter((p) => p.s >= sStart && p.s <= sEnd);

  const getProbeMetrics = (pts) => {
    if (!pts.length) return {};
    const speeds = pts.map((p) => p.speedKmh);
    const brakes = pts.map((p) => p.brake);
    const throttles = pts.map((p) => p.throttle);
    const firstBrake = pts.find((p) => p.brake > 0.1);
    const brakePts = pts.filter((p) => p.brake > 0.1);
    const first50Thr = pts.find((p) => p.throttle >= 0.50);
    const first95Thr = pts.find((p) => p.throttle >= 0.95);

    return {
      entrySpeedKmh: +speeds[0].toFixed(1),
      minSpeedKmh: +Math.min(...speeds).toFixed(1),
      exitSpeedKmh: +speeds[speeds.length - 1].toFixed(1),
      brakeOnStation: firstBrake ? +firstBrake.s.toFixed(1) : null,
      brakePeak: +Math.max(...brakes).toFixed(3),
      brakeDurationSec: +(brakePts.length * DT).toFixed(3),
      first50ThrottleStation: first50Thr ? +first50Thr.s.toFixed(1) : null,
      first95ThrottleStation: first95Thr ? +first95Thr.s.toFixed(1) : null,
      maxBeta: +Math.max(...pts.map((p) => Math.abs(p.beta))).toFixed(4),
      maxYawRate: +Math.max(...pts.map((p) => Math.abs(p.yawRate))).toFixed(4),
      maxQ: +Math.max(...pts.map((p) => Math.abs(p.q))).toFixed(3),
    };
  };

  const gMetrics = getProbeMetrics(gPts);
  const nMetrics = getProbeMetrics(nPts);

  let lossSource = 'OPTIMAL';
  if (nMetrics.brakeOnStation && gMetrics.brakeOnStation && nMetrics.brakeOnStation < gMetrics.brakeOnStation - 15) {
    lossSource = 'EARLY_BRAKE';
  } else if (nMetrics.minSpeedKmh < gMetrics.minSpeedKmh - 15) {
    lossSource = 'FALSE_SPEED_CAP';
  } else if (nMetrics.first95ThrottleStation && gMetrics.first95ThrottleStation && nMetrics.first95ThrottleStation > gMetrics.first95ThrottleStation + 15) {
    lossSource = 'EXIT_THROTTLE_CHOKE';
  }

  return {
    probeName: name,
    stationRange: [sStart, sEnd],
    lossSource,
    gemini: gMetrics,
    nova: nMetrics,
  };
}

const namedProbes = {
  FIRST_CHICANE: evaluateProbe('FIRST_CHICANE', 650, 950),
  FOLLOWING_LONG_RIGHT: evaluateProbe('FOLLOWING_LONG_RIGHT', 1100, 1350),
  WEST_LOOP_ENTRY: evaluateProbe('WEST_LOOP_ENTRY', 1950, 2300),
};

// ----------------------------------------------------------------------------
// 8. Output Report & Print Diagnostics
// ----------------------------------------------------------------------------
const comparisonReport = {
  timestamp: new Date().toISOString(),
  circuit: 'harbor-ring',
  geminiFlyingLapTimeSec: geminiFlyingLapTime,
  novaFlyingLapTimeSec: novaFlyingLapTime,
  deltaLapTimeSec: +(novaFlyingLapTime - geminiFlyingLapTime).toFixed(3),
  complexComparisons,
  top10LossZones,
  namedProbes,
  falseConservatismWitnessCount: falseConservatismWitnesses.length,
  falseConservatismWitnesses: falseConservatismWitnesses.slice(0, 50),
  stationAlignedData: {
    stationCount: nStations,
    gemini: geminiStation,
    nova: novaStation,
    deltas: stationDeltas,
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/nova-vs-gemini-harbor.json', JSON.stringify(comparisonReport, null, 2));
console.log('Successfully saved full comparison to artifacts/nova-vs-gemini-harbor.json\n');

// Print Complex Summary Table
console.log('------------------------------------------------------------------------------------------------');
console.log('| Complex          | Gemini (s) | NOVA (s)   | Delta (s)  | Gem Min/Max (km/h) | NOVA Min/Max (km/h) |');
console.log('------------------------------------------------------------------------------------------------');
for (const c of complexComparisons) {
  const gSpd = `[${c.geminiMinSpeedKmh}-${c.geminiMaxSpeedKmh}]`.padEnd(18);
  const nSpd = `[${c.novaMinSpeedKmh}-${c.novaMaxSpeedKmh}]`.padEnd(19);
  console.log(
    `| ${c.name.padEnd(16)} | ${c.geminiTimeSec.toFixed(2).padStart(10)} | ${c.novaTimeSec.toFixed(2).padStart(10)} | ${c.deltaSec.toFixed(2).padStart(10)} | ${gSpd} | ${nSpd} |`
  );
}
console.log('------------------------------------------------------------------------------------------------\n');

// Print Top 10 Loss Zones
console.log('--- TOP 10 NOVA LOSS ZONES (MEASURED DEFICIT) ---');
for (const z of top10LossZones) {
  console.log(
    `  Rank ${z.rank}: s=[${z.sStart}-${z.sEnd}m] | Loss: +${z.lossSec.toFixed(2)}s | Spd Deficit: ${z.speedDeficitKmh.toFixed(1)} km/h (Gem: ${z.geminiAvgSpeedKmh} vs NOVA: ${z.novaAvgSpeedKmh}) | Reason: ${z.dominantReason}`
  );
}

// Print Named Probes
console.log('\n--- NAMED PROBES (USER-OBSERVED CORNERS) ---');
for (const [key, p] of Object.entries(namedProbes)) {
  console.log(`\nPROBE: ${p.probeName} (s: ${p.stationRange[0]}m -> ${p.stationRange[1]}m) | PRIMARY LOSS SOURCE: ${p.lossSource}`);
  console.log(`  Gemini: brakeOn=${p.gemini.brakeOnStation}m, minSpd=${p.gemini.minSpeedKmh} km/h, first95Thr=${p.gemini.first95ThrottleStation}m, exitSpd=${p.gemini.exitSpeedKmh} km/h, maxQ=${p.gemini.maxQ}m`);
  console.log(`  NOVA:   brakeOn=${p.nova.brakeOnStation}m, minSpd=${p.nova.minSpeedKmh} km/h, first95Thr=${p.nova.first95ThrottleStation}m, exitSpd=${p.nova.exitSpeedKmh} km/h, maxQ=${p.nova.maxQ}m`);
}

console.log(`\nTotal False Conservatism Witness Stations: ${falseConservatismWitnesses.length}`);
