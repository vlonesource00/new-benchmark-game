import { apexState } from './apex-state.js';
import { damageSpent } from '../../subjects/vanguard-v2/src/racecraft.js';
import { controlMemory } from '../../subjects/vanguard-v2/src/controller.js';
export function vanguardV2State(race, car) {
  const state = apexState(race, car);
  if (!state) return null;
  const e = race.entryOf(car);
  return {
    ...state,
    damageSpent: damageSpent(car),
    controlMemory: controlMemory(car),
    nextTyreLap: e.strategist.nextTyreLap ?? null,
    caution: race.caution?.active ? race.caution.phase : null,
    lapRef: e.strategist.lapRef,
    wearPerLap: { ...e.strategist.wearPerLap }
  };
}
