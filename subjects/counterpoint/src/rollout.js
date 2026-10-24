// Joint rollout: COUNTERPOINT and the rivals around it copied and driven forward together through the game's own
// physics, slipstream and collision code. Nothing about the battle is approximated by a separate model: the tow is
// the game's wake, contact is the game's impulse and damage, the road is the game's surface. Only the rivals'
// intentions are assumed, as a named hypothesis.
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { wakes, collisions } from '../../../game/engine/sim/vehicle.js';
import { cloneCar, cloneDriver, shadowTrack } from '../../oracle/src/shadow.js';
import { followCap, relative } from './follow.js';

const COVER = 2.2;

/** A rival pilot copy put into the rival car's current state (lane, pedals, station), at its learnt pace. */
function rivalPilot(proto, r, car) {
  const d = cloneDriver(proto, { pace: r.ratio });
  d.isShadow = true; d.reset();
  d.hint = r.hint; d.lateral = r.e; d.thr = car.controls?.throttle ?? 0; d.brk = car.controls?.brake ?? 0;
  d.wakeSm = car.aero?.wake ?? 0;
  return d;
}

export class Rollouts {
  constructor(track, book, options = {}) {
    this.track = track; this.shadow = shadowTrack(track); this.book = book; this.o = options;
    this.count = 0; this.steps = 0;
  }
  /**
   * Drive `plan` ({lane, follow}) for the ego under rival hypothesis `hyp` ('habit' | 'cover').
   * Returns what happened, in the planner's units (metres, seconds, damage share).
   */
  run(car, pilot, others, plan, hyp) {
    const o = this.o, dt = o.dt ?? 1 / 60, H = o.horizon ?? 2.4, length = this.track.length, track = this.shadow;
    const me = cloneCar(car), drv = cloneDriver(pilot); drv.isShadow = true;
    const sim = others.map(({ r }) => ({ r, car: cloneCar(r.car), drv: rivalPilot(this.book.pilotFor(r.car), r, r.car), hint: r.hint, dmg0: r.car.damage, touched: false }));
    const byId = new Map(sim.map((x) => [x.car.id, x]));
    const all = [me, ...sim.map((x) => x.car)], start = sim.map((x) => relative(me, x.car, length).ds);
    const dmg0 = me.damage, diag = { pairs: [] };
    let prog = 0, off = 0, slide = 0, severe = 0, rub = 0, harmOff = 0, s0 = me.s;
    const edge = track.halfWidth + (track.curbWidth ?? 0), half = (car.spec?.track ?? 1.72) / 2;
    // The pilots decide every `every` physics steps and hold their pedals in between (the pilot costs four times
    // what a physics step does); the physics itself always runs at the rollout rate.
    const every = o.pilotEvery ?? 1, pdt = dt * every;
    for (let t = 0, n = 0; t < H - 1e-9; t += dt, n++) {
      if (n % every === 0) {
        drv.command = { lateral: plan.lane, cap: plan.follow ? followCap(me, all, length) : Infinity, mode: plan.key };
        drv.update(me, all, pdt, {});
        for (const x of sim) {
          const h = this.book.habit(x.r, x.car.x, x.car.z, x.hint);
          let lane = h.lane; x.hint = h.loc.i;
          if (hyp === 'cover') {
            // Defence: a rival with COUNTERPOINT close behind it moves over toward COUNTERPOINT's side, a car's width at most.
            const rel = relative(x.car, me, length);
            if (rel.ds < 2 && rel.ds > -25 && Math.abs(rel.dl) < 6) lane = h.lane + clamp(x.r.line.locate(me.x, me.z, h.loc.i).e - h.lane, -COVER, COVER);
          }
          x.drv.command = { lateral: lane, cap: followCap(x.car, all, length), mode: hyp };
          x.drv.update(x.car, all, pdt, {});
        }
      }
      const w = wakes(all);
      for (let k = 0; k < all.length; k++) all[k].step(dt, track, w[k]);
      diag.pairs.length = 0;
      collisions(all, diag);
      for (const [a, b, closing] of diag.pairs) if (a === me.id || b === me.id) {
        if (closing > 6) severe++; else rub++;
        const x = byId.get(a === me.id ? b : a); if (x) x.touched = true;
      }
      // A rival COUNTERPOINT has touched and that is now off the road is COUNTERPOINT's doing.
      for (const x of sim) if (x.touched && Math.abs(x.car.lateral) - half > edge) harmOff += dt;
      prog += wrap(me.s - s0 + length / 2, length) - length / 2; s0 = me.s;
      if (Math.abs(me.lateral) - half > edge) off += dt;
      const beta = Math.abs(Math.atan2(me.v, Math.max(2, me.u)));
      if (beta > 0.3) slide += (beta - 0.3) * dt;
      this.steps += all.length;
    }
    this.count++;
    const line = pilot.line, loc = line.locate(me.x, me.z, drv.hint);
    let passes = 0, losses = 0, block = 0;
    const pace = this.book.rivals.get(car.id)?.ratio ?? pilot.options.pace ?? 1;
    sim.forEach((x, k) => {
      const { ds: end, dl } = relative(me, x.car, length);
      if (start[k] > 0 && end < -1) passes++;
      if (start[k] < 0 && end > 1) losses++;
      // Still boxed in behind a slower car when the horizon ends: the road it will keep costing (m/s), which the
      // horizon itself cannot see. A move that ends alongside or ahead has escaped it.
      if (end > 0 && end < 25 && Math.abs(dl) < 2.15) block = Math.max(block, Math.max(0, pace - x.r.ratio) * me.speed);
    });
    const out = { prog, v: me.speed, vRef: line.sample(line.vb, loc.i, loc.f) * (pilot.options.pace ?? 1), passes, losses, block,
      dmg: 0, severe, rub, off: 0, slide: 0, end: { x: me.x, z: me.z, e: loc.e } };
    // Value to go: the ego alone drives back to the line for `tail` seconds from where the move left it. A move
    // that ends wide and fast at the next corner is caught here, past the horizon of the fight.
    const tail = o.tail ?? 2, solo = [me];
    for (let t = 0, n = 0; t < tail - 1e-9; t += dt, n++) {
      if (n % every === 0) { drv.command = { lateral: 0, cap: Infinity, mode: 'tail' }; drv.update(me, solo, pdt, {}); }
      me.step(dt, track, wakes(solo)[0]);
      if (Math.abs(me.lateral) - half > edge) off += dt;
      const beta = Math.abs(Math.atan2(me.v, Math.max(2, me.u)));
      if (beta > 0.3) slide += (beta - 0.3) * dt;
      this.steps++;
    }
    out.dmg = me.damage - dmg0; out.off = off; out.slide = slide; out.harmOff = harmOff;
    out.harm = sim.reduce((h, x) => h + (x.touched ? x.car.damage - x.dmg0 : 0), 0);
    return out;
  }
}
