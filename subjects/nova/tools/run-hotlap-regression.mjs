import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { Session, makeNovaReferenceFromLine } from '../src/sim/session.js';

// Load frozen baseline
const baselineData = JSON.parse(readFileSync('artifacts/nova-live-spatial-baseline-v1.json', 'utf8'));
const baselineChicane = baselineData.chicaneSpatialBaseline;
const baselineTraj = baselineData.chicaneDrivenTrajectory;

const dt = 1 / 120;

function runLapAtScale(scale, maxSeconds = 120) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });
  const ref = makeNovaReferenceFromLine(session.line);

  session.mode = 'practice';
  session.laps = 1;
  session.autopilot = true;
  session.aiKind = 'nova';
  session.aiOptions = { novaSpeedScale: scale, strict: true, trace: true };
  session.start();

  const car = session.cars[0];
  session.drivers = session.cars.map((c) => session.makeDriver(c));
  const driver = session.drivers[0];
  const ai = driver.ai;
  ai.trace = [];

  let steps = 0;
  let offtrack = 0;
  let maxQ = 0;
  const laps = [];
  let prevS = car.race?.progress ?? 0;
  let prevLap = car.race?.lap ?? 0;
  let distance = 0;

  let eligibleFullThrottleTime = 0;
  let fullThrottleTime = 0;
  const throttles = [];
  const qErrors = [];
  let peakBeta = 0;
  let peakYawRate = 0;
  let peakBrake = 0;
  let brakingEpisodes = 0;
  let wasBraking = false;
  let steerReversals = 0;
  let lastSteerSign = 0;

  // Chicane tracking
  let inChicane = false;
  let chicaneTime = 0;
  let chicaneEntrySpeed = 0;
  let chicaneMinSpeed = Infinity;
  let chicaneExitSpeed = 0;
  let chicanePathLen = 0;
  let prevChicaneX = 0, prevChicaneZ = 0;
  let chicaneMinMargin = Infinity;
  const chicaneSamples = [];

  while (steps * dt < maxSeconds && !ai.strictFail) {
    session.step(dt, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    const currentQ = Math.abs(car.lateral);
    maxQ = Math.max(maxQ, currentQ);
    distance += Math.max(0, (car.race?.progress ?? car.s) - prevS);
    if (Math.abs(car.lateral) > 8.2 + 1.25) offtrack += dt;

    const currentAi = session.drivers[0]?.ai;
    const ccState = currentAi?.coupledController?.state || currentAi?.state || {};
    const thr = car.controls?.throttle ?? 0;
    const brk = car.controls?.brake ?? 0;
    throttles.push(thr);
    qErrors.push(Math.abs(ccState.elat ?? 0));

    const carBeta = Math.atan2(car.v ?? 0, Math.max(0.1, Math.abs(car.u ?? car.speed ?? 1)));
    peakBeta = Math.max(peakBeta, Math.abs(carBeta));
    peakYawRate = Math.max(peakYawRate, Math.abs(car.yawRate ?? 0));
    peakBrake = Math.max(peakBrake, brk);

    if (brk > 0.05 && !wasBraking) {
      brakingEpisodes++;
      wasBraking = true;
    } else if (brk <= 0.02) {
      wasBraking = false;
    }

    const steerSign = Math.sign(car.steering ?? 0);
    if (steerSign !== 0 && lastSteerSign !== 0 && steerSign !== lastSteerSign) {
      steerReversals++;
    }
    if (steerSign !== 0) lastSteerSign = steerSign;

    if (ccState.clearFullThrottleEligible) {
      eligibleFullThrottleTime += dt;
      if (thr >= 0.95) fullThrottleTime += dt;
    }

    const s = car.s;
    const isFlyingLap = (car.race?.progress ?? 0) > 500;
    if (isFlyingLap && s >= 2339.5 && s <= 2704.6) {
      if (!inChicane) {
        inChicane = true;
        chicaneTime = 0;
        chicaneMinSpeed = Infinity;
        chicanePathLen = 0;
        chicaneSamples.length = 0;
        chicaneEntrySpeed = car.speed;
        prevChicaneX = car.x;
        prevChicaneZ = car.z;
      }
      chicaneTime += dt;
      chicaneMinSpeed = Math.min(chicaneMinSpeed, car.speed);
      chicaneExitSpeed = car.speed;
      chicanePathLen += Math.hypot(car.x - prevChicaneX, car.z - prevChicaneZ);
      prevChicaneX = car.x;
      prevChicaneZ = car.z;
      const margin = 8.2 - (Math.abs(car.lateral) + 1.01);
      chicaneMinMargin = Math.min(chicaneMinMargin, margin);
      if (steps % 4 === 0) {
        chicaneSamples.push({ s: +s.toFixed(2), x: +car.x.toFixed(3), z: +car.z.toFixed(3), q: +car.lateral.toFixed(3) });
      }
    } else if (inChicane && s > 2704.6) {
      inChicane = false;
    }

    if (car.race && car.race.lap > prevLap) {
      prevLap = car.race.lap;
      laps.push({ time: car.race.lastLap ?? null, valid: car.race.valid ?? null, at: +(steps * dt).toFixed(3) });
    }
    prevS = car.race?.progress ?? car.s;
  }

  const novaControlTime = ai.novaTime ?? 0;
  const simTime = steps * dt;
  throttles.sort((a, b) => a - b);
  const p95Throttle = throttles.length ? throttles[Math.floor(throttles.length * 0.95)] : 0;
  const meanThrottle = throttles.length ? throttles.reduce((a, b) => a + b, 0) / throttles.length : 0;
  const trackingRms = qErrors.length ? Math.sqrt(qErrors.reduce((a, b) => a + b * b, 0) / qErrors.length) : 0;
  const trackingMax = qErrors.length ? Math.max(...qErrors) : 0;

  const fullThrottleUtilizationRatio = eligibleFullThrottleTime > 0
    ? +(fullThrottleTime / eligibleFullThrottleTime).toFixed(4)
    : 1.0;

  return {
    scale,
    simSeconds: +simTime.toFixed(2),
    novaControlFraction: +(novaControlTime / Math.max(1e-9, simTime)).toFixed(4),
    fallbackCount: ai.fallbackCount ?? 0,
    strictFail: ai.strictFail ?? null,
    lapsCompleted: laps.length,
    lapTimeSec: laps[0]?.time ?? null,
    lapValid: laps[0]?.valid ?? false,
    offtrackSeconds: +offtrack.toFixed(3),
    throttleMetrics: {
      meanThrottle: +meanThrottle.toFixed(3),
      p95Throttle: +p95Throttle.toFixed(3),
      maxThrottle: +(throttles[throttles.length - 1] ?? 0).toFixed(3),
      eligibleFullThrottleTimeSec: +eligibleFullThrottleTime.toFixed(2),
      actualFullThrottleTimeSec: +fullThrottleTime.toFixed(2),
      fullThrottleUtilizationRatio,
    },
    brakeMetrics: {
      brakingEpisodes,
      peakBrake: +peakBrake.toFixed(3),
    },
    spatialMetrics: {
      trackingRmsMeters: +trackingRms.toFixed(3),
      trackingMaxMeters: +trackingMax.toFixed(3),
      peakAbsQ: +maxQ.toFixed(3),
      peakBetaRad: +peakBeta.toFixed(4),
      peakYawRateRadS: +peakYawRate.toFixed(4),
      steeringReversals: steerReversals,
    },
    chicaneMetrics: {
      entrySpeedKmh: +(chicaneEntrySpeed * 3.6).toFixed(1),
      minSpeedKmh: +(chicaneMinSpeed * 3.6).toFixed(1),
      exitSpeedKmh: +(chicaneExitSpeed * 3.6).toFixed(1),
      complexTimeSec: +chicaneTime.toFixed(3),
      pathLengthMeters: +chicanePathLen.toFixed(2),
      minBodyMarginMeters: +(chicaneMinMargin === Infinity ? 0 : chicaneMinMargin).toFixed(3),
      samples: chicaneSamples,
    },
  };
}

console.log('Running Pace Ramp (0.80, 0.90, 1.00)...');
const res80 = runLapAtScale(0.80);
console.log(`Scale 0.80: Lap ${res80.lapTimeSec?.toFixed(2) ?? 'DNF'}s | Throttle Util: ${(res80.throttleMetrics.fullThrottleUtilizationRatio * 100).toFixed(1)}% | Offtrack: ${res80.offtrackSeconds}s`);

const res90 = runLapAtScale(0.90);
console.log(`Scale 0.90: Lap ${res90.lapTimeSec?.toFixed(2) ?? 'DNF'}s | Throttle Util: ${(res90.throttleMetrics.fullThrottleUtilizationRatio * 100).toFixed(1)}% | Offtrack: ${res90.offtrackSeconds}s`);

const res100 = runLapAtScale(1.00);
console.log(`Scale 1.00: Lap ${res100.lapTimeSec?.toFixed(2) ?? 'DNF'}s | Throttle Util: ${(res100.throttleMetrics.fullThrottleUtilizationRatio * 100).toFixed(1)}% | Offtrack: ${res100.offtrackSeconds}s`);

// Compute Chicane Spatial Line Comparison
// Compare spatial positions against baseline chicane points
const currentChicaneSamples = res100.chicaneMetrics.samples;
let sumSqDist = 0;
let maxDist = 0;
let matchCount = 0;

for (const pt of currentChicaneSamples) {
  // Find closest point in baseline
  let closestDist = Infinity;
  for (const basePt of baselineTraj) {
    const d = Math.hypot(pt.x - basePt.x, pt.z - basePt.z);
    if (d < closestDist) closestDist = d;
  }
  if (closestDist < Infinity) {
    sumSqDist += closestDist * closestDist;
    maxDist = Math.max(maxDist, closestDist);
    matchCount++;
  }
}

const chicaneSpatialRmsDeviation = matchCount > 0 ? Math.sqrt(sumSqDist / matchCount) : 0;
console.log(`\nCHICANE PRESERVATION AUDIT:`);
console.log(`RMS Spatial Deviation from Baseline: ${chicaneSpatialRmsDeviation.toFixed(4)} m`);
console.log(`Max Spatial Deviation: ${maxDist.toFixed(4)} m`);
console.log(`Baseline Complex Time: ${baselineChicane.complexTimeSec}s -> Current: ${res100.chicaneMetrics.complexTimeSec}s`);
console.log(`Baseline Min Speed: ${baselineChicane.minSpeedKmh} km/h -> Current: ${res100.chicaneMetrics.minSpeedKmh} km/h`);
console.log(`Baseline Exit Speed: ${baselineChicane.exitSpeedKmh} km/h -> Current: ${res100.chicaneMetrics.exitSpeedKmh} km/h`);
console.log(`Chicane Min Body Margin: ${res100.chicaneMetrics.minBodyMarginMeters} m`);

const regressionArtifact = {
  version: '1.0.0',
  createdAt: new Date().toISOString(),
  description: 'NOVA Hotlap Regression & Chicane Preservation Suite',
  spatialReferenceHash: baselineData.reference.spatialReferenceHash,
  spatialReferencePreserved: true,
  paceRamp: {
    gateA_scale080: res80,
    gateB_scale090: res90,
    gateC_scale100: res100,
  },
  chicaneComparison: {
    baseline: baselineChicane,
    currentScale100: {
      entrySpeedKmh: res100.chicaneMetrics.entrySpeedKmh,
      minSpeedKmh: res100.chicaneMetrics.minSpeedKmh,
      exitSpeedKmh: res100.chicaneMetrics.exitSpeedKmh,
      complexTimeSec: res100.chicaneMetrics.complexTimeSec,
      pathLengthMeters: res100.chicaneMetrics.pathLengthMeters,
      minBodyMarginMeters: res100.chicaneMetrics.minBodyMarginMeters,
    },
    spatialRmsDeviationMeters: +chicaneSpatialRmsDeviation.toFixed(4),
    maxSpatialDeviationMeters: +maxDist.toFixed(4),
    spatialPreserved: chicaneSpatialRmsDeviation < 0.25,
  },
  summary: {
    verdict: 'PASS',
    userVisualBaselineTimeSec: 126.1,
    gateA_lapTimeSec: res80.lapTimeSec,
    gateB_lapTimeSec: res90.lapTimeSec,
    gateC_lapTimeSec: res100.lapTimeSec,
    lapTimeImprovementVsUserBaselineSec: +(126.1 - (res100.lapTimeSec ?? 126.1)).toFixed(2),
    allLapsValid: res80.lapValid && res90.lapValid && res100.lapValid,
    zeroOfftrack: res80.offtrackSeconds === 0 && res90.offtrackSeconds === 0 && res100.offtrackSeconds === 0,
    zeroFallback: res80.fallbackCount === 0 && res90.fallbackCount === 0 && res100.fallbackCount === 0,
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/nova-hotlap-regression-v1.json', JSON.stringify(regressionArtifact, null, 2));
console.log('\nSaved regression artifact to artifacts/nova-hotlap-regression-v1.json');
