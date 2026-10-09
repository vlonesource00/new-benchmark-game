import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Tread budget: how much of the set's life the car may spend as grip margin.
 *
 * Wear fades grip by only 0.10 per unit until the cliff (72 %), so a margin push of x costs at most ~0.14x of grip
 * averaged over a whole stint while it earns x at once: spending tread always pays, and the one thing to protect is
 * the cliff. The worst wheel's wear per metre is measured on this set (a compound prior until a third of a lap is
 * run), the set's remaining distance is the race left (or the distance to a planned tyre stop), and wear is taken to
 * grow `k` times faster than the margin. The push is the largest one whose projected end wear stays under the cap.
 */
export class TreadBudget {
  constructor(track, o = {}) { this.track = track; this.o = o; this.reset(); }
  reset() { this.set = null; this.push = 1; this.why = 'fresh'; this.rate = NaN; this.endWear = 0; this.left = 0; }
  update(car, state) {
    const o = this.o, L = this.track.length, wear = Math.max(...car.wheels.map((w) => w.tyre.wear)), compound = car.wheels[0].tyre.compound;
    const dist = Math.max(0, car.race?.progress ?? 0);
    if (!this.set || compound !== this.set.compound || wear < this.set.wear - 0.02) this.set = { compound, wear, dist };
    if (state.formation || state.phase === 'grid' || state.pit) { this.why = 'pit/formation'; return (this.push = 1); }
    if ((state.weather ?? 'clear') !== 'clear' || (this.track.wetness ?? 0) > 0.08) { this.why = 'wet'; return (this.push = 1); }
    const run = dist - this.set.dist, prior = WEAR_CLIFF * (COMPOUNDS[compound]?.wear ?? 1) / Math.max(4, state.tyreLaps ?? 5) / L;
    // per metre at the current push; blend from the prior to the measurement over the first lap
    const meas = run > 0 ? (wear - this.set.wear) / run : prior, a = clamp((run - 0.3 * L) / (0.7 * L), 0, 1);
    const perM = (a * meas + (1 - a) * prior * 1.15) / Math.max(0.5, 1 + (o.treadK ?? 2) * (this.push - 1));
    const lapsLeft = Math.max(0, (state.totalLaps ?? 0) - dist / L);
    const toPit = state.pitPlan?.tyres ? Math.max(0.05, 1 - (dist / L) % 1) : lapsLeft;
    this.left = Math.min(lapsLeft, toPit) * L; this.rate = perM * L;
    const cap = o.treadCap ?? 0.68, max = o.treadMax ?? 1.05;
    // end wear is linear in the push: solve for the push that lands exactly on the cap
    const base = perM * this.left, k = o.treadK ?? 2;
    let push = base > 1e-6 ? 1 + ((cap - wear) / base - 1) / k : max;
    push = clamp(push, 1, max);
    this.endWear = wear + base * (1 + k * (push - 1));
    this.why = push >= max - 1e-4 ? 'spend' : push > 1 ? 'ration' : 'save';
    return (this.push = push);
  }
}
