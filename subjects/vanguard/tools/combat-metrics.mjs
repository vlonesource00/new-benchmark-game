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
  return { clean, unassisted, progressRatio, retained, cleanPass, cleanDefence, cleanFollowing,
    success: cleanPass || cleanDefence || cleanFollowing };
}
