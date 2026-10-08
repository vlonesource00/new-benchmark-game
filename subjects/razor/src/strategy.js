import { ApexStrategist } from '../../apex/src/strategy.js';

// APEX's measured stint tables are initial priors. Live clean-lap wear learning
// remains active. RAZOR's distinct slip budget must be calibrated in endurance
// probes before claiming the four-second fade target.
export class RazorStrategist extends ApexStrategist {
  constructor(previous, trackId, classId, options = {}) {
    super(previous, trackId, classId, options);
    const roll = this.model.roll.bind(this.model);
    this.model.roll = (compound, count, state = {}) => {
      const prediction = roll(compound, count, state), limit = this.paceLimit(compound);
      // Price the actual window into every future stint, including fresh
      // tyres. Forcing a stop afterwards leaves the search optimistically
      // choosing softs for a long finish, then paying for repeated stops.
      for (let i = 0; i < prediction.t.length; i++) {
        if ((state.age0 ?? 0) + i >= limit) prediction.t[i] = 1e9;
      }
      return prediction;
    };
  }
  get hardWindow() { return this.classId === 'lmdh' ? 6 : 7; }
  // The inherited dynamic programme permits three stops. Longer races use
  // the game's normal planner rather than searching an impossible window.
  get usable() { return super.usable && (this.race?.track.wetness ?? 0) < 0.08 && this.cal.laps <= this.hardWindow * 4; }
  paceLimit(compound) {
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
  e.strategist = new RazorStrategist(e.strategist, race.track.id, car.classId);
  e.strategist.race = race;
  return true;
}
