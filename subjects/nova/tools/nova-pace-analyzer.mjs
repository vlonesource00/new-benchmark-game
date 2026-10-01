import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { Track } from '../src/sim/track.js';
import { Session, makeNovaReferenceFromLine } from '../src/sim/session.js';

const dt = 1 / 120;
const TRACK_NAME = 'harbor-ring';

export const HARBOR_COMPLEXES = [
  { id: 'MAIN_STRAIGHT', name: 'Main Straight', sStart: 0, sEnd: 850 },
  { id: 'EAST_HAIRPIN', name: 'East Hairpin', sStart: 850, sEnd: 1150 },
  { id: 'EAST_EXIT', name: 'East Exit', sStart: 1150, sEnd: 1350 },
  { id: 'CONTAINER_ESSES', name: 'Container Esses', sStart: 1350, sEnd: 1600 },
  { id: 'MID_COMPLEX', name: 'Mid Complex', sStart: 1600, sEnd: 1950 },
  { id: 'WEST_LOOP', name: 'West Loop', sStart: 1950, sEnd: 2350 },
  { id: 'FINAL_CHICANE', name: 'Final Chicane', sStart: 2350, sEnd: 2650 },
  { id: 'FINAL_EXIT', name: 'Final Exit', sStart: 2650, sEnd: 2704.62 },
];

export function getComplexForS(s) {
  const normS = ((s % 2704.6192) + 2704.6192) % 2704.6192;
  for (const comp of HARBOR_COMPLEXES) {
    if (normS >= comp.sStart && normS < comp.sEnd) return comp;
  }
  return HARBOR_COMPLEXES[HARBOR_COMPLEXES.length - 1];
}

export function runDeterministicPaceBenchmark(numLaps = 5, aiOptionsOverride = {}) {
  const track = new Track(TRACK_NAME);
  const session = new Session(track, { classId: 'gt' });

  session.mode = 'practice';
  session.laps = numLaps + 2; // 1 out-lap + numLaps flying laps
  session.autopilot = true;
  session.aiKind = 'nova';
  session.aiOptions = {
    novaSpeedScale: 1.0,
    strict: true,
    trace: true,
    ...aiOptionsOverride,
  };
  session.start();

  const car = session.cars[0];
  session.drivers = session.cars.map((c) => session.makeDriver(c));
  const driver = session.drivers[0];
  const ai = driver.ai;

  let steps = 0;
  const maxSteps = (numLaps + 2) * 90 * 120; // 90 sec per lap max
  let prevLap = 0;
  let prevS = car.race?.progress ?? 0;

  const completedLaps = [];
  let currentLapTelemetry = [];
  let flyingLapTelemetries = [];

  let wastedCoastCount = 0;
  let wastedCoastSeconds = 0;
  let currentCoastDuration = 0;

  let fullThrottleEligibleTime = 0;
  let actualFullThrottleTime = 0;

  let lastSteerSign = 0;
  let steerReversals = 0;

  while (steps < maxSteps && completedLaps.length < numLaps && !ai.strictFail) {
    session.step(dt, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    const thr = car.controls?.throttle ?? 0;
    const brk = car.controls?.brake ?? 0;
    const spd = car.speed ?? car.u ?? 0;
    const s = car.s;
    const q = car.lateral;
    const ax_g = (car.ax ?? 0) / 9.81;
    const ay_g = (car.ay ?? 0) / 9.81;
    const beta = Math.atan2(car.v ?? 0, Math.max(0.1, Math.abs(car.u ?? spd)));
    const yawRate = car.yawRate ?? 0;

    const currentAi = session.drivers[0]?.ai;
    const cc = currentAi?.coupledController;
    const ccState = cc?.state || currentAi?.state || {};

    const margin = 8.2 - (Math.abs(q) + 0.99); // half track width 8.2m minus half car width 0.99m
    const isOfftrack = margin < 0;

    // Steer reversals
    const steerSign = Math.sign(car.steering ?? 0);
    if (steerSign !== 0 && lastSteerSign !== 0 && steerSign !== lastSteerSign) {
      steerReversals++;
    }
    if (steerSign !== 0) lastSteerSign = steerSign;

    // Full throttle tracking
    if (ccState.clearFullThrottleEligible) {
      fullThrottleEligibleTime += dt;
      if (thr >= 0.95) actualFullThrottleTime += dt;
    }

    // Wasted coast detection: thr < 0.10 and brk < 0.10 for > 0.15s
    if (thr < 0.10 && brk < 0.10) {
      currentCoastDuration += dt;
      if (currentCoastDuration >= 0.15) {
        wastedCoastSeconds += dt;
      }
    } else {
      if (currentCoastDuration >= 0.15) wastedCoastCount++;
      currentCoastDuration = 0;
    }

    // Telemetry record
    const point = {
      t: +(steps * dt).toFixed(4),
      s: +s.toFixed(2),
      progress: +(car.race?.progress ?? 0).toFixed(2),
      x: +car.x.toFixed(3),
      z: +car.z.toFixed(3),
      yaw: +car.yaw.toFixed(4),
      speed: +spd.toFixed(3),
      speedKmh: +(spd * 3.6).toFixed(1),
      targetSpeed: +(ccState.targetSpeed ?? 0).toFixed(3),
      throttle: +thr.toFixed(3),
      brake: +brk.toFixed(3),
      steer: +(car.controls?.steer ?? 0).toFixed(3),
      q: +q.toFixed(3),
      margin: +margin.toFixed(3),
      ax_g: +ax_g.toFixed(3),
      ay_g: +ay_g.toFixed(3),
      beta: +beta.toFixed(4),
      yawRate: +yawRate.toFixed(4),
      targetLimitReason: ccState.targetLimitReason ?? 'NONE',
      throttleLimitReason: ccState.throttleLimitReason ?? 'NONE',
      brakeReason: ccState.brakeReason ?? 'NONE',
      isOfftrack,
    };

    // Telemetry record for current timed lap
    if (car.race && car.race.progress >= 0) {
      currentLapTelemetry.push(point);
    }

    // Lap crossing
    if (car.race && car.race.lap > prevLap) {
      const finishedLap = prevLap;
      prevLap = car.race.lap;
      const lapTime = car.race.lastLap ?? 0;
      const lapValid = Boolean(car.race.valid);

      // Only record completed flying laps with sufficient points
      if (finishedLap >= 1 && currentLapTelemetry.length > 500) {
        completedLaps.push({
          lapIndex: completedLaps.length + 1,
          lapTimeSec: +lapTime.toFixed(3),
          valid: lapValid,
          offtrackCount: currentLapTelemetry.filter((p) => p.isOfftrack).length,
          fallbackCount: ai.fallbackCount ?? 0,
        });
        flyingLapTelemetries.push([...currentLapTelemetry]);
      }
      currentLapTelemetry = [];
    }
  }

  console.log(`Finished sim after ${steps} steps. Car at s=${car.s.toFixed(1)}, q=${car.lateral.toFixed(2)}, spd=${(car.speed*3.6).toFixed(1)}, lap=${car.race?.lap}`);

  // Find best, median, worst
  const sortedLaps = [...completedLaps].sort((a, b) => a.lapTimeSec - b.lapTimeSec);
  const bestLap = sortedLaps[0];
  const worstLap = sortedLaps[sortedLaps.length - 1];
  const medianLap = sortedLaps[Math.floor(sortedLaps.length / 2)];

  // Select telemetry corresponding to the best lap
  const bestIndex = completedLaps.findIndex((l) => l.lapTimeSec === bestLap?.lapTimeSec);
  const repTelemetry = flyingLapTelemetries[bestIndex >= 0 ? bestIndex : 0] || [];

  // Build sector/complex loss map from representative lap
  const complexMetrics = HARBOR_COMPLEXES.map((comp) => {
    const pts = repTelemetry.filter((p) => p.s >= comp.sStart && p.s < comp.sEnd);
    if (!pts.length) return { ...comp, timeSec: 0 };

    const compTime = pts.length * dt;
    const speeds = pts.map((p) => p.speed);
    const throttles = pts.map((p) => p.throttle);
    const brakes = pts.map((p) => p.brake);
    const margins = pts.map((p) => p.margin);
    const latUtils = pts.map((p) => Math.abs(p.ay_g) / 1.45); // normalised by GT tyre max
    const coastPts = pts.filter((p) => p.throttle < 0.10 && p.brake < 0.10);

    return {
      id: comp.id,
      name: comp.name,
      sStart: comp.sStart,
      sEnd: comp.sEnd,
      distanceM: +(comp.sEnd - comp.sStart).toFixed(1),
      timeSec: +compTime.toFixed(3),
      entrySpeedKmh: +(speeds[0] * 3.6).toFixed(1),
      minSpeedKmh: +(Math.min(...speeds) * 3.6).toFixed(1),
      exitSpeedKmh: +(speeds[speeds.length - 1] * 3.6).toFixed(1),
      maxSpeedKmh: +(Math.max(...speeds) * 3.6).toFixed(1),
      meanThrottle: +(throttles.reduce((a, b) => a + b, 0) / throttles.length).toFixed(3),
      meanBrake: +(brakes.reduce((a, b) => a + b, 0) / brakes.length).toFixed(3),
      coastTimeSec: +(coastPts.length * dt).toFixed(3),
      avgLatUtil: +(latUtils.reduce((a, b) => a + b, 0) / latUtils.length).toFixed(3),
      minBodyMarginMeters: +Math.min(...margins).toFixed(3),
      trackingRmsMeters: +(Math.sqrt(pts.map((p) => p.q * p.q).reduce((a, b) => a + b, 0) / pts.length)).toFixed(3),
    };
  });

  return {
    numLapsRequested: numLaps,
    lapsCompleted: completedLaps.length,
    bestLapTimeSec: bestLap?.lapTimeSec ?? null,
    medianLapTimeSec: medianLap?.lapTimeSec ?? null,
    worstLapTimeSec: worstLap?.lapTimeSec ?? null,
    allLaps: completedLaps,
    flyingLapTelemetries,
    fullThrottleMetrics: {
      eligibleSec: +fullThrottleEligibleTime.toFixed(2),
      actualSec: +actualFullThrottleTime.toFixed(2),
      utilizationRatio: fullThrottleEligibleTime > 0 ? +(actualFullThrottleTime / fullThrottleEligibleTime).toFixed(4) : 1.0,
    },
    wastedCoastMetrics: {
      totalWastedCoastSec: +wastedCoastSeconds.toFixed(2),
      wastedCoastEpisodes: wastedCoastCount,
    },
    steerReversals,
    complexLossMap: complexMetrics,
    representativeTelemetryCount: repTelemetry.length,
    strictFail: ai.strictFail ?? null,
  };
}

if (process.argv[1] && process.argv[1].endsWith('nova-pace-analyzer.mjs')) {
  console.log('=== RUNNING DETERMINISTIC 5-LAP BASELINE BENCHMARK ===');
  const result = runDeterministicPaceBenchmark(5);
  console.log(`Laps completed: ${result.lapsCompleted}`);
  console.log(`Best Lap: ${result.bestLapTimeSec}s | Median: ${result.medianLapTimeSec}s | Worst: ${result.worstLapTimeSec}s`);
  console.log(`WOT Utilization: ${(result.fullThrottleMetrics.utilizationRatio * 100).toFixed(1)}%`);
  console.log(`Wasted Coast Time: ${result.wastedCoastMetrics.totalWastedCoastSec}s (${result.wastedCoastMetrics.wastedCoastEpisodes} episodes)`);

  console.log('\n--- COMPLEX LOSS MAP (RANKED BY TIME) ---');
  const sorted = [...result.complexLossMap].sort((a, b) => b.timeSec - a.timeSec);
  for (const c of sorted) {
    console.log(`  ${c.name.padEnd(16)}: ${c.timeSec.toFixed(2)}s | Spd: [${c.minSpeedKmh}-${c.maxSpeedKmh}] km/h | Thr: ${(c.meanThrottle * 100).toFixed(0)}% | Brk: ${(c.meanBrake * 100).toFixed(0)}% | Coast: ${c.coastTimeSec}s | MinMargin: ${c.minBodyMarginMeters}m`);
  }

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/nova-pace-baseline-83s.json', JSON.stringify(result, null, 2));
  console.log('\nSaved baseline report to artifacts/nova-pace-baseline-83s.json');
}
