// Optional read-only envelope for SPEARHEAD. Existing controller contexts and
// simulation behavior are unchanged.
export function nextRacerState(race,car) {
  const e=race.entryOf?.(car);
  if(!e)return race.nextRacerState??null;
  return {session:race.session,weather:race.weather?.id,phase:race.phase,formation:Boolean(race.formation),
    greenAt:race.greenAt,totalLaps:race.laps,ambient:race.track.ambient,
    fuelLaps:race.cal?.fuelLaps,tyreLaps:race.cal?.tyreLaps,
    fuelPerLap:e.strategist.fuelPerLap,stintLaps:e.strategist.stintLaps,
    pitPlan:e.pitPlan,pit:e.pit?.phase??null,active:e.active,
    flag:race.stewards?.flagFor(e,race.stewards.hazards()),
    penalty:race.stewards?.pendingPenalty(e)?.type??null};
}
