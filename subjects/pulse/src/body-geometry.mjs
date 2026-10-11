// Read-only diagnostics matching the game's 0.98 x 2.28 m collision boxes.
// These measurements neither choose a route nor change controls.
export function bodyClearance(ego, rival) {
  const dx = rival.x - ego.x, dz = rival.z - ego.z;
  const right = a => [Math.cos(a), -Math.sin(a)], front = a => [Math.sin(a), Math.cos(a)];
  const ar = right(ego.yaw), af = front(ego.yaw), br = right(rival.yaw), bf = front(rival.yaw);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const clearance = axis => Math.abs(dx * axis[0] + dz * axis[1])
    - .98 * (Math.abs(dot(axis, ar)) + Math.abs(dot(axis, br)))
    - 2.28 * (Math.abs(dot(axis, af)) + Math.abs(dot(axis, bf)));
  const axes = [ar, af, br, bf].map(clearance);
  return { id: rival.id, forward: dx * af[0] + dz * af[1], lateral: dx * ar[0] + dz * ar[1],
    frontGap: axes[1], sideGap: axes[0], boxGap: Math.max(...axes),
    intersects: Math.max(...axes) < 0, distance: Math.hypot(dx, dz) };
}

export function nearbyFront(row, maxDistance = 50) {
  return row.cars.filter(c => c.id !== row.before.id && !c.ghost)
    .map(c => bodyClearance(row.before, c)).filter(c => c.forward > 0 && c.distance < maxDistance)
    .sort((a, b) => a.forward - b.forward)[0] ?? null;
}

export function lineReview(rows, halfWidth) {
  const excursions = [], closures = [], sides = new Map(); let current = null;
  let frontBlockedSeconds = 0, clearFrontCorrectionSeconds = 0, maxSteerRate = 0, pedalReversals = 0;
  let previous = null, previousEffort = 0;
  for (const row of rows) {
    const dt = previous ? Math.max(0, row.time - previous.time) : row.dt;
    const front = nearbyFront(row), outside = Math.abs(row.before.lateral) > row.legalTrackLimit;
    if (outside && !current) {
      const nearest = row.cars.filter(c => c.id !== row.before.id).map(c => bodyClearance(row.before, c)).sort((a, b) => a.distance - b.distance)[0];
      current = { start: row.time, peakOffset: Math.abs(row.before.lateral), nearestAtStart: nearest,
        frontAtStart: front, correctionAtStart: row.trafficCorrection ?? null, speedAtStart: row.before.speed * 3.6 };
    }
    if (current) current.peakOffset = Math.max(current.peakOffset, Math.abs(row.before.lateral));
    if (current && (!outside || row === rows.at(-1))) { current.end = row.time; excursions.push(current); current = null; }
    if (front && front.frontGap < 12 && front.sideGap < 0) frontBlockedSeconds += dt;
    if (!front && row.trafficCorrection && Math.abs(row.trafficCorrection[0]) > .1) clearFrontCorrectionSeconds += dt;
    for (const car of row.cars) if (car.id !== row.before.id && !car.ghost) {
      const body = bodyClearance(row.before, car), old = sides.get(car.id);
      if (body.forward > 0 && body.forward < 35 && body.sideGap <= 0 && old && !old.blocked
        && Number.isFinite(old.lastOpen) && row.time - old.lastOpen < 2)
        closures.push({ time: row.time, rival: car.id, forward: body.forward, sideGap: body.sideGap,
          previousSideGap: old.sideGap, egoOffset: row.before.lateral, rivalOffset: car.lateral });
      sides.set(car.id, { ...body, time: row.time, blocked: body.sideGap <= 0,
        lastOpen: body.sideGap > .2 ? row.time : old?.lastOpen });
    }
    if (previous && dt > 0) maxSteerRate = Math.max(maxSteerRate, Math.abs(row.executed.steer - previous.executed.steer) / dt);
    const effort = row.executed.throttle - row.executed.brake, sign = effort > .1 ? 1 : effort < -.1 ? -1 : 0;
    if (sign && previousEffort && sign !== previousEffort) pedalReversals++;
    if (sign) previousEffort = sign;
    previous = row;
  }
  return { excursions, closures, frontBlockedSeconds, clearFrontCorrectionSeconds, maxSteerRate, pedalReversals,
    asphaltHalfWidth: halfWidth,
    scope: 'Observed body geometry and sampled trace, not a collision forecast or executable passing lane.' };
}
