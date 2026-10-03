import { GeminiV4Driver } from '../../subjects/gemini-supreme/src/ai/v4/driver.js';

export const GEMINI_V4_CANDIDATE = Object.freeze({
  id: 'gemini-supreme-v4',
  label: 'Gemini Supreme v4',
  color: '#3ad1ff',
  stack: 'Min-time line on the host track → tyre-aware g-g-v speed profile → Frenet traffic gaps → lag-compensated tracker'
});

/**
 * Gemini Supreme v4 drives the host natively: the bridge forwards the
 * observation (own car, other cars' poses, track) and the driver writes
 * `car.controls`. v3 keeps its shadow-world bridge for comparison.
 */
export function createGeminiV4Bridge({ hostTrack, index, options = {} }) {
  let driver = null;
  // Headless tuning hook: GEMINI_V4_OPTS='{"kc":1.0}' overrides defaults.
  const env = typeof process !== 'undefined' && process.env?.GEMINI_V4_OPTS;
  if (env) options = { ...JSON.parse(env), ...options };
  return {
    ...GEMINI_V4_CANDIDATE,
    candidateId: GEMINI_V4_CANDIDATE.id,
    native: true,
    errors: 0,
    get driver() { return driver; },
    update(car, cars, dt, context) {
      try {
        driver ??= new GeminiV4Driver({ track: hostTrack, car, options });
        driver.update(car, cars, dt, context);
      } catch (error) {
        this.errors += 1;
        this.lastError = error;
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    // Built on reset, not on the first update: the first build of the race plan
    // takes seconds, and a seat worker's first update comes at the rolling-start
    // handover, so the car would hold the pace-car pilot's controls into green.
    reset(state) {
      const car = state?.cars?.[index];
      driver = car?.spec ? new GeminiV4Driver({ track: hostTrack, car, options }) : null;
      this.errors = 0;
      this.lastError = null;
    },
    debug() {
      return {
        architecture: 'Gemini Supreme v4',
        planSource: 'Offline min-time line + tyre-aware g-g-v profile',
        controllerCadence: '120 Hz tracker / 2 Hz profile replan',
        intent: driver?.traffic?.intent ?? null,
        stats: driver?.dbg ?? null
      };
    },
    visualDebug() {
      return null;
    }
  };
}
