// PHANTOM driver: plans at a fixed rate on exact-plant rollouts and plays the
// chosen control sequence back at the simulation rate between plans.

import { Planner } from './sampler.js';
import { OpponentField } from './field.js';

const wrap = (x, n) => ((x % n) + n) % n;

export class PhantomDriver {
  constructor({ track, ghost, planHz = 15, options = {} }) {
    this.track = track; this.ghost = ghost; this.planHz = planHz; this.options = options;
    this.field = new OpponentField(track, ghost, options);
    this.planner = null; this.nextPlan = -Infinity; this.mode = 'free';
    this.stuckSince = null; this.recoverUntil = -Infinity;
  }

  reset() { this.planner = null; this.nextPlan = -Infinity; this.stuckSince = null; this.recoverUntil = -Infinity; }

  // Beached, or parked facing the wrong way: back up while turning the nose
  // toward the direction of travel, then hand back to the planner.
  recover(car, now) {
    const p = this.track.at(car.s);
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const err = Math.atan2(fx * p.nx + fz * p.nz, fx * p.tx + fz * p.tz);
    // Reversing swings the nose the opposite way from forward steering.
    car.controls = { throttle: 0.55, brake: 0, steer: Math.max(-1, Math.min(1, err * 2)), reverse: true };
    if (now >= this.recoverUntil) { this.stuckSince = null; this.nextPlan = -Infinity; this.planner.hasPlan = false; }
  }

  update(car, cars, dt, context = {}) {
    const now = context.time ?? 0;
    if (!this.planner) this.planner = new Planner(this.track, car, this.ghost, this.field, this.options);
    if (now < this.recoverUntil) return this.recover(car, now);
    if (car.speed < 1.5 && this.planner.hasPlan) {
      this.stuckSince ??= now;
      if (now - this.stuckSince > 1.2) { this.recoverUntil = now + 1.6; return this.recover(car, now); }
    } else this.stuckSince = null;
    if (now >= this.nextPlan - 1e-9) {
      const L = this.track.length, o = this.options;
      const catchTime = o.catchTime ?? 2.5, closeGap = o.closeGap ?? 18, gateMaxNear = o.gateMaxNear ?? 1;
      let near = 0, engaged = 0, behind = false;
      this.field.observe(car, cars);
      for (const other of cars) {
        if (other === car) continue;
        const ds = wrap(other.s - car.s + L / 2, L) - L / 2;
        if (ds > -30 && ds < 120) near++;
      }
      // In a pack (the start, a train) every car stays in combat as in v1;
      // the gate only relaxes a one-on-one.
      const gate = (o.gate ?? true) && near <= gateMaxNear;
      for (const other of cars) {
        if (other === car) continue;
        const ds = wrap(other.s - car.s + L / 2, L) - L / 2;
        if (!(ds > -30 && ds < 120)) continue;
        // v2: a rival only puts the car in combat when it is alongside or
        // about to be: close, or closing fast enough to meet it within the
        // catch time. A car pulling away up the road is left to the field's
        // occupancy and following cap, and PHANTOM keeps its own line.
        const closing = ds > 0 ? car.speed - other.speed : other.speed - car.speed;
        const gap = Math.abs(ds) - 2 * 2.28;
        const meets = Math.abs(ds) < closeGap || (closing > 0.5 && gap / closing < catchTime);
        if (!gate || meets) {
          engaged++;
          if (ds > -30 && ds < -2) behind = true;
        }
      }
      this.field.predict(car, near ? cars : [car], this.planner.times, now);
      this.mode = !engaged ? (near ? 'shadow' : 'free') : behind ? 'defend' : 'attack';
      this.planner.plan(car, now, { defend: behind, combat: engaged > 0 });
      this.nextPlan = now + 1 / this.planHz;
    }
    const { steer, pedal } = this.planner.controlAt(now - this.planner.planTime);
    car.controls = { throttle: pedal > 0 ? pedal : 0, brake: pedal < 0 ? -pedal : 0, steer: this.planner.stabilise(car, steer) };
  }
}
