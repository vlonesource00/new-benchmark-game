import { RazorStrategist } from '../../razor/src/strategy.js';

// The stint planner is RAZOR's (clear Harbor priors, APEX dynamic programme);
// rain and crossovers are the shared weather-aware planner's calls.
export class TempestStrategist extends RazorStrategist {
  decide(car, lapsLeft, aiDriving = true, caution = false) {
    const plan = super.decide(car, lapsLeft, aiDriving, caution);
    if (this.reason === 'RAZOR PLAN') this.reason = 'TEMPEST PLAN';
    return plan;
  }
}

export function installTempestStrategy(race, car, { enabled = true } = {}) {
  if (!enabled || race.session !== 'race') return false;
  const e = race.entryOf?.(car);
  if (!e || e.strategist instanceof TempestStrategist || e.strategist.stintLaps > 0 || e.strategist.stops > 0) return false;
  if (!e.team.drivers.every(d => d.kind === 'ai' && d.id === 'tempest')) return false;
  e.strategist = new TempestStrategist(e.strategist, race.track.id, car.classId,
    { currentStints: race.weather.id === 'clear' });
  e.strategist.race = race;
  return true;
}
