import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { wearGrip } from '../../../game/engine/sim/tyre.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Tread budget: how much of the set's life the car may spend as grip margin.
 *
 * Wear fades grip by only 0.10 per unit until the cliff (72 %), and a margin push of x makes the tyres wear about
 * k = 2x faster (measured, Harbor LMDh: margin 0.97 -> 0.999 gave -0.23 s/lap and +6 % wear per metre), so spending
 * tread pays until the set runs into the cliff. The worst wheel's wear per metre is measured on this set (a compound
 * prior until a third of a lap is run). The set has to last to the end of the race, a planned tyre stop, or the fuel
 * window (the game's stop fits new tyres once the set is past 40 %). The push is the largest one whose projected end
 * wear stays under `treadWear` and whose projected end-of-stint fade stays under `treadFade` seconds a lap; it is
 * capped where the margin reaches the tyre's force peak (1 / margin), and nothing is spent on a set's first lap.
 */
export class TreadBudget {
  constructor(track, o = {}) { this.track = track; this.o = o; this.reset(); }
  reset() { this.set = null; this.push = 1; this.why = 'fresh'; this.rate = NaN; this.endWear = 0; this.left = 0; this.fade = 0; }
  update(car, state, margin = 1) {
    const o = this.o, L = this.track.length, wear = Math.max(...car.wheels.map((w) => w.tyre.wear)), compound = car.wheels[0].tyre.compound;
    const dist = Math.max(0, car.race?.progress ?? 0);
    if (!this.set || compound !== this.set.compound || wear < this.set.wear - 0.02) this.set = { compound, wear, dist };
    if (state.formation || state.phase === 'grid' || state.pit) { this.why = 'pit/formation'; return (this.push = 1); }
    if ((state.weather ?? 'clear') !== 'clear' || (this.track.wetness ?? 0) > 0.08) { this.why = 'wet'; return (this.push = 1); }
    const run = dist - this.set.dist, prior = WEAR_CLIFF * (COMPOUNDS[compound]?.wear ?? 1) / Math.max(4, state.tyreLaps ?? 5) / L;
    const k = o.treadK ?? 2;
    // per metre at push 1; blend from the prior to the measurement over the first lap
    const meas = run > 0 ? (wear - this.set.wear) / run : prior, a = clamp((run - 0.3 * L) / (0.7 * L), 0, 1);
    const perM = (a * meas + (1 - a) * prior * 1.15) / Math.max(0.5, 1 + k * (this.push - 1));
    const lapsLeft = Math.max(0, (state.totalLaps ?? 0) - dist / L);
    const fuelLaps = state.fuelPerLap > 0 ? Math.max(0.25, (car.fuel ?? 0) / state.fuelPerLap) : lapsLeft;
    const window = state.pitPlan?.tyres ? Math.max(0.05, 1 - (dist / L) % 1) : state.pitPlan?.tyres === false ? lapsLeft : Math.min(lapsLeft, fuelLaps);
    this.left = window * L; this.rate = perM * L;
    const lap = Number.isFinite(car.race?.bestLap) ? car.race.bestLap : L / (car.classId === 'lmdh' ? 55 : 45);
    // fade: corner speed goes with the square root of grip, and about half a lap is corner-limited
    const g0 = wearGrip(this.set.wear), base = perM * this.left;
    const predict = (push) => { const w = wear + base * (1 + k * (push - 1)); return { w, fade: lap * (o.treadShare ?? 0.55) * (Math.sqrt(g0 / wearGrip(Math.min(1, w))) - 1) }; };
    const max = Math.min(o.treadMax ?? 1.03, 1 / Math.max(0.5, margin)), wMax = o.treadWear ?? 0.9, fMax = o.treadFade ?? 3;
    const ok = (push) => { const p = predict(push); return p.w < wMax && p.fade < fMax; };
    // nothing is spent before a lap on this set is measured: the rate would be the prior, the tyres still coming in
    let push = 1;
    if (run < L) this.why = 'measure';
    else if (ok(max)) push = max;
    else if (ok(1)) { let lo = 1, hi = max; for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; } push = lo; }
    const p = predict(push); this.endWear = p.w; this.fade = p.fade;
    if (run >= L) this.why = push >= max - 1e-4 ? 'spend' : push > 1 ? 'ration' : 'save';
    return (this.push = push);
  }
}
