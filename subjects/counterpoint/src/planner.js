// COUNTERPOINT planner: a handful of concrete moves (lanes around each nearby rival, following or pressing) are each
// played forward through the joint rollout and priced in metres of race: road gained, speed carried, places won or
// lost, the damage and incidents it costs, the track limits. Moves are judged against a rival that keeps its line
// and, for the best few, against one that covers; the worse of the two weighs as much as the average. Nothing is
// vetoed: a move that touches is simply priced by the damage the game's own collision gives it.
import { clamp } from '../../../game/engine/sim/math.js';
import { Rollouts } from './rollout.js';

export const VALUE = { carry: 0.8, pass: 10, loss: 12, damage: 4000, severe: 30, rub: 1.5, off: 150, offAny: 20, slide: 60, keep: 4, block: 8 };

export class Planner {
  constructor(track, book, options = {}) {
    this.track = track; this.book = book; this.o = options; this.v = { ...VALUE, ...options.value };
    this.rollouts = new Rollouts(track, book, options);
    this.last = null; this.decisions = 0;
  }
  reset() { this.last = null; }
  value(x) {
    const v = this.v;
    return x.prog + v.carry * (x.v - x.vRef) + v.pass * x.passes - v.loss * x.losses - v.damage * x.dmg - v.severe * x.severe
      - v.rub * x.rub - v.off * x.off - (x.off > 0 ? v.offAny : 0) - v.slide * x.slide - v.block * (x.block ?? 0);
  }
  /** The moves worth simulating: the line, the lane held now, and either side of each rival close enough to fight. */
  candidates(car, pilot, near) {
    const line = pilot.line, max = this.o.maxLane ?? 7, out = [], edge = this.track.halfWidth - (this.o.laneEdge ?? 0.95);
    // A lane is metres off the line; the road is where the line is not. Lanes stay on the asphalt at the car's
    // station and 40 m on, the stretch the move is driven over.
    const ahead = (pilot.hint + Math.round(40 / line.ds)) % line.n, w0 = line.w[Math.max(0, pilot.hint)], w1 = line.w[Math.max(0, ahead)];
    const lo = Math.max(-max, -edge - Math.min(w0, w1)), hi = Math.min(max, edge - Math.max(w0, w1));
    const add = (lane, key, follow) => {
      lane = clamp(lane, lo, Math.max(lo, hi));
      if (!out.some((c) => c.follow === follow && Math.abs(c.lane - lane) < 0.5)) out.push({ lane, key: `${key}${follow ? '' : '!'}`, follow });
    };
    for (const follow of [true, false]) { add(0, 'line', follow); add(pilot.lateral, 'hold', follow); }
    for (const { r, ds } of near.slice(0, this.o.fightRivals ?? 2)) {
      if (ds < -15 || ds > 60) continue;
      const e = line.locate(r.car.x, r.car.z, (pilot.hint + Math.round(ds / line.ds) + line.n) % line.n).e;
      for (const [side, w] of [['L', -2.35], ['R', 2.35], ['LL', -3.4], ['RR', 3.4]]) for (const follow of [true, false]) add(e + w, `${side}${r.id}`, follow);
    }
    return out;
  }
  plan(car, pilot, near) {
    const sims = near.filter(({ ds }) => ds > -25 && ds < 80).slice(0, this.o.simRivals ?? 3);
    const cands = this.candidates(car, pilot, near), keep = this.last?.key;
    for (const c of cands) { c.habit = this.rollouts.run(car, pilot, sims, c, 'habit'); c.score = this.value(c.habit) + (c.key === keep ? this.v.keep : 0); }
    cands.sort((a, b) => b.score - a.score);
    // The best few are also played against a rival that covers; the worse case weighs as much as the average.
    const top = cands.slice(0, this.o.robust ?? 4);
    for (const c of top) {
      c.cover = this.rollouts.run(car, pilot, sims, c, 'cover');
      const a = this.value(c.habit), b = this.value(c.cover), mean = (a + b) / 2;
      c.score = mean - 0.5 * (mean - Math.min(a, b)) + (c.key === keep ? this.v.keep : 0);
    }
    top.sort((a, b) => b.score - a.score);
    this.decisions++;
    if (this.o.record) {
      const brief = (x) => x && { p: +x.prog.toFixed(1), blk: +x.block.toFixed(2), v: +(x.v - x.vRef).toFixed(1), pass: x.passes, loss: x.losses, dmg: +(x.dmg * 100).toFixed(2), rub: x.rub, sev: x.severe, off: +x.off.toFixed(2) };
      (this.log ??= []).push({ s: +car.s.toFixed(0), v: +car.speed.toFixed(1), near: sims.map(({ r, ds }) => [r.id, +ds.toFixed(1), +(r.car.lateral - car.lateral).toFixed(1)]),
        pick: top[0].key, top: cands.slice(0, 6).map((c) => [c.key, +c.score.toFixed(1), brief(c.habit), brief(c.cover)]) });
    }
    this.last = top[0];
    this.last.cands = cands.map((c) => ({ key: c.key, lane: +c.lane.toFixed(2), score: +c.score.toFixed(1) }));
    return this.last;
  }
}
