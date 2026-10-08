import { ApexStrategist } from '../../apex/src/strategy.js';

// APEX's measured stint tables are initial priors. Live clean-lap wear learning
// remains active. RAZOR's distinct slip budget must be calibrated in endurance
// probes before claiming the four-second fade target.
export class RazorStrategist extends ApexStrategist {
  get usable() { return super.usable && (this.race?.track.wetness ?? 0) < 0.08; }
  decide(car, lapsLeft, aiDriving = true) {
    const plan = super.decide(car, lapsLeft, aiDriving);
    if (this.reason === 'APEX PLAN') this.reason = 'RAZOR PLAN';
    if (plan || !this.usable || !aiDriving || this.request || lapsLeft <= 1 || this.trackId !== 'harbor-ring'
      || this.race?.weather.id !== 'clear') return plan;
    // Initial limits come from actual RAZOR stints, not a shared driver's
    // optimistic long-stint prior. In particular, do not enter the hard tyre's
    // steep seventh-lap fade while waiting for the fuel window.
    const compound = car.wheels[0].tyre.compound;
    const limit = { soft: 2, medium: 3, hard: this.classId === 'lmdh' ? 6 : 7 }[compound];
    if (!limit || this.stintLaps + 1 < limit) return plan;
    const fuelLaps = Math.floor(car.fuel / this.fuelPerLap - 0.15), cur = this.curSet(car, lapsLeft);
    const root = this.root({ n: lapsLeft, cur, fuelLaps, stops: this.stops, swaps: this.swaps });
    const best = root.stops.reduce((a, b) => b.cost < a.cost ? b : a, { cost: Infinity });
    if (!Number.isFinite(best.cost)) return plan;
    this.chosen = { ...best, after: lapsLeft - 1 };
    this.boxThisLap = true; this.reason = 'RAZOR PACE WINDOW';
    this.decisions.push({ lap: car.race.lap, box: true, reason: this.reason, compound: best.compound });
    return (this.plan = this.fit(car, lapsLeft - 1, best));
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
