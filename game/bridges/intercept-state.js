import { apexState } from './apex-state.js';
export function interceptState(race,car){const state=apexState(race,car);if(!state)return null;const e=race.entryOf(car);
  return {...state,nextTyreLap:e.strategist.nextTyreLap??null,caution:race.caution?.phase??null};}
