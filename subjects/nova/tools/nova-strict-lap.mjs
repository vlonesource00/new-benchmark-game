// Wave 9 strict NOVA diagnostic harness.
//
// Runs the native plant with NOVAFreeAirController in STRICT mode: the legacy
// fallback is disabled, the first guard trigger ends the run as a FAIL, and the
// rolling telemetry is dumped for root-cause analysis. No legacy lap can be
// reported by this tool: it reports novaControlFraction explicitly.
//
//   node tools/nova-strict-lap.mjs [--seconds 120] [--scale 1] [--trace artifacts/nova-first-3s.json]

import { writeFileSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dt = 1 / 120;
const maxSeconds = Number(arg('seconds', 120));
const scale = Number(arg('scale', 1));
const traceOut = arg('trace', 'artifacts/nova-first-3s.json');

const track = new Track('harbor-ring');
const session = new Session(track, { classId: 'gt' });
session.mode = 'practice';
session.laps = 1;
session.autopilot = true;
session.aiKind = 'nova';
session.aiOptions = { novaSpeedScale: scale, strict: true, trace: true };
session.start();

const car = session.cars[0];
// Rebuild the drivers so they are constructed WITH the strict/trace options:
// the constructors ran before aiOptions was assigned.
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

// Chicane tracking (s: 2339.5 -> 2704.6)
let inChicane = false;
let chicaneTime = 0;
let chicaneEntrySpeed = 0;
let chicaneMinSpeed = Infinity;
let chicaneExitSpeed = 0;
let chicanePathLen = 0;
let prevChicaneX = 0, prevChicaneZ = 0;
let chicaneMinMargin = Infinity;

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

  // Chicane sector monitoring
  const s = car.s;
  if (s >= 2339.5 && s <= 2704.6) {
    if (!inChicane) {
      inChicane = true;
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
  } else {
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

const report = {
  mode: 'strict',
  scale,
  simSeconds: +simTime.toFixed(3),
  novaControlTime: +novaControlTime.toFixed(3),
  legacyControlTime: +(ai.legacyTime ?? 0).toFixed(3),
  novaControlFraction: +(novaControlTime / Math.max(1e-9, simTime)).toFixed(4),
  fallbackCount: ai.fallbackCount ?? 0,
  firstFallbackTime: ai.firstFallbackTime ?? null,
  firstFallbackReason: ai.firstFallbackReason ?? null,
  strictFail: ai.strictFail ?? null,
  lapsCompleted: laps.length,
  countdownTime: 4,
  activeRaceTime: +Math.max(0, simTime - 4).toFixed(3),
  lapTimes: laps,
  maxAbsQ: +maxQ.toFixed(3),
  offtrackSeconds: +offtrack.toFixed(3),
  finalS: +car.s.toFixed(1),
  distanceTravelled: +distance.toFixed(1),
  raceLap: car.race?.lap ?? null,
  finalSpeed: +car.speed.toFixed(2),
  throttleMetrics: {
    meanThrottle: +meanThrottle.toFixed(3),
    p95Throttle: +p95Throttle.toFixed(3),
    maxThrottle: +(throttles[throttles.length - 1] ?? 0).toFixed(3),
    eligibleFullThrottleTimeSec: +eligibleFullThrottleTime.toFixed(3),
    actualFullThrottleTimeSec: +fullThrottleTime.toFixed(3),
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
  },
  traceSamples: ai.trace?.length ?? 0,
};

writeFileSync(traceOut, JSON.stringify({ report, trace: ai.trace ?? [] }, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`trace -> ${traceOut}`);



