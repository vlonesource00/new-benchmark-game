import { VanguardDriver } from '../../subjects/vanguard-v2/src/driver.js';
import { settingsFor } from '../../subjects/vanguard-v2/src/settings.js';
import { vanguardV2State } from './vanguard-v2-state.js';

export function createVanguardV2Bridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  const settings = settingsFor(hostTrack.id, options);
  return {
    driverId: 'vanguard-v2',
    candidateId: 'vanguard-v2',
    native: true,
    errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= new VanguardDriver(hostTrack, settings);
        driver.lastCar = car;
        driver.contextEpoch = context.epoch ?? 0;
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every(k => Number.isFinite(car.controls[k]))) {
          throw new Error('Non-finite VANGUARD v2 controls');
        }
      } catch (e) {
        this.errors++;
        this.lastError = String(e.stack ?? e);
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset(snapshot) {
      driver ??= new VanguardDriver(hostTrack, settings);
      if (snapshot?.cars?.[index]) driver.prepare(snapshot.cars[index]);
      driver.reset();
      this.errors = 0;
    },
    debug() { return driver?.debug() ?? { architecture: 'VANGUARD v2', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? null; },
    controlPreview() { return driver?.path ? driver.controlPreview() : null; },
    dispose() { driver = null; }
  };
}

/** 120 Hz host-side executor: authoritative current pose at physics rate with asynchronous worker plans. */
export function createVanguardV2Executor(track, index = 0) {
  const bridge = createVanguardV2Bridge({ hostTrack: track, index, options: { executor: true } });
  return {
    bridge,
    adopt(contract, car, epoch) {
      bridge.driver?.prepare(car);
      return bridge.driver?.adopt(contract, car, epoch) ?? false;
    },
    update(car, cars, dt, context) {
      bridge.update(car, cars, dt, context);
      return car.controls;
    },
    reset(snapshot) { bridge.reset(snapshot); },
    debug() { return bridge.debug(); },
    visualDebug() { return bridge.visualDebug(); }
  };
}

export { vanguardV2State };
