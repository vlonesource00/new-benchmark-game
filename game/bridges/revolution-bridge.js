import { RevolutionDriver } from '../../subjects/claude-revolution/src/driver.js';
import lines from '../../subjects/claude-revolution/data/lines.json' with { type: 'json' };

export const REVOLUTION_CANDIDATE = Object.freeze({ id: 'claude-revolution', label: 'CLAUDE REVOLUTION',
  color: '#d97757', stack: 'Corner opportunity map → line family → tyre budget → learnt rivals → EV-gated racecraft' });

export function createRevolutionBridge({ hostTrack, index = 0, options = {}, teamState = null }) {
  let driver = null;
  const make = () => new RevolutionDriver(hostTrack, { lines, ...options }, teamState);
  return {
    ...REVOLUTION_CANDIDATE, candidateId: 'claude-revolution', native: true, errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context) {
      try {
        driver ??= make();
        driver.update(car, cars, dt, context);
        if (!['throttle', 'brake', 'steer'].every((key) => Number.isFinite(car.controls[key]))) throw new Error('Non-finite REVOLUTION controls');
      } catch (error) {
        this.errors++; this.lastError = String(error?.stack ?? error);
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset(state) {
      driver ??= make();
      if (state?.cars?.[index]) driver.prepare(state.cars[index]);
      if (state?.line) driver.hostLine = state.line;
      driver.reset(); this.errors = 0; this.lastError = null;
    },
    debug() { return { architecture: 'CLAUDE REVOLUTION', intent: driver?.mode ?? 'INIT', targetSpeed: driver?.targetSpeed ?? 0, lapEstimate: driver?.lapEstimate ?? null, combat: driver?.racecraft?.state ?? null, lane: driver?.racecraft?.kind ?? null,
      lineSpeed: driver?.line?.v?.[driver.cursor] ?? null, cap: driver?.racecraft?.cap ?? null, reflexCap: driver?.racecraft?.reflexCap ?? null, stability: driver?.stability ?? null,
      nudge: driver?.racecraft?.nudge ?? 0, moves: driver?.racecraft?.moves ?? 0, aborts: driver?.racecraft?.aborts ?? 0, passes: driver?.racecraft?.passes ?? 0, blocker: driver?.racecraft?.blocker ?? null, cands: driver?.racecraft?.cands ?? null }; },
    visualDebug() { return null; },
    dispose() { driver = null; }
  };
}
