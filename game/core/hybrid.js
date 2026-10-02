// GTP hybrid system: a rear-axle motor-generator with its own energy store.
//
// The car harvests under braking (and a little on a lift) and deploys under
// full throttle on the straights. How much it deploys, and from what speed, is
// the deploy mode the driver picks, as on a real LMDh steering wheel:
//
//   QUAL      everything, everywhere: one lap, then a flat battery
//   ATTACK    strong deploy to pass or defend, drains over a few laps
//   BALANCED  roughly energy-neutral over a lap
//   BUILD     light deploy and harder regen, recharges for a later attack
//
// The motor force rides on vehicle.hybridForce (newtons at the contact patch).

export const HYBRID = Object.freeze({ capacity: 3.0e6, regenKw: 200, efficiency: 0.86 });
export const DEPLOY_MODES = Object.freeze({
  qual:     { id: 'qual',     label: 'QUAL',     kw: 120, from: 8,  regen: 1,   coast: 0 },
  attack:   { id: 'attack',   label: 'ATTACK',   kw: 95,  from: 14, regen: 1,   coast: 0 },
  balanced: { id: 'balanced', label: 'BALANCED', kw: 60,  from: 30, regen: 1,   coast: 12 },
  build:    { id: 'build',    label: 'BUILD',    kw: 25,  from: 45, regen: 1.2, coast: 30 }
});
export const MODE_ORDER = Object.freeze(['build', 'balanced', 'attack', 'qual']);

export const hasHybrid = (car) => car.spec?.key === 'lmdh';

export function fitHybrid(car, charge = 0.6) {
  if (!hasHybrid(car)) { car.hybrid = null; car.hybridForce = 0; return; }
  car.hybrid = { energy: HYBRID.capacity * charge, mode: car.hybrid?.mode ?? 'balanced', kw: 0, auto: car.hybrid?.auto ?? true };
  car.hybridForce = 0;
}

/** One physics step of the hybrid: sets car.hybridForce and moves the energy store. */
export function hybridStep(car, dt) {
  const h = car.hybrid; if (!h) return;
  const m = DEPLOY_MODES[h.mode] ?? DEPLOY_MODES.balanced, k = car.controls, v = Math.max(0, car.u);
  let deploy = 0, regen = 0;
  if (!k.reverse && (k.throttle ?? 0) > 0.8 && v > m.from && car.gear >= 2 && h.energy > 0) deploy = m.kw * 1000 * (k.throttle ?? 0);
  if ((k.brake ?? 0) > 0.05 && v > 10) regen = HYBRID.regenKw * 1000 * Math.min(1, k.brake * 1.6) * m.regen;
  else if ((k.throttle ?? 0) < 0.05 && v > 18) regen = m.coast * 1000;
  h.energy = Math.max(0, Math.min(HYBRID.capacity, h.energy + (regen * HYBRID.efficiency - deploy) * dt));
  // Braking regen is part of the brake torque the driver asked for; lift-off
  // regen is extra engine braking, so only that one pulls on the car.
  const coastDrag = (k.brake ?? 0) <= 0.05 ? regen : 0;
  car.hybridForce = (deploy - coastDrag) / Math.max(v, 12);
  h.kw = (deploy - regen) / 1000;
}

/** AI deploy strategy: build when low, attack when close to a car ahead or at the end. */
export function aiDeployMode(car, gapAhead, lapsLeft, qualifying = false) {
  const h = car.hybrid; if (!h || !h.auto) return;
  const soc = h.energy / HYBRID.capacity;
  h.mode = qualifying ? 'qual' : soc < 0.2 ? 'build' : (lapsLeft <= 1 && soc > 0.15) || (gapAhead < 35 && soc > 0.35) ? 'attack' : soc > 0.85 ? 'attack' : 'balanced';
}
