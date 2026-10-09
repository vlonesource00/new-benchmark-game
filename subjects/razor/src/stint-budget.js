import { COMPOUNDS, WEAR_CLIFF } from '../../../game/core/rules.js';
import { tyreGrip } from '../../../game/engine/sim/tyre.js';
import { clamp } from '../../apex/src/math.js';

// Teammates share the same physical car (also inside a seat worker). Keep its
// observed compound rates through a driver swap, without writing to the car.
const histories = new WeakMap();

// Spend a measured set's remaining grip, rather than reserving the same margin
// for a whole race. The host strategy still owns stops, compounds and fuel.
export class StintBudget {
  constructor(track) { this.track = track; this.reset(); }
  reset() { this.mark = null; this.rate = null; this.samples = 0; this.referenceWear = 0; this.factor = 1; this.report = null; }
  update(car, state = {}, dt, { rival = null, engaged = false, maximum = 1.03, referenceLap } = {}) {
    const wear = Math.max(...car.wheels.map(w => w.tyre.wear)), compound = car.wheels[0].tyre.compound;
    const progress = car.race?.progress ?? 0, lap = car.race?.lap ?? 1;
    let history = histories.get(car);
    if (!history || progress < history.progress - this.track.length * .2
      || state.phase === 'grid' && history.progress > 0) {
      history = { progress, rates: new Map() }; histories.set(car, history);
    }
    history.progress = progress;
    const replaced = this.mark && (compound !== this.mark.compound || wear < this.mark.wear - .025);
    if (replaced || state.formation || state.phase === 'grid') this.reset();
    const measured = history.rates.get(compound);
    if (this.rate === null && measured) { this.rate = measured.rate; this.samples = measured.samples; }
    this.mark ??= { compound, wear, progress, lap };
    if (!state.pit && lap > this.mark.lap && progress - this.mark.progress > this.track.length * .8) {
      const observed = Math.max(0, wear - this.mark.wear) * this.track.length / (progress - this.mark.progress);
      this.rate = this.rate === null ? observed : this.rate * .4 + observed * .6;
      if (this.referenceWear === 0 && car.race?.lastState !== 'pit' && car.race?.lastState !== 'red') this.referenceWear = wear;
      this.samples++; this.mark = { compound, wear, progress, lap };
      history.rates.set(compound, { rate: this.rate, samples: this.samples });
    }
    const remaining = Math.max(0, (state.totalLaps ?? lap + 3) - Math.max(0, progress / this.track.length));
    const fuelWindow = Number.isFinite(state.fuelPerLap) && state.fuelPerLap > 0 ? car.fuel / state.fuelPerLap : 3;
    // A confirmed tyre stop makes the rest of this lap the current set's job.
    // A fuel-only stop does not renew its wear budget.
    const window = Math.min(remaining, state.pitPlan?.tyres ? Math.max(.05, 1 - progress / this.track.length % 1)
      : state.pitPlan?.tyres === false ? remaining : Math.max(.25, fuelWindow));
    const rate = Math.max(this.rate ?? 0, (this.rate ?? WEAR_CLIFF * (COMPOUNDS[compound]?.wear ?? 1) / Math.max(5, state.tyreLaps ?? 5)) * 1.12);
    const hot = Math.max(...car.wheels.map(w => w.tyre.core - w.tyre.optimum));
    const tyre = car.wheels.reduce((a, b) => a.tyre.wear >= b.tyre.wear ? a : b).tyre;
    const referenceGrip = tyreGrip({ ...tyre, core: tyre.optimum, wear: Math.min(wear, this.referenceWear) }, 3300);
    const lapTime = Math.max(0, referenceLap ?? this.track.length / (car.classId === 'lmdh' ? 55 : 45));
    const predict = factor => {
      const endWear = clamp(wear + rate * window * (1 + 4 * (factor - 1)), 0, 1);
      const grip = tyreGrip({ ...tyre, core: tyre.optimum, wear: endWear }, 3300);
      return { endWear, fade: lapTime * .55 * Math.max(0, Math.sqrt(referenceGrip / Math.max(.1, grip)) - 1) };
    };
    // Find the largest affordable increase, rather than rejecting all push
    // merely because the maximum would overspend this set's remaining life.
    let low = 1, high = Math.max(1, maximum);
    for (let i = 0; i < 7; i++) {
      const mid = (low + high) * .5;
      const candidate = predict(mid);
      if (candidate.fade < 3.8 && candidate.endWear < .92) low = mid; else high = mid;
    }
    const catching = Boolean(rival?.target && rival.ds > 0 && rival.ds < 90 && !state.pitPlan);
    // Keep the budget through overlap and clearance; easing it at the rival's
    // door would discard the exit-speed advantage that initiated the move.
    const passing = Boolean(engaged && rival?.target && rival.ds > -16 && rival.ds < 90 && !state.pitPlan);
    const final = remaining < 1.5, urgency = final || passing ? 1 : catching ? .85 : .35;
    const thermal = clamp((18 - hot) / 10, 0, 1);
    const eligible = this.samples > 0 && COMPOUNDS[compound] && (state.weather ?? 'clear') === 'clear'
      && !state.pit && !state.formation && state.phase !== 'grid';
    const target = eligible ? 1 + (low - 1) * urgency * thermal : 1;
    this.factor += (target - this.factor) * Math.min(1, dt / .35);
    const prediction = predict(this.factor);
    this.report = { factor: this.factor, mode: final ? 'finish' : passing ? 'pass' : catching ? 'catch' : 'stint',
      measuredLaps: this.samples, wearPerLap: this.rate, lapsRemaining: remaining, stintRemaining: window,
      projectedWear: prediction.endWear, predictedFade: prediction.fade, hot, eligible: Boolean(eligible) };
    return this.factor;
  }
}
