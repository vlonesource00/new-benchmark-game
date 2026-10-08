// Endurance rules: tyre compounds, race formats and the per-race calibration
// that turns a race of any length into a genuine fuel / tyre / stint problem.

export const COMPOUNDS = Object.freeze({
  // optimum = core °C of peak grip; heat = how fast slip warms the tread.
  soft:   Object.freeze({ id: 'soft',   label: 'SOFT',   short: 'S', color: '#ff3b3b', grip: 1.07, wear: 1.65, optimum: 82, heat: 1.06 }),
  medium: Object.freeze({ id: 'medium', label: 'MEDIUM', short: 'M', color: '#ffd23b', grip: 1.0,  wear: 1.0,  optimum: 90, heat: 1.0 }),
  hard:   Object.freeze({ id: 'hard',   label: 'HARD',   short: 'H', color: '#f2f2f2', grip: 0.96, wear: 0.58, optimum: 99, heat: 0.9 })
});
export const COMPOUND_IDS = Object.freeze(Object.keys(COMPOUNDS));

// Heat into the tread from sliding, per car class. Measured with scripts/strategy/stint-rig.mjs (RAZOR at race pace):
// at the raw rate a stint drove every compound 25-50 C past its window (GTP cores 125-138 C), so softs and mediums
// fell off a cliff within two laps and hards were the only sane call. With these the cores settle 95-105 C, a soft
// is quickest for ~4 laps, a medium for ~7 and a hard runs 10+ laps, so the compound is a real choice. The GTP
// tyre takes more load and downforce, so it gets the bigger cut.
export const TYRE_HEAT = Object.freeze({ lmdh: 0.32, gt: 0.42 });

// Measured on the unscaled engine (Astra at race pace, Harbor Ring, 120 Hz):
// fuel burnt and mean medium-tyre wear per metre of racing. See
// scripts/sim-endurance.mjs --calibrate.
export const BASELINE = Object.freeze({ fuelPerM: 8.2e-5, wearPerM: 6.3e-8 });

export const TANK_LITRES = 60;
export const FUEL_KG_PER_L = 0.75;
export const WEAR_CLIFF = 0.72;

export const FORMATS = Object.freeze({
  sprint:    Object.freeze({ id: 'sprint',    label: 'SPRINT ENDURO',  laps: 6,  mandatoryStops: 1, mandatorySwap: true }),
  classic:   Object.freeze({ id: 'classic',   label: 'CLASSIC 12',     laps: 12, mandatoryStops: 1, mandatorySwap: true }),
  marathon:  Object.freeze({ id: 'marathon',  label: 'MARATHON 20',    laps: 20, mandatoryStops: 2, mandatorySwap: true }),
  custom:    Object.freeze({ id: 'custom',    label: 'CUSTOM',         laps: 10, mandatoryStops: 1, mandatorySwap: true })
});

/**
 * Race calibration. A full tank lasts `fuelLaps` laps and a medium tyre reaches
 * the wear cliff after `tyreLaps` laps, both independent of track length, so
 * every circuit and race length produces a real strategy decision.
 */
export function calibrate(track, laps) {
  laps = Math.max(1, Math.round(laps));
  // A tank covers about two thirds of the race, so the one-stop window spans
  // several laps and teams can undercut or run long. Very short races still get
  // a three-lap tank; long ones stop every nine laps.
  const fuelLaps = clampInt(Math.round(Math.max(3, Math.min(30, laps)) * 0.68), 3, 9);
  const tyreLaps = Math.max(3, fuelLaps * 1.25);
  const lapFuelBase = BASELINE.fuelPerM * track.length;
  const lapWearBase = BASELINE.wearPerM * track.length;
  const fuelScale = TANK_LITRES / (fuelLaps * lapFuelBase);
  const wearScale = WEAR_CLIFF / (tyreLaps * lapWearBase);
  return {
    laps, fuelLaps, tyreLaps, fuelScale, wearScale,
    refLap: track.length / 50, // planner lap-time guess (s) until the car has run a clean lap
    lapFuel: TANK_LITRES / fuelLaps,
    refuelRate: 6.5,          // L/s
    tyreChangeS: 5.5,
    swapS: 6,
    baseStopS: 2.2
  };
}

export function serviceTime(cal, { litres = 0, tyres = false, swap = false }) {
  const fuel = litres / cal.refuelRate;
  return cal.baseStopS + Math.max(fuel, swap ? cal.swapS : 0) + (tyres ? cal.tyreChangeS : 0);
}

function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
