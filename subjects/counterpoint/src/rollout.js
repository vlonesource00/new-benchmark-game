// Joint rollout: COUNTERPOINT and the rivals around it copied and driven forward together through the game's own
// physics, slipstream and collision code. Nothing about the battle is approximated by a separate model: the tow is
// the game's wake, contact is the game's impulse and damage, the road is the game's surface. Only the rivals'
// intentions are assumed, as a named hypothesis.
import { clamp, wrap } from '../../../game/engine/sim/math.js';
import { wakes, collisions } from '../../../game/engine/sim/vehicle.js';
import { cloneCar, cloneDriver, shadowTrack } from '../../oracle/src/shadow.js';
import { classifyContact } from '../../vanguard/tools/combat-metrics.mjs';
import { followCap, moveCap, relative } from './follow.js';

const COVER = 2.2, LEN = 4.56, ROOM = 2.45; // cover shift, car length, a car's width plus a little air (centre to centre)

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
   * The defence each rival would make now, as a lane shift from its habit (Map id → metres), or null if none would.
   * It is the defence the racing standard allows and INTERCEPT and ORACLE make: one move, toward the inside of the
   * next corner, made while COUNTERPOINT is still behind, and the same whatever COUNTERPOINT then does. A cover that
   * followed each move to its own side would make every side look shut, so no attack would ever look worth it.
   */
  covers(car, others) {
    const length = this.track.length, out = new Map();
    // INTERCEPT's trigger: the car behind is 6 m to max(24 m, 0.45 s) back and closing by more than 1.2 m/s, and
    // the road turns at max(55 m, 1.2 s) ahead of the defender. Closer than 6 m the move would cross the attacker's
    // nose, which neither the standard nor INTERCEPT allows; on a straight there is nothing to cover.
    for (const { r } of others) {
      const rel = relative(r.car, car, length), line = r.line, v = r.car.speed;
      if (!(rel.ds < -6 && rel.ds > -Math.max(24, v * 0.45) && Math.abs(rel.dl) < 6 && car.speed - v > 1.2)) continue;
      const k = line.k[(r.hint + Math.round(Math.max(55, v * 1.2) / line.ds)) % line.n];
      if (Math.abs(k) > 0.002) out.set(r.id, -Math.sign(k) * COVER);
    }
    return out.size ? out : null;
  }
  /**
   * Drive `plan` ({lane, follow}) for the ego under rival hypothesis `hyp` ('habit' | 'cover', the latter with the
   * `shifts` of `covers`). Returns what happened, in the planner's units (metres, seconds, damage share).
   */
  run(car, pilot, others, plan, hyp, shifts = null) {
    const o = this.o, dt = o.dt ?? 1 / 60, H = o.horizon ?? 2.4, length = this.track.length, track = this.shadow;
    const me = cloneCar(car), drv = cloneDriver(pilot); drv.isShadow = true;
    const sim = others.map(({ r }) => ({ r, car: cloneCar(r.car), drv: rivalPilot(this.book.pilotFor(r.car), r, r.car), hint: r.hint, dmg0: r.car.damage, touched: false }));
    const byId = new Map(sim.map((x) => [x.car.id, x]));
    const all = [me, ...sim.map((x) => x.car)], start = sim.map((x) => relative(me, x.car, length).ds);
    const dmg0 = me.damage, diag = { pairs: [] };
    let prog = 0, off = 0, slide = 0, severe = 0, rub = 0, hits = 0, harmOff = 0, s0 = me.s, contact = null;
    // The future as it was simulated, for the debugger: every car every 0.2 s, and where the first touch happened.
    const mark = Math.max(1, Math.round(0.2 / dt)), pts = [], rivalPts = sim.map(() => []);
    const sample = (t) => {
      pts.push({ x: me.x, z: me.z, v: me.speed, wake: me.aero?.wake ?? 0, t });
      sim.forEach((x, k) => rivalPts[k].push({ x: x.car.x, z: x.car.z, v: x.car.speed }));
    };
    sample(0);
    const edge = track.halfWidth + (track.curbWidth ?? 0), half = (car.spec?.track ?? 1.72) / 2;
    // The pilots decide every `every` physics steps and hold their pedals in between (the pilot costs four times
    // what a physics step does); the physics itself always runs at the rollout rate.
    const every = o.pilotEvery ?? 1, pdt = dt * every;
    for (let t = 0, n = 0; t < H - 1e-9; t += dt, n++) {
      if (n % every === 0) {
        drv.command = { lateral: plan.lane, cap: moveCap(me, all, length, plan), mode: plan.key, late: plan.late ?? 0 };
        drv.update(me, all, pdt, {});
        for (const x of sim) {
          const h = this.book.habit(x.r, x.car.x, x.car.z, x.hint);
          let lane = h.lane; x.hint = h.loc.i;
          const shift = shifts?.get(x.r.id);
          if (hyp === 'cover' && shift) {
            const cover = h.lane + shift;
            lane = cover;
            // Once the cars overlap, the cover may close the door but not drive into it: it leaves a car's width,
            // or what its habit would have left if that is less.
            const rel = relative(x.car, me, length);
            if (rel.ds > -LEN && rel.ds < LEN) {
              const e = x.r.line.locate(me.x, me.z, h.loc.i).e, side = Math.sign(h.loc.e - e) || 1;
              lane = side > 0 ? Math.max(cover, Math.min(h.lane, e + ROOM)) : Math.min(cover, Math.max(h.lane, e - ROOM));
            }
          }
          x.drv.command = { lateral: lane, cap: followCap(x.car, all, length), mode: hyp };
          x.drv.update(x.car, all, pdt, {});
        }
      }
      const w = wakes(all);
      for (let k = 0; k < all.length; k++) all[k].step(dt, track, w[k]);
      diag.pairs.length = 0;
      collisions(all, diag);
      for (const x of sim) { if (!x.inContact) x.hit = false; x.inContact = false; }
      for (const [a, b, closing] of diag.pairs) if (a === me.id || b === me.id) {
        const x = byId.get(a === me.id ? b : a);
        // Contact judged as the racing standard judges it: a rub is side to side, near parallel and slow to close;
        // anything else (a nose or a tail, an angle, a hard close) is a hit, counted once per touch.
        const kind = x ? classifyContact(me, x.car, closing) : { rub: false, severe: closing > 6 };
        if (kind.severe) severe++;
        if (kind.rub) rub++; else if (!x?.hit) { hits++; if (x) x.hit = true; }
        if (x) x.touched = x.inContact = true;
        if (!contact) contact = { x: (me.x + (x?.car.x ?? me.x)) / 2, z: (me.z + (x?.car.z ?? me.z)) / 2, t: +(t + dt).toFixed(2), closing: +closing.toFixed(2), id: x?.car.id ?? null };
      }
      // A rival COUNTERPOINT has touched and that is now off the road is COUNTERPOINT's doing.
      for (const x of sim) if (x.touched && Math.abs(x.car.lateral) - half > edge) harmOff += dt;
      prog += wrap(me.s - s0 + length / 2, length) - length / 2; s0 = me.s;
      if (Math.abs(me.lateral) - half > edge) off += dt;
      const beta = Math.abs(Math.atan2(me.v, Math.max(2, me.u)));
      if (beta > 0.3) slide += (beta - 0.3) * dt;
      this.steps += all.length;
      if ((n + 1) % mark === 0) sample(t + dt);
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
      dmg: 0, severe, rub, hits, off: 0, slide: 0, end: { x: me.x, z: me.z, e: loc.e }, hyp,
      pts, rivals: sim.map((x, k) => ({ id: x.car.id, pts: rivalPts[k] })), contact };
    // Value to go: the ego alone drives back to the line for `tail` seconds from where the move left it. A move
    // that ends wide and fast at the next corner is caught here, past the horizon of the fight.
    const tail = o.tail ?? 2, solo = [me];
    out.tail = [];
    for (let t = 0, n = 0; t < tail - 1e-9; t += dt, n++) {
      if (n % every === 0) { drv.command = { lateral: 0, cap: Infinity, mode: 'tail' }; drv.update(me, solo, pdt, {}); }
      me.step(dt, track, wakes(solo)[0]);
      if ((n + 1) % mark === 0) out.tail.push({ x: me.x, z: me.z, v: me.speed });
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
