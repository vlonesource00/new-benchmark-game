// COUNTERPOINT pilot: drives a commanded lane (metres right of the racing line) at the line's speed profile, under
// an optional speed cap. It is ORACLE's tuned path-and-pedal controller with ORACLE's own racecraft taken out: what to
// do is never decided here, only how to drive it. The same pilot drives the car live and every copy of it inside the
// planner's rollouts, so a plan is executed exactly as it was simulated.
import { OracleDriver } from '../../oracle/src/driver.js';
import { cloneCar, cloneDriver, shadowTrack } from '../../oracle/src/shadow.js';

export class Pilot extends OracleDriver {
  constructor(track, options = {}) {
    super(track, { poseInit: true, ...options });
    this.command = { lateral: 0, cap: Infinity, mode: 'PACE' };
  }
  update(car, cars, dt, context = {}) {
    const c = this.command;
    this.combat = { update: () => ({ lateral: c.lateral, cap: c.cap, mode: c.mode }), reset() {} };
    return super.update(car, cars, dt, { ...context, mode: 'race' });
  }
  /**
   * The pace half of ORACLE's self-check: when the car's own copy, driving the commanded lane, slides or runs past
   * the kerb over the next seconds, the pace comes down until a clean future exists, and creeps back while it is
   * clean. Which lane to drive is the planner's call (its rollouts price that lane's slide and road), so the lane
   * half, refusing a lane the copy cannot drive, is left out.
   */
  govern(car) {
    const o = this.options, step = o.guardStep ?? 0.03, lo = o.guardLo ?? 0.85, lane = this.laneHold ?? 0;
    this.veto = null;
    const now = this.rollout(car, this.gp, lane);
    if (now === 0) { const up = Math.min(1, this.gp + (o.guardUp ?? 0.01)); if (up > this.gp && this.rollout(car, up, lane) === 0) this.gp = up; return; }
    let best = this.gp, bestBad = now;
    for (let p = this.gp - step; p >= lo - 1e-9; p -= step) {
      const bad = this.rollout(car, p, lane);
      if (bad < bestBad - 1e-6) { best = p; bestBad = bad; }
      if (bad === 0) break;
    }
    this.gp = best;
  }
  /**
   * ORACLE's self-check copy, driving what the car is really driving: the commanded lane under the commanded cap. A
   * copy that ignored the cap judged a passing lane at full race pace while the car sat behind a slower one under its
   * follow limit, and cut the pace for a slide that was never coming.
   */
  rollout(car, gp, lane) {
    const o = this.options, c = cloneCar(car), d = cloneDriver(this);
    d.isShadow = true; d.gp = gp; d.command = { lateral: lane, cap: this.command.cap, mode: 'GUARD' };
    this.shadowTrack ??= shadowTrack(this.track);
    const dt = 1 / 120, H = o.guardH ?? 2.2, edge = this.track.halfWidth + this.track.curbWidth * (o.guardKerb ?? 0.5), bmax = o.guardB ?? 0.3;
    let bad = 0;
    for (let t = 0, n = 0; t < H; t += dt, n++) {
      d.update(c, [c], dt, {}); c.step(dt, this.shadowTrack);
      const b = Math.abs(Math.atan2(c.v, Math.max(2, c.u)));
      if (b > bmax) bad += (b - bmax) * dt;
      if (b > 0.7) return bad + 1 + (H - t);
      const drift = Math.abs(d.trace?.err ?? 0) - (o.guardErr ?? 4);
      if (drift > 0) bad += drift * (o.guardErrCost ?? 0.04) * dt;
      if (n % 6 === 0) { const l = Math.abs(this.track.nearest(c.x, c.z).lateral) - edge; if (l > 0) bad += (0.05 + l) * dt * 6; }
    }
    return bad;
  }
}
