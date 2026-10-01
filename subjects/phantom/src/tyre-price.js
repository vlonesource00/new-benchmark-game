// Tyre shadow price. Sliding power is what heats a tyre (surface gain is
// slipPower * 0.55 / 6000 per second) and the core follows the surface. Once
// a tyre's core is past its window, every joule of sliding costs lap time on
// every later corner, so the planner pays for it now at a price that rises
// with core temperature. Below the window sliding is free (it even helps
// warm-up), so the price only ever bites on a hot tyre.

export const TYRE_WINDOW = { core: 84, span: 12 };

// Seconds per kJ of sliding energy on one tyre, derived from the host model:
//   grip loss per degree of core, d/dc [1 - ((c-85)/105)^2], plus the
//   pressure term (pressure climbs ~0.009 bar/degree, grip -13%/bar once
//   past 2.15 bar, which the GT cold pressure reaches near 81 degrees);
//   core rise per kJ of sliding, ~0.015 degree (55% reaches the surface,
//   about half of that reaches the 18 kJ/degree core before it is cooled);
//   lap-time sensitivity, ~36 s per unit of car grip, a quarter per tyre;
//   the core cools with a time constant of minutes, so the loss is paid on
//   every remaining lap of the stint.
// Heat put in now is still in the core laps later, so a cold tyre is priced
// at the temperature the stint will bring it to, not the one it has now.
export const STINT_CORE = 100;
export function tyrePrice(core, scale = 1) {
  const x = (core - TYRE_WINDOW.core) / TYRE_WINDOW.span;
  return x <= 0 ? 0 : scale * 4e-4 * x * (1 + x);
}

// Current thermal grip relative to a tyre in its window, averaged over the
// car: the ghost envelope was driven on window tyres, so a cooked set gets a
// proportionally lower corner speed (v ~ sqrt(grip)).
export function gripScale(car) {
  let g = 0;
  for (const w of car.wheels) g += Math.max(0.65, 1 - ((w.tyre.core - 85) / 105) ** 2);
  return Math.sqrt(Math.min(1, g / 4 / 0.985));
}

export function wheelPrices(car, scale = 1) {
  return car.wheels.map((w) => tyrePrice(w.tyre.core, scale));
}

// Thermal and pressure grip of the weaker axle relative to the tyres the
// ghost was driven on (cores ~78, pressures ~2.12): the envelope's corner
// speeds scale with sqrt of it.
const REF = { core: 78, pressure: 2.12 };
const thermal = (t) => Math.max(0.65, 1 - ((t.core - 85) / 105) ** 2) * Math.max(0.8, 1 - Math.abs(t.pressure - 2.15) * 0.13);
export function axleGrip(car) {
  const ref = thermal(REF), w = car.wheels;
  const front = (thermal(w[0].tyre) + thermal(w[1].tyre)) / 2, rear = (thermal(w[2].tyre) + thermal(w[3].tyre)) / 2;
  return Math.min(1, Math.min(front, rear) / ref);
}
