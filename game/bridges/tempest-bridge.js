import { TempestDriver } from '../../subjects/tempest/src/driver.js';
import config from '../../subjects/tempest/config.json' with { type: 'json' };
import lines from '../../subjects/apex/data/lines.json' with { type: 'json' };

export const TEMPEST_CANDIDATE = Object.freeze({ id: 'tempest', label: 'TEMPEST', color: '#3ad6ff',
  stack: 'Road-frame perception → rival forecasts → space-time lattice (outcome, wake, water) → committed lane → controller' });

export function createTempestBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  // Clone the line metadata so preparing TEMPEST never mutates another driver's imported line assets.
  const ownLines = Object.fromEntries(Object.entries(lines).map(([track, classes]) =>
    [track, Object.fromEntries(Object.entries(classes).map(([cls, data]) => [cls, { ...data }]))]));
  const settings = { ...config, ...(config.tracks?.[hostTrack.id] ?? {}), lines: ownLines, ...options };
  const make = () => new TempestDriver(hostTrack, settings);
  return {
    ...TEMPEST_CANDIDATE, driverId: 'tempest', candidateId: 'tempest', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= make();
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every(key => Number.isFinite(car.controls[key]))) throw new Error('Non-finite TEMPEST controls');
      } catch (error) {
        this.errors++; this.lastError = String(error?.stack ?? error);
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset(snapshot) {
      driver ??= make();
      if (snapshot?.cars?.[index]) driver.prepare(snapshot.cars[index]);
      driver.reset(); this.errors = 0; this.lastError = null;
    },
    debug() { return driver?.debug() ?? { architecture: 'TEMPEST', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? { trackingPoint: hostTrack.at(hostTrack.gridS) }; },
    dispose() { driver = null; }
  };
}
