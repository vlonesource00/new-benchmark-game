import { AdaptiveDriver } from '../../subjects/astra/src/sim/controller.js';

export const ASTRA_CANDIDATE = Object.freeze({
  id: 'astra',
  label: 'Astra',
  color: '#df482d',
  stack: 'RaceStrategy → TacticalPlanner → dynamic chassis rollouts → AdaptiveDriver'
});

/**
 * Astra drives the host natively: the shared physics, track and racing line are
 * its own, so this bridge is a thin uniform-interface wrapper with no state
 * translation at all. That is the point of making Astra the host engine.
 */
export function createAstraBridge({ line, index, aggression = 0.72, skill = 0.956 }) {
  const driver = new AdaptiveDriver(index, line, skill, aggression);
  return {
    ...ASTRA_CANDIDATE,
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
    reset({ line: nextLine }) {
      if (nextLine) driver.line = nextLine;
      driver.planner.plan = null;
      driver.planner.sequence = null;
      driver.planner.commit = 0;
      driver.planner.targetId = null;
      driver.planner.intent = 'PACE';
      driver.wasRecovering = false;
      driver.reverseTimer = 0;
      this.errors = 0;
      this.lastError = null;
    },
    debug() {
      const stats = driver.planner?.stats ?? {};
      return {
        architecture: 'Astra',
        state: driver.state,
        intent: driver.planner?.intent,
        planSource: 'native TacticalPlanner (host line + live friction envelope)',
        controllerCadence: '80 ms tactical / 40 ms control search on 120 Hz physics',
        targetSpeed: driver.targetSpeed,
        ...stats
      };
    },
    visualDebug() {
      // Expose genuine existing read-only trajectory data without fabricating candidate trees
      const targetPoint = driver.aim;
      return {
        selectedTrajectory: driver.line ? {
          points: [], // Astra uses pure pursuit on global line rather than an explicit discretized polyline
          color: '#df482d',
          mode: driver.planner?.intent ?? 'PACE'
        } : null,
        trackingPoint: targetPoint ? { x: targetPoint.x, y: targetPoint.y ?? 0, z: targetPoint.z } : null
      };
    }
  };
}
