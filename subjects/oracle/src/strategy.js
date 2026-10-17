// ORACLE's race strategy is INTERCEPT's: the same live stint model (tyre wear per wheel, fuel, the lane's own stop
// loss, finish-on-set calls), installed on ORACLE teams by the same rules INTERCEPT uses for its own.
import { InterceptStrategist } from '../../intercept/src/strategy.js';

export function installOracleStrategy(race, car) {
  if (!race?.entries || race.session !== 'race') return false;
  const e = race.entryOf?.(car) ?? race.entries.find((x) => x.car === car);
  if (!e || e.strategist instanceof InterceptStrategist || !e.team.drivers.some((d) => d.kind === 'ai' && d.id === 'oracle')) return false;
  // Never replace another architecture's team planner in a mixed AI pairing, nor a plan already under way.
  if (e.team.drivers.some((d) => d.kind === 'ai' && d.id !== 'oracle')) return false;
  if (e.strategist.stops > 0 || e.strategist.stintLaps > 0) return false;
  e.strategist = new InterceptStrategist(e.strategist, race.track.id, car.classId, race.lane);
  return true;
}
