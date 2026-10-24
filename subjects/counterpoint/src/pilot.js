// COUNTERPOINT pilot: drives a commanded lane (metres right of the racing line) at the line's speed profile, under
// an optional speed cap. It is ORACLE's tuned path-and-pedal controller with ORACLE's own racecraft taken out: what to
// do is never decided here, only how to drive it. The same pilot drives the car live and every copy of it inside the
// planner's rollouts, so a plan is executed exactly as it was simulated.
import { OracleDriver } from '../../oracle/src/driver.js';

export class Pilot extends OracleDriver {
  constructor(track, options = {}) {
    // The self-check governor is off: it vetoes lanes on its own solo forecast, which is the planner's job, and
    // measured solo laps are identical without it (Harbor GT3 60.94 / 61.31 / 62.18 s either way).
    super(track, { guard: false, poseInit: true, ...options });
    this.command = { lateral: 0, cap: Infinity, mode: 'PACE' };
  }
  update(car, cars, dt, context = {}) {
    const c = this.command;
    this.combat = { update: () => ({ lateral: c.lateral, cap: c.cap, mode: c.mode }), reset() {} };
    return super.update(car, cars, dt, { ...context, mode: 'race' });
  }
}
