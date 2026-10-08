// GTP hybrid system: a rear-axle motor-generator with its own energy store.
//
// The car harvests under braking and on every lift (the motor-generator
// drags the rear axle like strong engine braking) and deploys under full
// throttle. The deploy mode is the driver's dial, as on a real LMDh wheel:
//
//   QUAL      everything, everywhere: one lap, then a flat battery
//   ATTACK    full deploy everywhere to pass or defend (top speed decides a
//             fight), drains in a lap or two
//   BALANCED  the race mode: follows the deploy map and levels the charge,
//             so it settles where it spends what the lap harvests
//   BUILD     light deploy, hardest lift-off regen: recharges for later
//
// Where the energy goes: the deploy map (deployMap) follows the racing line's
// speed profile, full power out of slow corners where the car is accelerating
// hardest and each joule buys the most time, fading as the car nears the
// straight's top speed (the floor keeps a trickle there in race modes). On top
// of the map, BALANCED steers the charge to its target: more deploy while the
// store is above it, less below, so the battery neither saturates nor runs dry.
//
// Harvest: braking recovers up to regenKw (a light brake already harvests),
// lifting off harvests the mode's `lift` kW. Both scale down at low speed.
// The motor force rides on vehicle.hybridForce (newtons at the contact patch).

export const HYBRID = Object.freeze({ capacity: 3.0e6, regenKw: 300, efficiency: 0.86 });
export const DEPLOY_MODES = Object.freeze({
  qual:     { id: 'qual',     label: 'QUAL',     kw: 120, from: 8,  lift: 0,   floor: 1,    target: null },
  attack:   { id: 'attack',   label: 'ATTACK',   kw: 95,  from: 14, lift: 40,  floor: 1,    target: null },
  balanced: { id: 'balanced', label: 'BALANCED', kw: 85,  from: 25, lift: 80,  floor: 0.15, target: 0.55 },
  build:    { id: 'build',    label: 'BUILD',    kw: 20,  from: 45, lift: 130, floor: 1,    target: null }
});
export const MODE_ORDER = Object.freeze(['build', 'balanced', 'attack', 'qual']);

// Opt-in driver intent (APEX): car.intent = { deploy, harvest, ttl }. `deploy` 0..1 scales the
// ATTACK deploy power, `harvest` 0..1 sets lift-off regen between the ATTACK and BUILD figures, `ttl` is
// the seconds the request stays valid without being refreshed. Cars that never set it are unchanged,
// and every energy rule (throttle > 0.8, minimum speed, store limits) still applies.
const INTENT_MAX_KW = 95, INTENT_LIFT_KW = [DEPLOY_MODES.attack.lift, DEPLOY_MODES.build.lift];
function intentMode(car, dt) {
  const i = car.intent;
  if (!i || !Number.isFinite(i.deploy)) return null;
  i.ttl = (i.ttl ?? 0.5) - dt;
  if (i.ttl <= 0) return null;
  const harvest = clamp01(i.harvest ?? 0.5);
  return { kw: INTENT_MAX_KW * clamp01(i.deploy), from: DEPLOY_MODES.attack.from, lift: INTENT_LIFT_KW[0] + (INTENT_LIFT_KW[1] - INTENT_LIFT_KW[0]) * harvest, floor: 1, target: null, intent: true };
}

export const hasHybrid = (car) => car.spec?.key === 'lmdh';
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function fitHybrid(car, charge = 0.6) {
  if (!hasHybrid(car)) { car.hybrid = null; car.hybridForce = 0; return; }
  car.hybrid = { energy: HYBRID.capacity * charge, mode: car.hybrid?.mode ?? 'balanced', kw: 0, auto: car.hybrid?.auto ?? true };
  car.hybridForce = 0;
}

/**
 * Deploy map for a racing line: deploy share 0..1 every `step` metres. In an acceleration zone the share is
 * how far the car still is from the zone's peak speed (1 at the corner exit, 0 at the top), weighted down for
 * short bursts where a full kick barely moves the lap time; braking zones get 0 (the throttle gate closes them anyway).
 */
export function deployMap(line, length, step = 5) {
  const n = Math.max(8, Math.round(length / step)), v = new Float32Array(n), map = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = line.at(i * length / n).speed;
  for (let i = 0; i < n; i++) {
    const next = v[(i + 1) % n];
    if (next < v[i] - 0.02) continue;
    let lo = v[i], hi = v[i];
    for (let k = 1, prev = v[i]; k < n; k++) { const x = v[(i - k + n) % n]; if (x > prev + 0.02) break; lo = prev = x; }
    for (let k = 1, prev = v[i]; k < n; k++) { const x = v[(i + k) % n]; if (x < prev - 0.02) break; hi = prev = x; }
    if (hi - lo < 1) { map[i] = 0.5; continue; }
    map[i] = clamp01((hi - v[i]) / (hi - lo)) ** 0.8 * clamp01(0.4 + (hi - lo) / 25);
  }
  return map;
}

/** One physics step of the hybrid: sets car.hybridForce and moves the energy store. `map` is the line's deployMap over `length` metres. */
export function hybridStep(car, dt, map = null, length = 0) {
  const h = car.hybrid; if (!h) return;
  const m = intentMode(car, dt) ?? DEPLOY_MODES[h.mode] ?? DEPLOY_MODES.balanced, k = car.controls, v = Math.max(0, car.u);
  const throttle = k.throttle ?? 0, brake = k.brake ?? 0, soc = h.energy / HYBRID.capacity;
  let deploy = 0, regen = 0, lift = 0;
  if (!k.reverse && throttle > 0.8 && v > m.from && car.gear >= 2 && h.energy > 0) {
    // Position on the lap (the map, above the mode's floor), then the charge: BALANCED leans on the store when it is
    // above target and backs off below it; every mode eases off over the last few percent instead of falling off a cliff.
    const at = map && length > 0 && !m.intent ? map[Math.floor((((car.s ?? 0) % length + length) % length) / length * map.length) % map.length] : 1;
    // A store well above target (a harvest-heavy track) spreads the surplus down the straights too.
    const surplus = m.target === null ? 0 : clamp01((soc - m.target - 0.1) / 0.3), floor = m.floor + (1 - m.floor) * 0.7 * surplus;
    const where = floor + (1 - floor) * at;
    const level = m.target === null ? 1 : Math.max(0.15, Math.min(1, 0.6 + 1.6 * (soc - m.target)));
    // (power comes in over the first 12 m/s above the mode's floor speed, so the kick never lands on a wheelspinning exit)
    const ease = m.target === null ? 1 : clamp01((v - m.from) / 12 + 0.25);
    deploy = m.kw * 1000 * throttle * where * level * ease * clamp01(soc / 0.04);
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
 * same-class rival, spend what is left over the final laps, build when low and
 * in clean air (until there is a real reserve again), otherwise balanced.
 */
export function aiDeployMode(car, gapAhead, lapsLeft, qualifying = false, gapBehind = Infinity) {
  const h = car.hybrid; if (!h || !h.auto) return;
  const soc = h.energy / HYBRID.capacity;
  // Qualifying: charge up on the out lap, then everything on the timed laps.
  if (qualifying) { h.mode = qualifying === 'out' ? 'build' : 'qual'; return; }
  const fight = gapAhead < 40 || gapBehind < 25;
  // A full store harvests nothing: spend it. Near the flag the charge is only worth what it buys before the line.
  const spend = (lapsLeft <= 1 && soc > 0.08) || (lapsLeft <= 2 && soc > 0.45) || soc > 0.9;
  const low = soc < (h.mode === 'build' ? 0.35 : 0.2);
  h.mode = spend || (fight && soc > 0.3) ? 'attack'
    : low && !fight && lapsLeft > 1 ? 'build'
    : 'balanced';
}
