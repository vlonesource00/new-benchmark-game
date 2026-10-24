// COUNTERPOINT driver. With nobody near, the pilot drives the racing line. With rivals near, the planner replays the
// next seconds of the fight through the game's physics for each candidate move every `period` seconds and the pilot
// drives the move that came out best. The live car runs the same pilot and the same follow rule as its rollouts.
import { Pilot } from './pilot.js';
import { RivalBook } from './rivals.js';
import { Planner } from './planner.js';
import { followCap } from './follow.js';

export const DEFAULTS = { period: 0.2, horizon: 2.4, dt: 1 / 60, robust: 4, fightRivals: 2, simRivals: 3, reflex: true };

export class CounterpointDriver {
  constructor(track, options = {}) {
    this.track = track; this.o = { ...DEFAULTS, ...options };
    this.pilot = new Pilot(track, this.o.pilot ?? {});
    this.book = new RivalBook(track);
    this.planner = new Planner(track, this.book, this.o);
    this.reset();
  }
  reset() { this.clock = 0; this.due = 0; this.move = null; this.book.reset(); this.planner.reset(); this.pilot.classId && this.pilot.reset(); this.reflexes = 0; this.planMs = 0; this.planMax = 0; }
  prepare(car) {
    if (this.pilot.classId === car.classId) return;
    this.pilot.prepare(car);
    // The ego class's pilot is the rivals' prototype too: one line per class, built once.
    const proto = Object.assign(Object.create(Object.getPrototypeOf(this.pilot)), this.pilot);
    proto.isShadow = true; this.book.pilots.set(car.classId, proto);
  }
  update(car, cars, dt, context = {}) {
    this.prepare(car);
    this.clock += dt;
    this.book.observe(car, cars, dt);
    const near = this.book.near(car), length = this.track.length;
    if (!near.length) this.move = null;
    else if (this.clock >= this.due || !this.move) {
      const t0 = performance.now();
      this.move = this.planner.plan(car, this.pilot, near);
      const ms = performance.now() - t0; this.planMs += ms; this.planMax = Math.max(this.planMax, ms);
      this.due = this.clock + this.o.period;
    }
    const m = this.move;
    let cap = m?.follow ? followCap(car, cars, length) : Infinity;
    // Reflex: a pressing move that the field has overtaken (the car ahead brakes harder than forecast) gets the hard
    // follow limit at once and a fresh plan on the next tick.
    if (m && !m.follow && this.o.reflex) {
      const hard = followCap(car, cars, length, { decel: 12, react: 0 });
      if (hard < car.speed - 1) { cap = hard; this.due = 0; this.reflexes++; }
    }
    this.pilot.command = { lateral: m?.lane ?? 0, cap, mode: m?.key ?? 'PACE' };
    return this.pilot.update(car, cars, dt, context);
  }
  debug() {
    const m = this.move, r = this.planner.rollouts;
    return { architecture: 'COUNTERPOINT', intent: m ? m.key : 'PACE', lane: m?.lane ?? 0, follow: m?.follow ?? null,
      score: m?.score, candidates: m?.cands, decisions: this.planner.decisions, rollouts: r.count, carSteps: r.steps, reflexes: this.reflexes, planMs: this.planMs, planMax: this.planMax,
      trace: this.pilot.trace };
  }
  visualDebug() { return null; }
}
