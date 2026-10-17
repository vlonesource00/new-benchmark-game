import { OracleDriver } from '../../subjects/oracle/src/driver.js';

/** ORACLE runs on the main thread at physics rate (no seat worker): every call sees the live field. */
export function createOracleBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  return {
    driverId: 'oracle', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= new OracleDriver(hostTrack, options);
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every((k) => Number.isFinite(car.controls[k]))) throw new Error('Non-finite ORACLE controls');
      } catch (e) { this.errors++; this.lastError = String(e.stack ?? e); car.controls = { throttle: 0, brake: 0.6, steer: 0 }; }
    },
    reset() { driver?.reset(); this.errors = 0; },
    debug() { return driver?.debug() ?? { architecture: 'ORACLE', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? null; },
    dispose() { driver = null; }
  };
}
