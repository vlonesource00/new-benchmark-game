import { PhantomDriver } from '../../subjects/phantom-v2/src/phantom-driver.js';
import { Ghost, seedGhost } from '../../subjects/phantom-v2/src/ghost.js';
import { GHOST } from '../../subjects/phantom/src/ghost-data.js';

export const PHANTOM_V2_CANDIDATE = Object.freeze({
  id: 'phantom-v2',
  label: 'PHANTOM v2',
  color: '#b44cff',
  stack: 'Opponent-learned field + closing-speed combat gate → ghost-tape value clock → exact-plant shadow rollouts → control-knot MPPI with occupancy and tyre shadow prices'
});

/**
 * PHANTOM drives the host natively, like VORTEX: the bridge forwards the
 * observation and the subject writes `car.controls`. The only setup is the
 * ghost tape, which is calibrated against the car it will drive on first use.
 */
export function createPhantomV2Bridge({ hostTrack, index, options = {} }) {
  let driver = null;
  // Headless tuning hook: PHANTOM_V2_OPTS='{"margin0":0.5}' overrides defaults.
  const env = typeof process !== 'undefined' && process.env?.PHANTOM_V2_OPTS;
  if (env) options = { ...JSON.parse(env), ...options };
  const build = (car) => {
    const ghost = GHOST && Math.abs(GHOST.length - hostTrack.length) < 1e-6 ? new Ghost(GHOST) : seedGhost(hostTrack);
    ghost.calibrate(hostTrack, car);
    ghost.buildEnvelope();
    return new PhantomDriver({ track: hostTrack, ghost, options });
  };
  return {
    ...PHANTOM_V2_CANDIDATE,
    candidateId: 'phantom-v2',
    native: true,
    errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context) {
      try {
        driver ??= build(car);
        driver.update(car, cars, dt, context);
      } catch (error) {
        this.errors += 1;
        this.lastError = error;
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset() {
      driver = null;
      this.errors = 0;
      this.lastError = null;
    },
    debug() {
      return {
        architecture: 'PHANTOM v2',
        planSource: 'Ghost-tape value + exact-plant MPPI rollouts',
        controllerCadence: '15 Hz plan / 120 Hz playback',
        intent: driver?.mode ?? null,
        stats: driver?.planner?.stats ?? null
      };
    },
    visualDebug() {
      return null;
    }
  };
}
