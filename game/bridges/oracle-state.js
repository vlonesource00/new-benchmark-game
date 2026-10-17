import { apexState } from './apex-state.js';

/** ORACLE's race envelope: the public race state plus the caution phase and its own strategist's tyre call. */
export function oracleState(race, car) {
  const state = apexState(race, car);
  if (!state) return null;
  return { ...state, caution: race.caution?.active ? race.caution.phase : null, race };
}
