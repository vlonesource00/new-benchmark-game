// Condensed, reproducible analysis of the canonical campaign JSON traces.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const directory = resolve(args.dir ?? 'artifacts/triad-v2-final');
const solo = JSON.parse(readFileSync(resolve('artifacts/triad-v2-solo.json')));
const speedAt = station => solo.speedBins[Math.floor(((station % solo.trackLength) + solo.trackLength) %
  solo.trackLength / solo.binWidth) % solo.speedBins.length];
const wrap = distance => ((distance + solo.trackLength * 1.5) % solo.trackLength) - solo.trackLength * 0.5;
const bucket = phase => phase === 'FOLLOW' ? 'FOLLOW' : phase === 'DEFEND_COMMITTED' ? 'DEFEND' :
  phase.startsWith('ATTACK') || phase === 'PRE_OVERLAP' ? 'ATTACK' : 'OTHER';
const totals = { heats: 0, offtrack: 0, spins: 0, contactEvents: 0, damage: 0,
  attacks: 0, overlaps: 0, completedPhases: 0, completedPasses: 0, retainedPasses: 0,
  aborts: 0, capEvents: 0, capSeconds: 0, capBrakeSeconds: 0, concedeSeconds: 0,
  capClasses: { necessary: 0, conservative: 0, unnecessary: 0 },
  traffic: Object.fromEntries(['FOLLOW', 'ATTACK', 'DEFEND', 'SIDE_BY_SIDE', 'OTHER']
    .map(name => [name, { actual: 0, soloEquivalent: 0, delta: 0 }])) };
const heats = [];
const capAudit = [];
for (const laps of [3, 5]) for (let grid = 1; grid <= 6; grid++) {
  const record = JSON.parse(readFileSync(resolve(directory, `${laps}lap-grid${grid}.json`)));
  const nova = record.rows.find(row => row.id === 'nova');
  totals.heats++;
  totals.offtrack += nova.offtrackSec;
  totals.spins += nova.spinEvents;
  const novaContacts = record.nova.contacts.filter(contact => contact.novaImpact > 0.05);
  totals.contactEvents += novaContacts.length;
  totals.damage += nova.damage;
  totals.attacks += record.nova.attackInitiations;
  totals.overlaps += record.nova.overlaps ?? 0;
  totals.completedPhases += record.nova.completedPhases ?? 0;
  totals.completedPasses += record.nova.passes.length;
  totals.retainedPasses += record.nova.passes.filter(pass => pass.retained100m).length;
  totals.aborts += record.nova.aborts;
  totals.capEvents += record.nova.caps.length;
  totals.capSeconds += record.nova.capSeconds;
  totals.capBrakeSeconds += record.nova.capBrakeSeconds;
  totals.concedeSeconds += record.nova.concedeSeconds;
  for (const cap of record.nova.caps) {
    const state = cap.startState;
    const close = state.rivals?.some(rival => rival.ds > -6 && rival.ds < 18 && Math.abs(rival.dq) < 4.2);
    const predicted = state.sweptRisk >= 0.18 && state.sweptTTC !== null && state.sweptTTC <= 2;
    const classification = predicted || (close && state.capReason !== 'CROSSING_APEX') ||
      state.capReason === 'PREDICTED_EDGE_CROSSING' ? 'necessary' : close ? 'conservative' : 'unnecessary';
    totals.capClasses[classification]++;
    const nextContacts = novaContacts.filter(contact => contact.t >= cap.start && contact.t <= cap.start + 3).length;
    const nextPasses = record.nova.passes.filter(pass => pass.t >= cap.start && pass.t <= cap.start + 3).length;
    capAudit.push({ laps, grid, start: cap.start, duration: cap.duration,
      reason: state.capReason, classification, brakeSeconds: cap.brakeSeconds,
      ds: state.rivals?.[0]?.ds, dq: state.rivals?.[0]?.dq,
      speed: state.speed, cap: state.cap, risk: state.sweptRisk,
      ttc: state.sweptTTC, curvature: state.refKappa,
      upcomingCurvature: state.upcomingKappa,
      clearance: state.sweptClearance, intervals: state.freeIntervals,
      availableCorridors: state.availableCorridors,
      topology: state.topology, outcome: { phase: cap.endState?.phase ?? null,
        novaContactsWithin3s: nextContacts, passesWithin3s: nextPasses } });
  }
  const samples = record.nova.samples;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const elapsed = b.t - a.t;
    if (elapsed <= 0 || elapsed > 0.2) continue;
    const distance = wrap(b.s - a.s);
    if (distance < -0.1 || distance > 20) continue;
    const group = a.rivals?.some(rival => Math.abs(rival.ds) < 5.2) ?
      'SIDE_BY_SIDE' : bucket(a.phase);
    const item = totals.traffic[group];
    item.actual += elapsed;
    item.soloEquivalent += distance / Math.max(5, speedAt(a.s + distance / 2));
  }
  heats.push({ laps, grid, order: record.grid, best: nova.bestLap,
    finish: nova.finishTime, position: nova.position, offtrack: nova.offtrackSec,
    spins: nova.spinEvents, damage: nova.damage, contactEvents: novaContacts.length,
    attacks: record.nova.attackInitiations, overlaps: record.nova.overlaps ?? 0,
    passes: record.nova.passes.length,
    retained: record.nova.passes.filter(pass => pass.retained100m).length,
    aborts: record.nova.aborts, capEvents: record.nova.caps.length,
    capSeconds: record.nova.capSeconds, capBrakeSeconds: record.nova.capBrakeSeconds,
    errors: nova.errors });
}
for (const item of Object.values(totals.traffic)) item.delta = item.actual - item.soloEquivalent;
const output = resolve(directory, 'analysis.json');
writeFileSync(output, JSON.stringify({ solo: { bestLap: solo.bestLap, offtrack: solo.offtrack },
  totals, heats, capAudit }, null, 2));
console.log(JSON.stringify({ output, totals, heats }));
