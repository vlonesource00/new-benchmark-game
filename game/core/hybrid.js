// GTP hybrid system: a rear-axle motor-generator with its own energy store.
//
// The car harvests under braking and on every lift (the motor-generator
// drags the rear axle like strong engine braking) and deploys under full
// throttle. The deploy mode is the driver's dial, as on a real LMDh wheel:
//
//   QUAL      everything, everywhere: one lap, then a flat battery
//   ATTACK    full deploy to pass or defend, drains in a lap or two
//   BALANCED  self-levelling: deploy eases off as the charge falls, so it
//             settles where it spends what the lap harvests
//   BUILD     light deploy, hardest lift-off regen: recharges for later
//
// Harvest: braking recovers up to regenKw (a light brake already harvests),
// lifting off harvests the mode's `lift` kW. Both scale down at low speed.
// The motor force rides on vehicle.hybridForce (newtons at the contact patch).

export const HYBRID = Object.freeze({ capacity: 3.0e6, regenKw: 300, efficiency: 0.86 });
export const DEPLOY_MODES = Object.freeze({
  qual:     { id: 'qual',     label: 'QUAL',     kw: 120, from: 8,  lift: 0,   level: false },
  attack:   { id: 'attack',   label: 'ATTACK',   kw: 95,  from: 14, lift: 40,  level: false },
  balanced: { id: 'balanced', label: 'BALANCED', kw: 70,  from: 25, lift: 80,  level: true },
  build:    { id: 'build',    label: 'BUILD',    kw: 20,  from: 45, lift: 130, level: false }
});
export const MODE_ORDER = Object.freeze(['build', 'balanced', 'attack', 'qual']);

export const hasHybrid = (car) => car.spec?.key === 'lmdh';
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function fitHybrid(car, charge = 0.6) {
  if (!hasHybrid(car)) { car.hybrid = null; car.hybridForce = 0; return; }
  car.hybrid = { energy: HYBRID.capacity * charge, mode: car.hybrid?.mode ?? 'balanced', kw: 0, auto: car.hybrid?.auto ?? true };
  car.hybridForce = 0;
}

/** One physics step of the hybrid: sets car.hybridForce and moves the energy store. */
export function hybridStep(car, dt) {
  const h = car.hybrid; if (!h) return;
  const m = DEPLOY_MODES[h.mode] ?? DEPLOY_MODES.balanced, k = car.controls, v = Math.max(0, car.u);
  const throttle = k.throttle ?? 0, brake = k.brake ?? 0, soc = h.energy / HYBRID.capacity;
  let deploy = 0, regen = 0, lift = 0;
  if (!k.reverse && throttle > 0.8 && v > m.from && car.gear >= 2 && h.energy > 0) {
    // Balanced levels itself: full deploy above 70% charge, a trickle near empty.
    const level = m.level ? 0.2 + 0.8 * clamp01((soc - 0.15) / 0.55) : 1;
    deploy = m.kw * 1000 * throttle * level;
  }
  const speedFade = clamp01((v - 8) / 14);
  if (brake > 0.05) regen = HYBRID.regenKw * 1000 * Math.min(1, brake * 2.5) * speedFade;
  else if (throttle < 0.05 && !k.reverse) lift = m.lift * 1000 * speedFade;
  if (h.energy >= HYBRID.capacity) regen = lift = 0;
  h.energy = Math.max(0, Math.min(HYBRID.capacity, h.energy + ((regen + lift) * HYBRID.efficiency - deploy) * dt));
  // Braking regen is part of the brake torque the driver asked for; lift-off
  // regen is extra engine braking, so only that one pulls on the car.
  car.hybridForce = (deploy - lift) / Math.max(v, 12);
  h.kw = (deploy - regen - lift) / 1000;
}

/**
 * AI deploy strategy, the race engineer's call: attack to pass or defend a
 * same-class rival, flat out on the final lap, build when nearly empty and
 * in clean air, otherwise balanced.
 */
export function aiDeployMode(car, gapAhead, lapsLeft, qualifying = false, gapBehind = Infinity) {
  const h = car.hybrid; if (!h || !h.auto) return;
  const soc = h.energy / HYBRID.capacity;
  if (qualifying) { h.mode = 'qual'; return; }
  const fight = gapAhead < 40 || gapBehind < 25;
  h.mode = lapsLeft <= 1 && soc > 0.1 ? 'attack'
    : (fight && soc > 0.3) || soc > 0.9 ? 'attack'
    : soc < 0.2 && !fight ? 'build'
    : 'balanced';
}
