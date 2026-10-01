import { VortexDriver } from '../../subjects/vortex/src/ai/vortex/vortex-driver.js';

export const VORTEX_CANDIDATE = Object.freeze({
  id: 'vortex',
  label: 'VORTEX',
  color: '#bdff64',
  stack: 'Track Oracle → Track Atlas → opponent world model → space-time trajectory game → 120 Hz servo'
});

/**
 * VORTEX drives the host natively.
 *
 * The host owns every physical state change; this bridge only forwards the
 * observation and lets the subject write `car.controls`. That is deliberately
 * the thinnest possible wrapper: sandbox:vortex:parity asserts the controls are
 * bit-identical to a standalone VortexDriver fed a structured clone of the same
 * car, so any translation layer here would show up as a parity failure.
 */
export function createVortexBridge({ line, index, aggression = 0.78, options = {} }) {
  let driver = new VortexDriver(index, line, { aggression, ...options });
  return {
    ...VORTEX_CANDIDATE,
    candidateId: 'vortex',
    driver,
    native: true,
    errors: 0,
    update(car, cars, dt, context) {
      try {
        driver.update(car, cars, dt, context);
      } catch (error) {
        this.errors += 1;
        this.lastError = error;
        car.controls = { throttle: 0, brake: 0.6, steer: 0 };
      }
    },
    reset({ line: nextLine } = {}) {
      if (nextLine) line = nextLine;
      driver = new VortexDriver(index, line, { aggression, ...options });
      this.driver = driver;
      this.errors = 0;
      this.lastError = null;
    },
    debug() {
      return {
        architecture: 'VORTEX',
        state: driver.state,
        planSource: 'Track Atlas + multi-corner space-time trajectory game',
        controllerCadence: '120 Hz servo / 60 Hz dynamics / 27 Hz trajectory game / 30 Hz world model',
        selectedPlan: driver.plan?.id ?? null,
        targetSpeed: driver.targetSpeed,
        usingOracle: driver.atlas?.usingOracle ?? false,
        oracleLapTime: driver.atlas?.oracle?.lapTime ?? null,
        envelope: driver.envelope?.state ?? null,
        telemetry: driver.telemetry?.telemetry ?? null
      };
    },
    visualDebug() {
      const trajectory = driver.selectedTrajectory;
      const aim = driver.aim;
      return {
        selectedTrajectory: trajectory ? {
          id: trajectory.id,
          points: (trajectory.points ?? []).map((point) => ({ x: point.x, y: point.y ?? 0, z: point.z })),
          color: VORTEX_CANDIDATE.color,
          mode: driver.state
        } : null,
        trackingPoint: aim ? { x: aim.x, y: aim.y ?? 0, z: aim.z } : null
      };
    }
  };
}
