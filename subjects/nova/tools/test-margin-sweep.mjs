import { Track } from '../src/sim/track.js';
import { Session } from '../src/sim/session.js';

const dt = 1 / 120;

export function evaluateControllerConfig(config = {}, maxSeconds = 110) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt' });

  session.mode = 'practice';
  session.laps = 3;
  session.autopilot = true;
  session.aiKind = 'nova';
  session.aiOptions = {
    novaSpeedScale: 1.0,
    strict: true,
    trace: true,
    ...config,
  };
  session.start();

  const car = session.cars[0];
  session.drivers = session.cars.map((c) => session.makeDriver(c));
  const ai = session.drivers[0].ai;

  let steps = 0;
  const maxSteps = maxSeconds * 120;
  let prevLap = 0;
  const completedLaps = [];
  let minMargin = Infinity;
  let offtrackTime = 0;
  let peakBeta = 0;
  let peakYawRate = 0;

  while (steps < maxSteps && completedLaps.length < 1 && !ai.strictFail) {
    session.step(dt, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    if (car.race && car.race.lap >= 1) {
      const spd = car.speed ?? car.u ?? 0;
      const q = car.lateral;
      const margin = 8.2 - (Math.abs(q) + 0.99);
      minMargin = Math.min(minMargin, margin);
      if (margin < 0) offtrackTime += dt;

      const beta = Math.atan2(car.v ?? 0, Math.max(0.1, Math.abs(car.u ?? spd)));
      peakBeta = Math.max(peakBeta, Math.abs(beta));
      peakYawRate = Math.max(peakYawRate, Math.abs(car.yawRate ?? 0));
    }

    if (car.race && car.race.lap > prevLap) {
      const finishedLap = prevLap;
      prevLap = car.race.lap;
      if (finishedLap >= 1 && car.race.lastLap) {
        completedLaps.push({
          time: car.race.lastLap,
          valid: Boolean(car.race.valid),
        });
      }
    }
  }

  const lap = completedLaps[0];
  return {
    lapTime: lap?.time ?? null,
    valid: lap?.valid ?? false,
    minMargin: +minMargin.toFixed(3),
    offtrackTime: +offtrackTime.toFixed(3),
    peakBeta: +peakBeta.toFixed(4),
    peakYawRate: +peakYawRate.toFixed(4),
    strictFail: ai.strictFail ?? null,
  };
}

if (process.argv[1] && process.argv[1].endsWith('test-margin-sweep.mjs')) {
  console.log('Evaluating baseline...');
  const base = evaluateControllerConfig({});
  console.log(`Baseline: ${base.lapTime?.toFixed(3) ?? 'DNF'}s (valid: ${base.valid}, minMargin: ${base.minMargin}m, offtrack: ${base.offtrackTime}s)`);
}
