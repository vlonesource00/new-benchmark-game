import { RazorDriver } from '../../subjects/razor/src/driver.js';
import config from '../../subjects/razor/config.json' with { type: 'json' };
import lines from '../../subjects/apex/data/lines.json' with { type: 'json' };
import rivals from '../../subjects/apex/data/rivals.json' with { type: 'json' };

export const RAZOR_CANDIDATE = Object.freeze({ id: 'razor', label: 'RAZOR', color: '#ff6238',
  stack: 'Baked fast line → wake pursuit → committed smooth corridors → nose-only braking' });

export function createRazorBridge({ hostTrack, index = 0, options = {}, state = null }) {
  let driver = null;
  // The reused pace driver clears trim fields when asked. Clone the metadata
  // so preparing RAZOR never mutates another driver's imported line assets.
  const ownLines = Object.fromEntries(Object.entries(lines).map(([track, classes]) =>
    [track, Object.fromEntries(Object.entries(classes).map(([cls, data]) => [cls, { ...data }]))]));
  const settings = { ...config, ...(config.tracks?.[hostTrack.id] ?? {}), lines: ownLines, rivals, ...options };
  const make = () => new RazorDriver(hostTrack, settings);
  return {
    ...RAZOR_CANDIDATE, driverId: 'razor', candidateId: 'razor', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context = {}) {
      try {
        driver ??= make();
        driver.update(car, cars, dt, { ...context, state: context.state ?? state?.(car) ?? {} });
        if (!['throttle', 'brake', 'steer'].every(key => Number.isFinite(car.controls[key]))) throw new Error('Non-finite RAZOR controls');
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
    debug() { return driver?.debug() ?? { architecture: 'RAZOR', intent: 'INIT' }; },
    visualDebug() { return driver?.visualDebug() ?? { trackingPoint: hostTrack.at(hostTrack.gridS) }; },
    dispose() { driver = null; }
  };
}
