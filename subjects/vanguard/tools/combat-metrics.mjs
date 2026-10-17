/** Independent of any driver's intent or self-reported pass statistics. */
export function bodyClearance(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (dx * dx + dz * dz > 100) return Math.hypot(dx, dz) - 5;
  const ar = [Math.cos(a.yaw), -Math.sin(a.yaw)], af = [Math.sin(a.yaw), Math.cos(a.yaw)],
    br = [Math.cos(b.yaw), -Math.sin(b.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
  let clearance = -Infinity;
  for (const axis of [ar, af, br, bf]) {
    const dot = v => Math.abs(axis[0] * v[0] + axis[1] * v[1]);
    const radius = 0.98 * (dot(ar) + dot(br)) + 2.28 * (dot(af) + dot(bf));
    clearance = Math.max(clearance, Math.abs(dx * axis[0] + dz * axis[1]) - radius);
  }
  return clearance;
}

/** Called from the real collision event, after separation but before impulse.
 * The separating axis with minimum residual overlap is the collision normal.
 * This scorer does not use the driver's own rubbing classifier. */
export function classifyContact(a, b, closing) {
  const ar = [Math.cos(a.yaw), -Math.sin(a.yaw)], af = [Math.sin(a.yaw), Math.cos(a.yaw)],
    br = [Math.cos(b.yaw), -Math.sin(b.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
  let depth = Infinity, longitudinal = 1;
  for (const axis of [ar, af, br, bf]) {
    const dot = q => Math.abs(axis[0] * q[0] + axis[1] * q[1]),
      overlap = 0.98 * (dot(ar) + dot(br)) + 2.28 * (dot(af) + dot(bf)) -
        Math.abs((b.x - a.x) * axis[0] + (b.z - a.z) * axis[1]);
    if (overlap < depth) { depth = overlap; longitudinal = dot(af); }
  }
  const heading = Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw)));
  const forward = (b.x - a.x) * af[0] + (b.z - a.z) * af[1];
  return { rub: longitudinal < 0.45 && closing <= 2.5 && heading < 0.18,
    nose: longitudinal > 0.65 && forward >= 0, rear: longitudinal > 0.65 && forward < 0,
    severe: closing > 6, longitudinal, closing, heading };
}

export function scoreCombat(result) {
  const healthy = c => [c.damage, c.offtrack, c.progress].every(Number.isFinite) &&
    c.damage <= 1e-8 && c.offtrack <= 1e-8 && !c.teleported && !c.retired && c.errors === 0;
  const clean = healthy(result.ego) && result.contacts === 0 && result.touchSeconds <= 1e-8;
  const unassisted = healthy(result.rival);
  const progressRatio = result.ego.progress / Math.max(1, result.rival.progress);
  const retained = result.clearSeconds >= 4 && result.finalGap < -5.6;
  const cleanPass = result.mode === 'attack' && retained && clean && unassisted;
  const cleanDefence = result.mode === 'defend' && retained && clean && unassisted && progressRatio >= 0.95;
  const cleanFollowing = result.mode === 'brake' && clean && unassisted && progressRatio >= 0.8;
  const legal = c => [c.damage, c.offtrack, c.progress].every(Number.isFinite) &&
    c.offtrack <= 1e-8 && !c.teleported && !c.retired && c.errors === 0;
  // A short encounter gets a one-percentage-point damage allowance. The full
  // 20-lap test, rather than extrapolating these repeated drills, enforces 20%.
  const withinBudget = result.ego.damage <= (result.damageCap ?? 0.01) && result.rival.damage <= (result.damageCap ?? 0.01),
    mildContact = result.contacts === 0 || (result.contactKinds && result.contactKinds.rubs === result.contacts),
    racing = legal(result.ego) && legal(result.rival) && withinBudget && mildContact && result.severe === 0,
    racingPass = result.mode === 'attack' && retained && racing,
    racingDefence = result.mode === 'defend' && retained && racing && progressRatio >= 0.95,
    racingFollowing = result.mode === 'brake' && racing && progressRatio >= 0.8;
  return { clean, unassisted, progressRatio, retained, cleanPass, cleanDefence, cleanFollowing,
    withinBudget, racingPass, racingDefence, racingFollowing,
    success: racingPass || racingDefence || racingFollowing };
}
