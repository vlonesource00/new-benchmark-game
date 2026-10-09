import { ApexStrategist } from '../../apex/src/strategy.js';
import { RazorStintModel } from './stint-model.js';

// Dry races may use only RAZOR's current-physics stint priors. Tracks without
// measured priors fall through to the game's live planner; inherited APEX
// tables were recorded before the class heat and wear-cliff changes.
export class RazorStrategist extends ApexStrategist {
  constructor(previous, trackId, classId, options = {}) {
    super(previous, trackId, classId, options);
    this.currentStints = options.currentStints === true;
    if (this.currentStints) this.model = new RazorStintModel(trackId, classId, this.cal);
    const roll = this.model.roll.bind(this.model);
    this.model.roll = (compound, count, state = {}) => {
      const prediction = roll(compound, count, state), limit = this.paceLimit(compound);
      const reference = this.currentStints && this.model.ok ? this.model.referenceTime(compound) * this.model.adapt.time : Infinity;
      // Price the actual window into every future stint, including fresh
      // tyres. Forcing a stop afterwards leaves the search optimistically
      // choosing softs for a long finish, then paying for repeated stops.
      for (let i = 0; i < prediction.t.length; i++) {
        const age = (state.age0 ?? 0) + i;
        if (age >= limit || (age >= 2 && prediction.t[i] > reference + 4)) prediction.t[i] = 1e9;
      }
      return prediction;
    };
  }
  get hardWindow() { return this.classId === 'lmdh' ? 6 : 7; }
  // The inherited dynamic programme permits three stops. Longer races use
  // the game's normal planner rather than searching an impossible window.
  get usable() { return super.usable && (this.race?.track.wetness ?? 0) < 0.08 && this.cal.laps <= (this.currentStints ? 36 : this.hardWindow * 4); }
  paceLimit(compound) {
    if (this.currentStints) return Infinity;
    if (this.trackId !== 'harbor-ring' || this.race?.weather.id !== 'clear' || !this.usable) return Infinity;
    return { soft: 2, medium: 3, hard: this.hardWindow }[compound] ?? Infinity;
  }
  decide(car, lapsLeft, aiDriving = true, caution = false) {
    const plan = super.decide(car, lapsLeft, aiDriving, caution);
    if (this.reason === 'APEX PLAN') this.reason = 'RAZOR PLAN';
    return plan;
  }
}

export function installRazorStrategy(race, car, { enabled = true } = {}) {
  if (!enabled || race.session !== 'race') return false;
  const e = race.entryOf?.(car);
  if (!e || e.strategist instanceof RazorStrategist || e.strategist.stintLaps > 0 || e.strategist.stops > 0) return false;
  if (!e.team.drivers.every(d => d.kind === 'ai' && d.id === 'razor')) return false;
  e.strategist = new RazorStrategist(e.strategist, race.track.id, car.classId,
    { currentStints: race.weather.id === 'clear' });
  e.strategist.race = race;
  return true;
}
