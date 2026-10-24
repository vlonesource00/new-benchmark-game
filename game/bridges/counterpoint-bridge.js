import { CounterpointDriver } from '../../subjects/counterpoint/src/driver.js';
import { settingsFor } from '../../subjects/counterpoint/src/settings.js';
import { VanguardStrategist } from '../../subjects/vanguard-v2/src/strategy.js';
import { vanguardV2State } from './vanguard-v2-state.js';

export const counterpointState = vanguardV2State;

// Same stint baseline as V2; the experiment changes tactical decisions only.
export function installCounterpointStrategy(race, car) {
  if (!race?.entries || race.session !== 'race') return false;
  const entry = race.entryOf?.(car) ?? race.entries.find(e => e.car === car);
  const supported = d => d.kind === 'ai' && ['counterpoint', 'vanguard-v2', 'vanguard'].includes(d.id);
  if (!entry || entry.strategist instanceof VanguardStrategist ||
      !entry.team.drivers.some(d => d.id === 'counterpoint') || entry.team.drivers.some(d => d.kind === 'ai' && !supported(d)) ||
      entry.strategist.stops > 0 || entry.strategist.stintLaps > 0) return false;
  entry.strategist = new VanguardStrategist(entry.strategist, race.track.id, car.classId, race.lane);
  return true;
}

export function createCounterpointBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  const settings = settingsFor(hostTrack.id, options);
  return {
    driverId: 'counterpoint', candidateId: 'counterpoint', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= new CounterpointDriver(hostTrack, settings);
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every(k => Number.isFinite(car.controls[k]))) {
          throw new Error('Non-finite COUNTERPOINT controls');
        }
      } catch (error) {
        this.errors++;
        this.lastError = String(error.stack ?? error);
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset(snapshot) {
      driver ??= new CounterpointDriver(hostTrack, settings);
      if (snapshot?.cars?.[index]) driver.prepare(snapshot.cars[index]);
      driver.reset();
      this.errors = 0;
      this.lastError = null;
    },
    debug() { return driver?.debug() ?? { architecture: 'COUNTERPOINT', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? null; },
    controlPreview() { return driver?.path ? driver.controlPreview() : null; },
    dispose() { driver = null; }
  };
}

export function createCounterpointExecutor(track, index = 0) {
  const bridge = createCounterpointBridge({ hostTrack: track, index, options: { executor: true } });
  return {
    bridge,
    adopt(contract, car, epoch) { return bridge.driver?.adopt(contract, car, epoch) ?? false; },
    update(car, cars, dt, context) { bridge.update(car, cars, dt, context); return car.controls; },
    reset(snapshot) { bridge.reset(snapshot); },
    debug() { return bridge.debug(); },
    visualDebug() { return bridge.visualDebug(); }
  };
}
