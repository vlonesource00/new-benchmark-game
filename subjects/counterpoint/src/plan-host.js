// The planner on the far side of a worker. It keeps its own copy of the track, the class pilots and the planner
// (whose memory of the last move carries the keep bonus from plan to plan), and plans on the state each request
// carries: the ego car and pilot as they are, the rivals near it with what the live driver has learnt of them, and
// the road's surface. The reply is the move and what the debugger is shown of it.
import { Track } from '../../../game/engine/sim/track.js';
import { Pilot } from './pilot.js';
import { RivalBook } from './rivals.js';
import { Planner } from './planner.js';
import { applySurface, rebuildCar, rebuildPilot } from './state.js';

export class PlanHost {
  init({ scenario, options = {} }) {
    this.o = options;
    this.track = new Track(scenario);
    this.book = new RivalBook(this.track);
    this.pilot = new Pilot(this.track, options.pilot ?? {});
    this.planner = new Planner(this.track, this.book, options);
  }
  reset() { this.planner?.reset(); }
  /** The class's line and envelope, built once (the first plan of a race would otherwise wait for them). */
  prepare(ego) {
    if (this.pilot.classId === ego.classId) return;
    // As on the live side: the ego class's pilot is the rivals' prototype too.
    this.pilot.prepare(ego);
    const proto = Object.assign(Object.create(Object.getPrototypeOf(this.pilot)), this.pilot);
    proto.isShadow = true; this.book.pilots.set(ego.classId, proto);
  }
  warm({ car }) { this.prepare(rebuildCar(car)); }
  plan({ seq, car, pilot, near, surface }) {
    const t0 = performance.now();
    applySurface(this.track, surface);
    const ego = rebuildCar(car);
    this.prepare(ego);
    const rivals = near.map(({ r, ds }) => {
      const c = rebuildCar(r.car);
      return { r: { ...r, car: c, line: this.book.pilotFor(c).line }, ds };
    });
    const p = rebuildPilot(this.pilot, pilot);
    const m = this.planner.plan(ego, p, rivals);
    const move = { key: m.key, lane: m.lane, follow: m.follow, yieldTo: m.yieldTo, score: m.score, cands: m.cands };
    return { type: 'plan', seq, move, explain: this.planner.explain(m), ms: performance.now() - t0,
      rollouts: this.planner.rollouts.count, carSteps: this.planner.rollouts.steps, decisions: this.planner.decisions };
  }
}
