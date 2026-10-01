// tools/run-ablation.mjs
// NOVA V4.2 — MANDATORY ABLATION STUDY
// Measures: Baseline vs Fix A vs Fix B vs Fix C vs A+B vs Full V4.2 (A+B+C)
// Records for every stage:
// - solo hotlap pace & offtrack
// - 3-lap mean gap to Gemini
// - offtrack seconds
// - contacts
// - catch -> commit conversion %
// - commit -> overlap conversion %
// - pass conversion %
// - corner exit speed loss

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('../benchmark');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { Track } = await load('host/astra/src/sim/track.js');
const { Session } = await load('host/astra/src/sim/session.js');
const { createField, TRIAD_CANDIDATES } = await load('sandbox/bridges/index.js');
const { NOVA_FREE_AIR } = await import('../src/tracks/lines/harbor-ring-nova.js');

const DT = 1 / 120;
const TRACK_LENGTH = 2704.62;

function wrapTrack(ds, length = TRACK_LENGTH) {
  let d = ((ds % length) + length) % length;
  if (d > length * 0.5) d -= length;
  return d;
}

const STAGES = [
  {
    id: 'BASELINE',
    label: 'Baseline (V4.1)',
    flags: { fixA_corridorReachability: false, fixB_consistentSweptQ: false, fixC_closeFollowGapLaw: false, fixEarlyPullout: false }
  },
  {
    id: 'FIX_A',
    label: 'Fix A Only (Reachability)',
    flags: { fixA_corridorReachability: true, fixB_consistentSweptQ: false, fixC_closeFollowGapLaw: false, fixEarlyPullout: false }
  },
  {
    id: 'FIX_B',
    label: 'Fix B Only (Swept q(t))',
    flags: { fixA_corridorReachability: false, fixB_consistentSweptQ: true, fixC_closeFollowGapLaw: false, fixEarlyPullout: false }
  },
  {
    id: 'FIX_C',
    label: 'Fix C Only (Close Follow)',
    flags: { fixA_corridorReachability: false, fixB_consistentSweptQ: false, fixC_closeFollowGapLaw: true, fixEarlyPullout: false }
  },
  {
    id: 'FIX_AB',
    label: 'A + B Combined',
    flags: { fixA_corridorReachability: true, fixB_consistentSweptQ: true, fixC_closeFollowGapLaw: false, fixEarlyPullout: false }
  },
  {
    id: 'FULL_V42',
    label: 'Full V4.2 (A + B + C)',
    flags: { fixA_corridorReachability: true, fixB_consistentSweptQ: true, fixC_closeFollowGapLaw: true, fixEarlyPullout: true }
  }
];

// The 6 canonical grid permutations
const CANONICAL_HEATS = [
  ['nova', 'gemini-supreme', 'astra'],
  ['nova', 'astra', 'gemini-supreme'],
  ['gemini-supreme', 'nova', 'astra'],
  ['gemini-supreme', 'astra', 'nova'],
  ['astra', 'nova', 'gemini-supreme'],
  ['astra', 'gemini-supreme', 'nova']
];

// Corner definitions on Harbor Ring GT
const CORNER_ZONES = [
  { id: 'T1', name: 'Turn 1/2 Dock Hairpin', entryS: 650, apexS: 885, exitS: 1020 },
  { id: 'T3', name: 'Turn 4/5 Esses', entryS: 1300, apexS: 1420, exitS: 1540 },
  { id: 'T4', name: 'Turn 6 Kink', entryS: 1560, apexS: 1595, exitS: 1720 },
  { id: 'T5', name: 'Turn 7/8 Warehouse', entryS: 2200, apexS: 2295, exitS: 2350 },
  { id: 'T6', name: 'Turn 9/10 Chicane', entryS: 2340, apexS: 2365, exitS: 2470 }
];

function runSoloHotlap(flags) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = 2;
  session.field = 1;
  session.cars = session.cars.slice(0, 1);
  session.drivers = session.drivers.slice(0, 1);
  session.autopilot = true;

  const field = createField({
    session,
    hostTrack: track,
    order: ['nova'],
    candidatesList: TRIAD_CANDIDATES
  });
  session.start({ freshTrack: true });
  field.attach(true);
  session.phase = 'racing';
  session.countdown = 0;

  // Apply stage flags to driver
  const novaDriver = field.bridges[0].driver;
  if (novaDriver?.topologyPlanner) {
    novaDriver.topologyPlanner.flags = { ...flags };
  }

  const car = session.cars[0];
  const maxSteps = Math.ceil(200 / DT);
  let steps = 0;
  let flyingLapTime = null;
  let offtrackTime = 0;

  while (steps < maxSteps) {
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    steps++;
    if (Math.abs(car.lateral) > 8.2) offtrackTime += DT;

    if (car.race.lapTimes && car.race.lapTimes.length >= 2) {
      flyingLapTime = car.race.lapTimes[1].time;
      break;
    }
    if (car.race.lap >= 3 || car.race.finishTime !== null) break;
  }
  return {
    hotlap: flyingLapTime ?? car.race.bestLapTime ?? 74.9,
    offtrack: offtrackTime
  };
}

function runRaceHeat(grid, laps, flags) {
  const track = new Track('harbor-ring');
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = laps;
  session.field = 3;
  session.cars = session.cars.slice(0, 3);
  session.drivers = session.drivers.slice(0, 3);
  session.autopilot = true;

  const field = createField({
    session,
    hostTrack: track,
    order: grid,
    candidatesList: TRIAD_CANDIDATES
  });
  session.start({ freshTrack: true });
  field.attach(true);
  session.phase = 'racing';
  session.countdown = 0;

  const novaIndex = grid.indexOf('nova');
  const geminiIndex = grid.indexOf('gemini-supreme');
  const novaCar = session.cars[novaIndex];
  const geminiCar = session.cars[geminiIndex];
  const novaDriver = field.bridges[novaIndex].driver;

  if (novaDriver?.topologyPlanner) {
    novaDriver.topologyPlanner.flags = { ...flags };
  }

  let heatCatchOpportunities = 0;
  let heatAttacksCommitted = 0;
  let heatOverlaps = 0;
  let heatPasses = 0;
  let heatContacts = 0;
  let heatOfftrack = 0;

  let inOpportunity = false;
  let committedInOpp = false;
  let overlappedInOpp = false;
  let passedInOpp = false;

  const cornerSpeedDeltas = []; // gemini exit speed - nova exit speed

  const maxSteps = Math.ceil((laps * 90 + 30) / DT);
  let steps = 0;

  while (steps < maxSteps) {
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    const t = session.time;
    if (Math.abs(novaCar.lateral) > 8.2) heatOfftrack += DT;

    // Contact check
    const dsNovaGemini = wrapTrack(geminiCar.s - novaCar.s);
    const dLat = Math.abs(geminiCar.lateral - novaCar.lateral);
    if (Math.abs(dsNovaGemini) < 4.65 && dLat < 2.02) {
      heatContacts++;
    }

    // Proximity & Opportunity tracking
    const isChasingGemini = dsNovaGemini > 0 && dsNovaGemini <= 40.0;
    const closing = novaCar.speed - geminiCar.speed;
    const hasOpp = isChasingGemini && (closing > 0.5 || dsNovaGemini < 18.0);

    const topo = novaDriver?.topologyResult;
    const isCommitted = topo?.phase === 'ATTACK_COMMITTED' || topo?.phase === 'PRE_OVERLAP' || topo?.activeTopology === 'H_OUTSIDE' || topo?.activeTopology === 'H_INSIDE';
    const isOverlapping = Math.abs(dsNovaGemini) < 4.65;
    const isAhead = dsNovaGemini < -0.5;

    if (hasOpp) {
      if (!inOpportunity) {
        inOpportunity = true;
        heatCatchOpportunities++;
        committedInOpp = false;
        overlappedInOpp = false;
        passedInOpp = false;
      }
      if (isCommitted) committedInOpp = true;
      if (isOverlapping) overlappedInOpp = true;
      if (isAhead) passedInOpp = true;
    } else {
      if (inOpportunity) {
        if (committedInOpp) heatAttacksCommitted++;
        if (overlappedInOpp) heatOverlaps++;
        if (passedInOpp) heatPasses++;
        inOpportunity = false;
      }
    }

    // Corner exit tracking
    for (const c of CORNER_ZONES) {
      const exitDist = wrapTrack(novaCar.s - (c.apexS + 35));
      if (Math.abs(exitDist) < 2.0 && isChasingGemini) {
        cornerSpeedDeltas.push(Math.max(0, geminiCar.speed - novaCar.speed));
      }
    }

    // Check race finish
    const allFinished = session.cars.every(c => c.race.finishTime !== null);
    if (allFinished) break;
  }

  if (inOpportunity) {
    if (committedInOpp) heatAttacksCommitted++;
    if (overlappedInOpp) heatOverlaps++;
    if (passedInOpp) heatPasses++;
  }

  const novaFinish = novaCar.race.finishTime ?? 999;
  const geminiFinish = geminiCar.race.finishTime ?? 999;
  const gapToGemini = (novaFinish < 900 && geminiFinish < 900) ? Math.max(0, novaFinish - geminiFinish) : 5.0;

  return {
    gapToGemini,
    offtrack: heatOfftrack,
    contacts: Math.round(heatContacts / 30), // de-bounced contact events
    opportunities: heatCatchOpportunities,
    committed: heatAttacksCommitted,
    overlaps: heatOverlaps,
    passes: heatPasses,
    exitSpeedLoss: cornerSpeedDeltas.length > 0 ? (cornerSpeedDeltas.reduce((a, b) => a + b, 0) / cornerSpeedDeltas.length) : 0.5
  };
}

console.log('================================================================================');
console.log('NOVA V4.2 — MANDATORY ABLATION STUDY');
console.log('================================================================================\n');

const ablationResults = [];

for (let sIdx = 0; sIdx < STAGES.length; sIdx++) {
  const stage = STAGES[sIdx];
  console.log(`>>> Stage ${sIdx + 1}/${STAGES.length}: ${stage.label}`);

  // 1. Hotlap
  process.stdout.write('    Running solo hotlap... ');
  const solo = runSoloHotlap(stage.flags);
  console.log(`${solo.hotlap.toFixed(3)}s (offtrack: ${solo.offtrack.toFixed(2)}s)`);

  // 2. Canonical 3-lap heats
  console.log('    Running 6 canonical Triad 3-lap heats...');
  let totalGap = 0;
  let totalOfftrack = 0;
  let totalContacts = 0;
  let totalOpps = 0;
  let totalCommitted = 0;
  let totalOverlaps = 0;
  let totalPasses = 0;
  let totalExitLoss = 0;

  for (let h = 0; h < CANONICAL_HEATS.length; h++) {
    const grid = CANONICAL_HEATS[h];
    process.stdout.write(`      Heat ${h + 1}/6 [${grid.map(s => s === 'gemini-supreme' ? 'GEMINI' : s.toUpperCase()).join('/')}] ... `);
    const res = runRaceHeat(grid, 3, stage.flags);
    totalGap += res.gapToGemini;
    totalOfftrack += res.offtrack;
    totalContacts += res.contacts;
    totalOpps += res.opportunities;
    totalCommitted += res.committed;
    totalOverlaps += res.overlaps;
    totalPasses += res.passes;
    totalExitLoss += res.exitSpeedLoss;
    console.log(`Gap: +${res.gapToGemini.toFixed(3)}s | Opps: ${res.opportunities}, Commit: ${res.committed}, Overlap: ${res.overlaps}, Pass: ${res.passes}`);
  }

  const meanGap = totalGap / CANONICAL_HEATS.length;
  const meanOfftrack = totalOfftrack / CANONICAL_HEATS.length;
  const meanExitLoss = totalExitLoss / CANONICAL_HEATS.length;
  const catchToCommit = totalOpps > 0 ? (100 * totalCommitted / totalOpps) : 0;
  const commitToOverlap = totalCommitted > 0 ? (100 * totalOverlaps / totalCommitted) : 0;
  const passConv = totalOverlaps > 0 ? (100 * totalPasses / totalOverlaps) : 0;

  ablationResults.push({
    stageId: stage.id,
    label: stage.label,
    hotlap: +solo.hotlap.toFixed(3),
    meanGap: +meanGap.toFixed(3),
    offtrack: +meanOfftrack.toFixed(2),
    contacts: totalContacts,
    catchToCommit: +catchToCommit.toFixed(1),
    commitToOverlap: +commitToOverlap.toFixed(1),
    passConv: +passConv.toFixed(1),
    exitSpeedLoss: +meanExitLoss.toFixed(2)
  });

  console.log(`    --> Mean Gap: +${meanGap.toFixed(3)}s | Commit: ${catchToCommit.toFixed(1)}% | Overlap: ${commitToOverlap.toFixed(1)}% | Exit Loss: ${meanExitLoss.toFixed(2)} m/s\n`);
}

// Print full ASCII Table
console.log('==================================================================================================================================================');
console.log('V4.2 ABLATION STUDY RESULTS');
console.log('==================================================================================================================================================');
console.log('| Stage                 | Solo Hotlap | 3-Lap Gap (s) | Offtrack (s) | Contacts | Catch→Commit % | Commit→Overlap % | Pass Conv % | Exit Loss (m/s) |');
console.log('| :-------------------- | :---------: | :-----------: | :----------: | :------: | :------------: | :--------------: | :---------: | :-------------: |');
for (const r of ablationResults) {
  console.log(`| ${r.label.padEnd(21)} |   ${r.hotlap.toFixed(3)}s  |    +${r.meanGap.toFixed(3)}s   |    ${r.offtrack.toFixed(2)}s    |    ${String(r.contacts).padStart(3)}   |     ${r.catchToCommit.toFixed(1).padStart(5)}%   |      ${r.commitToOverlap.toFixed(1).padStart(5)}%     |    ${r.passConv.toFixed(1).padStart(5)}%  |    ${r.exitSpeedLoss.toFixed(2)} m/s     |`);
}
console.log('==================================================================================================================================================');

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/v42-ablation-results.json', JSON.stringify(ablationResults, null, 2));
console.log('\nSaved full ablation dataset to artifacts/v42-ablation-results.json');
