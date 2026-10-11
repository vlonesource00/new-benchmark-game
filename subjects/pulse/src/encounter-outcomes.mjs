// Selection of offline experiments, never a runtime route or steering rule.
export const ENCOUNTER_OBJECTIVE = Object.freeze({
  version: 'pulse-encounter-outcome-v1',
  damageBudget: .03,
  damageSeconds: 40,
  tyreSeconds: 20,
  controlSeconds: .002,
  retainedSeconds: 1.5,
  minimumGainSeconds: .05
});

export function timeAtDistance(rows, distance) {
  if (!Number.isFinite(distance) || distance <= 0 || !rows.length) throw Error('Invalid encounter checkpoint');
  const origin = rows[0].before.progress;
  for (const row of rows) {
    const from = row.before.progress - origin, to = row.post.progress - origin;
    if (to >= distance && to > from) {
      const dt = row.substeps.reduce((sum, step) => sum + step.dt, 0);
      return row.time + Math.max(0, Math.min(1, (distance - from) / (to - from))) * dt;
    }
  }
  return null;
}

export function damageIsVerifiedRub(rows, budget = .03) {
  let expected = rows[0]?.before.damage;
  if (!Number.isFinite(expected) || expected > 1e-8) return false;
  for (const row of rows) {
    const before = row.before.damage, after = row.post.damage;
    if (!Number.isFinite(before) || !Number.isFinite(after) || Math.abs(before - expected) > 1e-6
      || after < before - 1e-8 || after > budget || row.before.ghost || row.post.ghost) return false;
    const added = Math.max(0, after - before);
    if (added > 1e-8) {
      if (added > .01 || !row.contactEvidence?.length) return false;
      let accounted = 0;
      for (const c of row.contactEvidence) {
        const values = ['closing', 'forward', 'lateral', 'yawDifference', 'selfDamageAdded', 'rivalDamageAdded'].map(k => c[k]);
        if (!values.every(Number.isFinite) || !c.activeRival || c.closing < 0 || c.closing > 6
          || Math.abs(c.forward) > 4.5 || Math.abs(c.lateral) < 1.5 || Math.abs(c.yawDifference) > .25
          || Math.abs(c.selfDamageAdded - c.rivalDamageAdded) > 1e-6) return false;
        accounted += c.selfDamageAdded;
      }
      if (Math.abs(accounted - added) > 1e-6) return false;
    }
    expected = after;
  }
  return true;
}

export function encounterOutcome(result, { seconds, checkpointDistance = 600, objective = ENCOUNTER_OBJECTIVE } = {}) {
  const { rows, summary: s } = result;
  if (!rows?.length || !Number.isFinite(seconds) || seconds <= 0) throw Error('Incomplete encounter');
  const failures = [];
  const numeric = ['seconds', 'trackLimitSeconds', 'cumulativeDamage', 'incidents', 'severe', 'minFuel', 'missingRows', 'expertRows', 'expertActuatorRows'];
  if (!numeric.every(k => Number.isFinite(s[k]))) failures.push('missing/nonfinite-summary');
  if (s.endedEarly || s.seconds < seconds - 1e-6 || s.dq) failures.push('incomplete/disqualified');
  if (s.trackLimitSeconds > 0) failures.push('illegal-track-use');
  if (s.severe > 0) failures.push('severe-contact-in-field');
  if (s.minFuel < 1) failures.push('fuel-starvation');
  if (s.missingRows || s.expertRows || s.expertActuatorRows) failures.push('missing-sensors/expert-assistance');
  if (s.cumulativeDamage > objective.damageBudget || !damageIsVerifiedRub(rows, objective.damageBudget)) failures.push('unverified/excess-damage-or-rescue');
  const checkpointSeconds = timeAtDistance(rows, checkpointDistance);
  if (checkpointSeconds === null) failures.push('checkpoint-not-reached');
  const tyreStart = rows[0].before.tyres, tyreEnd = rows.at(-1).post.tyres;
  if (tyreStart?.length !== 4 || tyreEnd?.length !== 4 || ![...tyreStart, ...tyreEnd].every(t => Number.isFinite(t.wear))) failures.push('missing-tyre-state');
  const maxWearSpent = failures.includes('missing-tyre-state') ? null : Math.max(0, ...tyreEnd.map((t, i) => t.wear - tyreStart[i].wear));
  let steeringVariation = 0, previous = rows[0].substeps[0].controls.steer;
  for (const row of rows) for (const step of row.substeps) {
    if (![step.controls.steer, step.controls.throttle, step.controls.brake, step.dt].every(Number.isFinite)) {
      failures.push('nonfinite-controls'); continue;
    }
    steeringVariation += Math.abs(step.controls.steer - previous); previous = step.controls.steer;
  }
  // Clearance is checked again at the last shared pre-step snapshot. A briefly
  // retained pass which was subsequently lost cannot earn a training bonus.
  const last = rows.at(-1), retained = (s.encounters ?? []).filter(e => {
    const rival = last.cars.find(c => c.id === e.id);
    return e.kind !== 'hazard' && !e.invalidated && Number.isFinite(e.retained)
      && e.retained <= last.time && rival && last.before.progress - rival.progress > 5.5;
  });
  const admissible = failures.length === 0;
  const costSeconds = admissible ? checkpointSeconds + objective.damageSeconds * s.cumulativeDamage
    + objective.tyreSeconds * maxWearSpent + objective.controlSeconds * steeringVariation
    - objective.retainedSeconds * retained.length : null;
  return { admissible, failures: [...new Set(failures)], costSeconds, checkpointDistance, checkpointSeconds,
    retainedAtEnd: retained.length, retainedIds: retained.map(e => e.id), cumulativeDamage: s.cumulativeDamage,
    maxWearSpent, steeringVariation, progress: s.progress,
    scope: 'Short encounter selection cost, not measured race time, qualifying superiority or a learned strategy.' };
}
