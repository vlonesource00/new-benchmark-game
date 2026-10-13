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

// User allowance (2026-10-12): up to 10% damage over a full race is valid.
// A 70 s generated encounter keeps the official 3% cap (about a third of the
// race budget, since encounters are dense combat) but rubs need not be
// side-verified. Any single hit above
// 1%, a rescue/ghost, or a severe contact involving PULSE still fails; a
// severe crash between two rivals is their incident, not PULSE's.
export const RACE_DAMAGE_OBJECTIVE = Object.freeze({ ...ENCOUNTER_OBJECTIVE,
  version: 'pulse-encounter-outcome-race10-v2', damageBudget: .03, rubVerification: false, severeScope: 'self' });

// User review (2026-10-13): judge a contact by who caused it and what it cost,
// not by its damage alone. A single hit above 1% no longer fails by itself; it
// fails when PULSE caused it AND the rival paid for it (lost more than
// CONTACT_RIVAL_LOSS of speed within 1.5 s, or was pushed off the track), or
// when one hit alone exceeds 2.5%. Budget, severe (> 6 m/s) contacts, rescues
// and ghosts are unchanged.
export const RACE_CONTACT_OBJECTIVE = Object.freeze({ ...RACE_DAMAGE_OBJECTIVE,
  version: 'pulse-encounter-outcome-race10-contact-v3', contactJudgement: 'consequence', heavyHit: .025 });
const CONTACT_RIVAL_LOSS = 15 / 3.6, CONTACT_AFTER = 1.5, CONTACT_BEFORE = .25;

/** Who caused the contact in row i and what it cost the rival (rows need the cars' snapshots). */
export function judgeContact(rows, i, evidence) {
  const row = rows[i], self = row.before.id, car = (r, id) => r.cars?.find(c => c.id === id);
  let k = i; while (k > 0 && row.time - rows[k].time < CONTACT_BEFORE) k--;
  const me0 = car(rows[k], self), me1 = car(row, self), rv0 = car(rows[k], evidence.rival), rv1 = car(row, evidence.rival);
  if (!me0 || !me1 || !rv0 || !rv1 || row.time <= rows[k].time) return { caused: true, costly: true, reason: 'unobserved' };
  const dt = row.time - rows[k].time, side = Math.sign(rv1.lateral - me1.lateral) || 1;
  const meToward = (me1.lateral - me0.lateral) / dt * side, rivalToward = -(rv1.lateral - rv0.lateral) / dt * side;
  // Running into a car ahead is ours; side contact belongs to whoever moved across more.
  const rearEnd = evidence.forward > 2.5 && Math.abs(evidence.lateral) < 1.5;
  const caused = rearEnd || meToward > rivalToward;
  let lost = 0, offtrack = false;
  for (let j = i; j < rows.length && rows[j].time - row.time <= CONTACT_AFTER; j++) {
    const r = car(rows[j], evidence.rival); if (!r) continue;
    lost = Math.max(lost, rv1.speed - r.speed); offtrack ||= !!r.gameOfftrack && !rv1.gameOfftrack;
  }
  return { caused, costly: lost > CONTACT_RIVAL_LOSS || offtrack, rearEnd, meToward, rivalToward, rivalSpeedLost: lost, offtrack };
}

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

export function damageIsVerifiedRub(rows, budget = .03, verifyContacts = true, judgement = null) {
  let expected = rows[0]?.before.damage;
  if (!Number.isFinite(expected) || expected > 1e-8) return false;
  for (const row of rows) {
    const before = row.before.damage, after = row.post.damage;
    if (!Number.isFinite(before) || !Number.isFinite(after) || Math.abs(before - expected) > 1e-6
      || after < before - 1e-8 || after > budget || row.before.ghost || row.post.ghost) return false;
    const added = Math.max(0, after - before);
    if (added > 1e-8) {
      if (added > .01) {
        if (!judgement || added > judgement.heavyHit) return false;
        const hits = (row.contactEvidence ?? []).filter(c => c.selfDamageAdded > 1e-8);
        if (!hits.length || hits.some(c => { const j = judgeContact(rows, rows.indexOf(row), c); return j.caused && j.costly; })) return false;
      }
      if (!verifyContacts) { expected = after; continue; }
      if (!row.contactEvidence?.length) return false;
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
  if ((objective.severeScope === 'self' ? s.selfSevere ?? s.severe : s.severe) > 0) failures.push('severe-contact-in-field');
  if (s.minFuel < 1) failures.push('fuel-starvation');
  if (s.missingRows || s.expertRows || s.expertActuatorRows) failures.push('missing-sensors/expert-assistance');
  if (s.cumulativeDamage > objective.damageBudget || !damageIsVerifiedRub(rows, objective.damageBudget, objective.rubVerification !== false,
    objective.contactJudgement === 'consequence' ? objective : null)) failures.push('unverified/excess-damage-or-rescue');
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
