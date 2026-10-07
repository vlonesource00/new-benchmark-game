import { ApexDriver } from '../../subjects/apex/src/driver.js';
import config from '../../subjects/apex/config.json' with { type: 'json' };
import lines from '../../subjects/apex/data/lines.json' with { type: 'json' };
import { apexState } from './apex-state.js';

export const APEX_CANDIDATE = Object.freeze({ id: 'apex', label: 'APEX',
  color: '#00e0b8', stack: 'Identified g-g-v model → baked min-time line → slip-aware tracker → resource planner' });

export function createApexBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  const settings = { ...config, ...(config.tracks?.[hostTrack.id] ?? {}), lines, ...options };
  const make = () => new ApexDriver(hostTrack, settings);
  return {
    ...APEX_CANDIDATE, driverId: 'apex', candidateId: 'apex', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= make();
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every((key) => Number.isFinite(car.controls[key]))) throw new Error('Non-finite APEX controls');
      } catch (error) {
        this.errors++; this.lastError = String(error?.stack ?? error);
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset(snapshot) {
      driver ??= make();
      if (snapshot?.cars?.[index]) driver.prepare(snapshot.cars[index], snapshot.cars.length);
      driver.reset(); this.errors = 0; this.lastError = null;
    },
    debug() { return driver?.debug?.() ?? { architecture: 'APEX', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug?.() ?? { trackingPoint: hostTrack.at(hostTrack.gridS) }; },
    dispose() { driver = null; }
  };
}

export { apexState };
