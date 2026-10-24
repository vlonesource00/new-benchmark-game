// COUNTERPOINT planner: a handful of concrete moves (lanes around each nearby rival, following or pressing) are each
// played forward through the joint rollout and priced in metres of race: road gained, speed carried, places won or
// lost, the damage and incidents it costs, the track limits. Moves are judged against a rival that keeps its line
// and, for the best few, against one that covers; the worse of the two weighs as much as the average. Nothing is
// vetoed: a move that touches is simply priced by the damage the game's own collision gives it.
import { clamp } from '../../../game/engine/sim/math.js';
import { Rollouts } from './rollout.js';

export const VALUE = { carry: 0.8, pass: 10, loss: 12, damage: 4000, severe: 30, rub: 1.5, off: 150, offAny: 20, slide: 60, keep: 15, block: 8, harm: 1 };

export class Planner {
  constructor(track, book, options = {}) {
    this.track = track; this.book = book; this.o = options; this.v = { ...VALUE, ...options.value };
    this.rollouts = new Rollouts(track, book, options);
    this.last = null; this.decisions = 0;
  }
  reset() { this.last = null; }
  /** A rollout priced term by term, in metres of race (the debugger shows these; `value` is their sum). */
  terms(x) {
    const v = this.v;
    return { road: x.prog, speed: v.carry * (x.v - x.vRef), passes: v.pass * x.passes, losses: -v.loss * x.losses,
      damage: -v.damage * x.dmg - v.severe * x.severe, rubs: -v.rub * x.rub, off: -v.off * x.off - (x.off > 0 ? v.offAny : 0),
      slide: -v.slide * x.slide, boxed: -v.block * (x.block ?? 0),
      // The damage and the off-road a move causes a rival it touches cost what they would cost COUNTERPOINT itself.
      harm: -v.harm * (v.damage * (x.harm ?? 0) + v.off * (x.harmOff ?? 0)) };
  }
  value(x) { let s = 0; for (const t of Object.values(this.terms(x))) s += t; return s; }
  /** The moves worth simulating: the line, the lane held now, and either side of each rival close enough to fight. */
  candidates(car, pilot, near) {
    const line = pilot.line, max = this.o.maxLane ?? 7, out = [], edge = this.track.halfWidth - (this.o.laneEdge ?? 0.95);
    // A lane is metres off the line; the road is where the line is not. Lanes stay on the asphalt at the car's
    // station and 40 m on, the stretch the move is driven over.
    const at = line.locate(car.x, car.z, pilot.hint).i, ahead = (at + Math.round(40 / line.ds)) % line.n, w0 = line.w[at], w1 = line.w[ahead];
    // The racing line itself is always allowed: it runs near the edge in places, and a clamp past it would push every
    // move, the line included, into a car alongside on the other side.
    const lo = Math.min(0, Math.max(-max, -edge - Math.min(w0, w1))), hi = Math.max(0, Math.min(max, edge - Math.max(w0, w1)));
    const add = (lane, key, follow) => {
      lane = clamp(lane, lo, Math.max(lo, hi));
      if (!out.some((c) => c.follow === follow && Math.abs(c.lane - lane) < 0.5)) out.push({ lane, key: `${key}${follow ? '' : '!'}`, follow });
    };
    for (const follow of [true, false]) { add(0, 'line', follow); add(pilot.lateral, 'hold', follow); }
    for (const { r, ds } of near.slice(0, this.o.fightRivals ?? 2)) {
      if (ds < -15 || ds > 60) continue;
      const e = line.locate(r.car.x, r.car.z, (at + Math.round(ds / line.ds) + line.n) % line.n).e;
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
    this.ranked = [...top, ...cands.slice(top.length)]; this.keepKey = keep;
    this.nearBrief = sims.map(({ r, ds }) => ({ id: r.id, ds: +ds.toFixed(1), dl: +(r.car.lateral - car.lateral).toFixed(1) }));
    if (this.o.record) {
      const brief = (x) => x && { p: +x.prog.toFixed(1), blk: +x.block.toFixed(2), v: +(x.v - x.vRef).toFixed(1), pass: x.passes, loss: x.losses, dmg: +(x.dmg * 100).toFixed(2), rub: x.rub, sev: x.severe, off: +x.off.toFixed(2), harm: +((x.harm ?? 0) * 100).toFixed(2), hOff: +(x.harmOff ?? 0).toFixed(2) };
      (this.log ??= []).push({ s: +car.s.toFixed(0), v: +car.speed.toFixed(1), near: sims.map(({ r, ds }) => [r.id, +ds.toFixed(1), +(r.car.lateral - car.lateral).toFixed(1)]),
        pick: top[0].key, top: cands.slice(0, 6).map((c) => [c.key, +c.score.toFixed(1), brief(c.habit), brief(c.cover)]) });
    }
    this.last = top[0];
    this.last.cands = cands.map((c) => ({ key: c.key, lane: +c.lane.toFixed(2), follow: c.follow, score: +c.score.toFixed(1),
      habit: +this.value(c.habit).toFixed(1), worst: c.cover ? +this.value(c.cover).toFixed(1) : null, hyp: c.cover?.hyp ?? null }));
    return this.last;
  }
  /**
   * What the debugger is shown of a plan: every move's simulated path and price, and for the chosen one its rivals'
   * futures under the habit and the worst hypothesis, the first contact either foresaw and its value term by term
   * next to the runner-up's. Plain data: it crosses from the planning worker as it is.
   */
  explain(m) {
    const r1 = (x) => Math.round(x * 10) / 10, pts = (P) => P.map((p) => ({ x: r1(p.x), z: r1(p.z), v: r1(p.v), wake: p.wake == null ? undefined : +p.wake.toFixed(2) }));
    // The score is the habit's terms plus what the worst case took off and the bonus for keeping the last move.
    const terms = (x, c) => {
      if (!x) return null;
      const t = Object.fromEntries(Object.entries(this.terms(x)).map(([k, v]) => [k, r1(v)]));
      if (c) { t.keep = c.key === this.keepKey ? this.v.keep : 0; t.worst = r1(c.score - this.value(x) - t.keep); }
      return t;
    };
    const second = this.ranked?.find((c) => c !== m);
    return { key: m.key, lane: m.lane, follow: m.follow, score: m.score, near: this.nearBrief,
      options: this.ranked.map((c) => ({ key: c.key, score: r1(c.score), habit: r1(this.value(c.habit)), worst: c.cover ? r1(this.value(c.cover)) : null, pts: pts(c.habit.pts) })),
      habit: { pts: pts(m.habit.pts), tail: pts(m.habit.tail), rivals: m.habit.rivals.map((q) => ({ id: q.id, pts: pts(q.pts) })), contact: m.habit.contact, terms: terms(m.habit, m) },
      worst: m.cover && { hyp: m.cover.hyp, rivals: m.cover.rivals.map((q) => ({ id: q.id, pts: pts(q.pts) })), contact: m.cover.contact, terms: terms(m.cover) },
      runnerUp: second && { key: second.key, score: r1(second.score), terms: terms(second.habit, second) } };
  }
}
