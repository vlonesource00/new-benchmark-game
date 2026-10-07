// Read-only race envelope for APEX (P3). Opt-in: only seats driven by `apex` receive it,
// so every other controller context is unchanged. Everything here is public on the
// timing screen or already readable from the cars; nothing is a rival's private plan.
export function apexState(race, car) {
  const e = race.entryOf?.(car);
  if (!e) return null;
  const st = race.stewards, mine = st?.of(e);
  return {
    session: race.session, weather: race.weather?.id, phase: race.phase, formation: Boolean(race.formation),
    greenAt: race.greenAt, totalLaps: race.laps, ambient: race.track.ambient,
    fuelLaps: race.cal?.fuelLaps, tyreLaps: race.cal?.tyreLaps, refuelRate: race.cal?.refuelRate,
    fuelPerLap: e.strategist.fuelPerLap, stintLaps: e.strategist.stintLaps, stops: e.strategist.stops, swaps: e.strategist.swaps,
    mandatoryStops: race.format?.mandatoryStops ?? 0, mandatorySwap: Boolean(race.format?.mandatorySwap), drivers: e.team.drivers.length,
    pitPlan: e.pitPlan, pit: e.pit?.phase ?? null, active: e.active,
    flag: st?.flagFor(e, st.hazards()), penalty: st?.pendingPenalty(e)?.type ?? null,
    incidents: mine?.inc ?? 0, incidentLimits: st?.limits ?? null, damage: car.damage ?? 0,
    hazards: st?.hazards() ?? [],
    // Public timing-screen view of every entry: which architecture drives it and what it is doing.
    rivals: race.entries.map((o) => ({
      id: o.car.id, driver: o.team.drivers[o.active]?.id ?? null, stops: o.strategist.stops,
      pit: o.pit?.phase ?? null, boxCalled: Boolean(o.pitPlan), retired: Boolean(o.retired), stintLaps: o.strategist.stintLaps
    }))
  };
}
