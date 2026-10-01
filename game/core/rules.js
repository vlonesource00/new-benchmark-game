// Endurance rules: tyre compounds, race formats and the per-race calibration
// that turns a 5–20 lap race into a genuine fuel / tyre / stint problem.

export const COMPOUNDS = Object.freeze({
  soft:   Object.freeze({ id: 'soft',   label: 'SOFT',   short: 'S', color: '#ff3b3b', grip: 1.045, wear: 1.65 }),
  medium: Object.freeze({ id: 'medium', label: 'MEDIUM', short: 'M', color: '#ffd23b', grip: 1.0,   wear: 1.0 }),
  hard:   Object.freeze({ id: 'hard',   label: 'HARD',   short: 'H', color: '#f2f2f2', grip: 0.968, wear: 0.58 })
});
export const COMPOUND_IDS = Object.freeze(Object.keys(COMPOUNDS));

// Measured on the unscaled engine (Astra at race pace, Harbor Ring, 120 Hz):
// fuel burnt and mean medium-tyre wear per metre of racing. See
// scripts/sim-endurance.mjs --calibrate.
export const BASELINE = Object.freeze({ fuelPerM: 8.2e-5, wearPerM: 1.01e-7 });

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
  laps = Math.max(3, Math.min(30, Math.round(laps)));
  const fuelLaps = clampInt(Math.round(laps * 0.55), 3, 9);
  const tyreLaps = Math.max(3, fuelLaps * 1.25);
  const lapFuelBase = BASELINE.fuelPerM * track.length;
  const lapWearBase = BASELINE.wearPerM * track.length;
  const fuelScale = TANK_LITRES / (fuelLaps * lapFuelBase);
  const wearScale = WEAR_CLIFF / (tyreLaps * lapWearBase);
  return {
    laps, fuelLaps, tyreLaps, fuelScale, wearScale,
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
