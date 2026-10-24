import { CounterpointDriver } from '../../subjects/counterpoint/src/driver.js';
import { InterceptStrategist } from '../../subjects/intercept/src/strategy.js';
import { oracleState } from './oracle-state.js';

export const counterpointState = oracleState;

// Same stint model as ORACLE (INTERCEPT's strategist), so a race against ORACLE differs in racecraft only.
export function installCounterpointStrategy(race, car) {
  if (!race?.entries || race.session !== 'race') return false;
  const e = race.entryOf?.(car) ?? race.entries.find((x) => x.car === car);
  if (!e || e.strategist instanceof InterceptStrategist || !e.team.drivers.some((d) => d.kind === 'ai' && d.id === 'counterpoint')) return false;
  if (e.team.drivers.some((d) => d.kind === 'ai' && d.id !== 'counterpoint')) return false;
  if (e.strategist.stops > 0 || e.strategist.stintLaps > 0) return false;
  e.strategist = new InterceptStrategist(e.strategist, race.track.id, car.classId, race.lane);
  return true;
}

/** COUNTERPOINT runs on the main thread at physics rate (no seat worker): its rollouts start from the live field. */
export function createCounterpointBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  return {
    driverId: 'counterpoint', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= new CounterpointDriver(hostTrack, options);
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every((k) => Number.isFinite(car.controls[k]))) throw new Error('Non-finite COUNTERPOINT controls');
      } catch (e) { this.errors++; this.lastError = String(e.stack ?? e); car.controls = { throttle: 0, brake: 0.6, steer: 0 }; }
    },
    reset() { driver?.reset(); this.errors = 0; },
    debug() { return driver?.debug() ?? { architecture: 'COUNTERPOINT', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? null; },
    dispose() { driver = null; }
  };
}
