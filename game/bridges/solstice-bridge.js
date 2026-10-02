import { SolsticeDriver } from '../../subjects/solstice/src/driver.js';
import config from '../../subjects/solstice/config.json' with { type: 'json' };

export const SOLSTICE_CANDIDATE = Object.freeze({ id: 'solstice', label: 'SOLSTICE',
  color: '#ffcf6b', stack: 'Whole-lap line → live axle forces → game-plant feedback plans → predicted traffic occupancy' });

export function createSolsticeBridge({ hostTrack, index = 0, options = {}, teamState = null }) {
  let driver = null;
  const env = globalThis.process?.env?.SOLSTICE_OPTIONS;
  const overrides = env ? JSON.parse(env) : {};
  const trackId = hostTrack.id ?? hostTrack.name;
  const layers = [config, config.tracks?.[trackId], overrides,
    overrides.tracks?.[trackId], options, options.tracks?.[trackId]].filter(Boolean);
  options = Object.assign({}, ...layers, {
    path: Object.assign({}, ...layers.map(layer => layer.path)),
    policy: Object.assign({}, ...layers.map(layer => layer.policy))
  });
  return {
    ...SOLSTICE_CANDIDATE, candidateId: 'solstice', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context) {
      try {
        driver ??= new SolsticeDriver(hostTrack, options, teamState);
        driver.update(car, cars, dt, context);
        if (!['throttle', 'brake', 'steer'].every(key => Number.isFinite(car.controls[key]))) throw new Error('Non-finite SOLSTICE controls');
      } catch (error) {
        this.errors++; this.lastError = String(error?.stack ?? error);
        car.controls = { throttle: 0, brake: .6, steer: 0 };
      }
    },
    reset(state) {
      if (state?.cars?.[index]) {
        driver ??= new SolsticeDriver(hostTrack, options, teamState);
        driver.prepare(state.cars[index]);
      }
      driver?.reset(); this.errors = 0; this.lastError = null;
    },
    debug() { return { architecture: 'SOLSTICE', intent: driver?.mode ?? 'INIT',
      targetSpeed: driver?.targetSpeed ?? 0, plan: driver?.selected ?? null,
      latency: driver?.stats.latencyMs ?? 0, stats: driver?.stats ?? null,
      traffic: driver?.traffic.stats ?? null,
      trackingPoint: driver?.trackingPoint ?? null }; },
    visualDebug() { return { trackingPoint: driver?.trackingPoint ?? hostTrack.at(hostTrack.gridS) }; },
    dispose() { driver = null; }
  };
}
