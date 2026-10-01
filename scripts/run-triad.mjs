import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Track } from '../host/astra/src/sim/track.js';
import { Session } from '../host/astra/src/sim/session.js';
import { createField, ALL_KNOWN_CANDIDATES } from '../sandbox/bridges/index.js';

/**
 * Field presets.
 *
 * The triad is the long-standing Astra / Gemini Supreme / NOVA baseline and is
 * kept bit-for-bit so its historical numbers stay comparable. The quad adds
 * VORTEX as a fourth car over the same three architectures. Every metric table
 * is derived from the preset's id list rather than being hard-coded to three,
 * so the two fields cannot drift apart.
 */
export const FIELDS = Object.freeze({
  triad: Object.freeze({
    id: 'triad',
    title: 'HARBOR TRIAD BENCHMARK',
    note: 'Canonical Astra host (120 Hz)',
    ids: Object.freeze(['nova', 'gemini-supreme', 'astra']),
    subjects: Object.freeze({
      'nova': { id: 'nova', name: 'DeepSeek NOVA', label: 'NOVA' },
      'gemini-supreme': { id: 'gemini-supreme', name: 'Gemini Supreme V3.2', label: 'GEMINI' },
      'astra': { id: 'astra', name: 'Astra (Host Baseline)', label: 'ASTRA' }
    })
  }),
  quad: Object.freeze({
    id: 'quad',
    title: 'HARBOR QUAD BENCHMARK',
    note: 'Canonical Astra host (120 Hz)',
    ids: Object.freeze(['vortex', 'nova', 'gemini-supreme', 'astra']),
    subjects: Object.freeze({
      'vortex': { id: 'vortex', name: 'VORTEX', label: 'VORTEX' },
      'nova': { id: 'nova', name: 'DeepSeek NOVA', label: 'NOVA' },
      'gemini-supreme': { id: 'gemini-supreme', name: 'Gemini Supreme V3.2', label: 'GEMINI' },
      'astra': { id: 'astra', name: 'Astra (Host Baseline)', label: 'ASTRA' }
    })
  }),
  penta: Object.freeze({
    id: 'penta',
    title: 'HARBOR PENTA BENCHMARK',
    note: 'Canonical Astra host (120 Hz)',
    ids: Object.freeze(['phantom', 'vortex', 'nova', 'gemini-supreme', 'astra']),
    subjects: Object.freeze({
      'phantom': { id: 'phantom', name: 'PHANTOM', label: 'PHANTOM' },
      'vortex': { id: 'vortex', name: 'VORTEX', label: 'VORTEX' },
      'nova': { id: 'nova', name: 'DeepSeek NOVA', label: 'NOVA' },
      'gemini-supreme': { id: 'gemini-supreme', name: 'Gemini Supreme V3.2', label: 'GEMINI' },
      'astra': { id: 'astra', name: 'Astra (Host Baseline)', label: 'ASTRA' }
    })
  }),
  // Same field with Gemini Supreme v4 in v3's seat, for a like-for-like comparison.
  'penta-v4': Object.freeze({
    id: 'penta-v4',
    title: 'HARBOR PENTA BENCHMARK (v4)',
    note: 'Canonical Astra host (120 Hz)',
    ids: Object.freeze(['phantom', 'vortex', 'nova', 'gemini-supreme-v4', 'astra']),
    subjects: Object.freeze({
      'phantom': { id: 'phantom', name: 'PHANTOM', label: 'PHANTOM' },
      'vortex': { id: 'vortex', name: 'VORTEX', label: 'VORTEX' },
      'nova': { id: 'nova', name: 'DeepSeek NOVA', label: 'NOVA' },
      'gemini-supreme-v4': { id: 'gemini-supreme-v4', name: 'Gemini Supreme v4', label: 'GEMINI4' },
      'astra': { id: 'astra', name: 'Astra (Host Baseline)', label: 'ASTRA' }
    })
  }),
  // PHANTOM v2 in PHANTOM's seat against Gemini Supreme v4.
  'penta-v4p2': Object.freeze({
    id: 'penta-v4p2',
    title: 'HARBOR PENTA BENCHMARK (PHANTOM v2 vs v4)',
    note: 'Canonical Astra host (120 Hz)',
    ids: Object.freeze(['phantom-v2', 'vortex', 'nova', 'gemini-supreme-v4', 'astra']),
    subjects: Object.freeze({
      'phantom-v2': { id: 'phantom-v2', name: 'PHANTOM v2', label: 'PHANTOM2' },
      'vortex': { id: 'vortex', name: 'VORTEX', label: 'VORTEX' },
      'nova': { id: 'nova', name: 'DeepSeek NOVA', label: 'NOVA' },
      'gemini-supreme-v4': { id: 'gemini-supreme-v4', name: 'Gemini Supreme v4', label: 'GEMINI4' },
      'astra': { id: 'astra', name: 'Astra (Host Baseline)', label: 'ASTRA' }
    })
  })
});

/** Every grid ordering of a field, so no car keeps a start-slot advantage. */
export function gridPermutations(ids) {
  if (ids.length <= 1) return [ids.slice()];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const rest = ids.slice(0, i).concat(ids.slice(i + 1));
    for (const tail of gridPermutations(rest)) out.push([ids[i], ...tail]);
  }
  return out;
}

// Preserved for the audit scripts, which iterate the baseline triad only.
export const TRIAD_SUBJECTS = FIELDS.triad.subjects;
export const TRIAD_GRID_PERMUTATIONS = Object.freeze(gridPermutations(FIELDS.triad.ids).map((row) => Object.freeze(row)));

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    field: 'quad',
    laps: 3,
    rotations: 1, // 1 to 5 sets of the full permutation set (default 1 = one heat per grid order)
    seed: 20260919,
    json: null,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--field' && args[i + 1]) {
      options.field = args[++i];
    } else if (arg.startsWith('--field=')) {
      options.field = arg.slice(7);
    } else if (arg === '--laps' && args[i + 1]) {
      options.laps = parseInt(args[++i], 10);
    } else if (arg.startsWith('--laps=')) {
      options.laps = parseInt(arg.slice(7), 10);
    } else if (arg === '--rotations' && args[i + 1]) {
      options.rotations = parseInt(args[++i], 10);
    } else if (arg.startsWith('--rotations=')) {
      options.rotations = parseInt(arg.slice(12), 10);
    } else if (arg === '--seed' && args[i + 1]) {
      options.seed = parseInt(args[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      options.seed = parseInt(arg.slice(7), 10);
    } else if (arg === '--json' && args[i + 1]) {
      options.json = args[++i];
    } else if (arg.startsWith('--json=')) {
      options.json = arg.slice(7);
    } else if (arg === '--cyclic') {
      options.cyclic = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    }
  }

  if (!FIELDS[options.field]) {
    throw new Error(`Unknown field "${options.field}". Expected one of: ${Object.keys(FIELDS).join(', ')}`);
  }
  return options;
}

function wrapTrackDelta(ds, trackLength) {
  let d = ((ds % trackLength) + trackLength) % trackLength;
  if (d > trackLength * 0.5) d -= trackLength;
  return d;
}

const zeroTally = (grid) => Object.fromEntries(grid.map((id) => [id, 0]));
const listTally = (grid) => Object.fromEntries(grid.map((id) => [id, []]));

export function runTriadHeat({ grid, laps = 3, trackName = 'harbor-ring' }) {
  const fieldSize = grid.length;
  const track = new Track(trackName);
  const session = new Session(track, { classId: 'gt', mixed: false });
  session.laps = laps;
  session.field = fieldSize;
  session.cars = session.cars.slice(0, fieldSize);
  session.drivers = session.drivers.slice(0, fieldSize);
  session.autopilot = true;

  const field = createField({
    session,
    hostTrack: track,
    order: grid,
    candidatesList: ALL_KNOWN_CANDIDATES
  });
  session.start({ freshTrack: true });
  // start() resets the host driver array; bind architecture bridges afterward.
  field.attach(true);
  if (field.bridges.some((bridge, index) => session.drivers[index] !== bridge)) {
    throw new Error('Architecture bridges were not installed');
  }
  // Skip the 4-second standing countdown to begin green-flag racing immediately
  session.phase = 'racing';
  session.countdown = 0;

  const DT = 1 / 120;
  const maxTime = laps * 100 + 40; // Max 100s per lap + buffer
  const maxSteps = Math.ceil(maxTime / DT);

  let steps = 0;
  let prevOrder = grid.slice();
  const passes = zeroTally(grid);
  const completedPasses = zeroTally(grid);
  const retainedPasses = zeroTally(grid);
  const bodyOverlaps = zeroTally(grid);
  const overlapSpeedLossList = listTally(grid);
  const overlapEpisodes = new Map();
  const previousGaps = new Map();
  const pendingPassList = [];
  const contactTracker = new Map(grid.map(id => [id, 0]));
  const gridToLineTimes = {};
  const carLapTimes = listTally(grid);
  const lastLapRecorded = Object.fromEntries(grid.map(id => [id, 1]));
  const prevOfftrack = zeroTally(grid);
  const offtrackEpisodes = listTally(grid);

  while (steps < maxSteps) {
    const prevContacts = session.contacts;
    if (session.phase === 'finished' && !session.activeCars.every((c) => c.race.finishTime !== null)) {
      session.phase = 'racing';
    }
    session.step(DT, { throttle: 0, brake: 0, steer: 0 });
    steps++;

    // Track grid-to-line time, lap transitions, and offtrack episodes per car
    for (const car of session.activeCars) {
      const candId = field.bridges[car.id]?.candidateId;
      if (!candId) continue;

      if (gridToLineTimes[candId] === undefined && car.race.progress >= 0) {
        gridToLineTimes[candId] = session.time;
      }

      if (car.race.lap > lastLapRecorded[candId]) {
        carLapTimes[candId].push(car.race.lastLap);
        lastLapRecorded[candId] = car.race.lap;
      }

      const dOff = car.race.offtrack - (prevOfftrack[candId] || 0);
      if (dOff > 0.001) {
        const episodes = offtrackEpisodes[candId];
        if (episodes.length === 0 || session.time - episodes.at(-1).endTime > 1.0) {
          episodes.push({
            startTime: session.time,
            endTime: session.time,
            duration: dOff,
            station: car.s
          });
        } else {
          episodes.at(-1).endTime = session.time;
          episodes.at(-1).duration += dOff;
        }
      }
      prevOfftrack[candId] = car.race.offtrack;
    }

    // Track contacts delta
    const deltaContacts = session.contacts - prevContacts;
    if (deltaContacts > 0) {
      for (const car of session.activeCars) {
        if (car.impact > 0.05) {
          const id = field.bridges[car.id]?.candidateId;
          if (id) contactTracker.set(id, contactTracker.get(id) + deltaContacts);
        }
      }
    }

    // Check overtakes
    const standings = session.standings();
    const currentOrder = standings.map(c => field.bridges[c.id]?.candidateId);
    for (let pos = 0; pos < currentOrder.length; pos++) {
      const id = currentOrder[pos];
      const prevPos = prevOrder.indexOf(id);
      if (prevPos > pos) {
        passes[id] = (passes[id] || 0) + (prevPos - pos);
      }
    }
    prevOrder = currentOrder;

    // Track pair interactions: body overlap, speed loss, and pass completion/retention
    const activeCarList = session.activeCars;
    for (let i = 0; i < activeCarList.length; i++) {
      const carA = activeCarList[i];
      const candA = field.bridges[carA.id]?.candidateId;
      if (!candA) continue;

      for (let j = 0; j < activeCarList.length; j++) {
        if (i === j) continue;
        const carB = activeCarList[j];
        const candB = field.bridges[carB.id]?.candidateId;
        if (!candB) continue;

        // 1. Pass completion & retention tracking (directed: candA passing candB)
        const pairKeyDirected = `${candA}:${candB}`;
        const prevGap = previousGaps.get(pairKeyDirected);
        const currentGap = carA.race.progress - carB.race.progress;
        // Bumper clears rival (progress delta > 5.2m, car length is ~4.65m)
        if (prevGap !== undefined && prevGap <= 5.2 && currentGap > 5.2) {
          completedPasses[candA]++;
          pendingPassList.push({
            car: candA,
            rival: candB,
            carObj: carA,
            rivalObj: carB,
            startProgress: carA.race.progress,
            retained: null
          });
        }
        previousGaps.set(pairKeyDirected, currentGap);

        // 2. Overlap & speed loss tracking (undirected pair key to avoid duplicate episode counts)
        if (i < j) {
          const pairKeyUndirected = candA < candB ? `${candA}:${candB}` : `${candB}:${candA}`;
          const ds = Math.abs(wrapTrackDelta(carA.s - carB.s, track.length));
          const isOverlapping = ds <= 4.65; // Within one car body length along track
          let ep = overlapEpisodes.get(pairKeyUndirected);
          if (!ep) {
            ep = { active: false, entrySpeeds: {}, minSpeeds: {} };
            overlapEpisodes.set(pairKeyUndirected, ep);
          }

          if (isOverlapping) {
            if (!ep.active) {
              ep.active = true;
              ep.entrySpeeds = { [candA]: carA.speed, [candB]: carB.speed };
              ep.minSpeeds = { [candA]: carA.speed, [candB]: carB.speed };
              bodyOverlaps[candA]++;
              bodyOverlaps[candB]++;
            } else {
              ep.minSpeeds[candA] = Math.min(ep.minSpeeds[candA], carA.speed);
              ep.minSpeeds[candB] = Math.min(ep.minSpeeds[candB], carB.speed);
            }
          } else if (ep.active) {
            // Overlap ended
            ep.active = false;
            const lossA = Math.max(0, ep.entrySpeeds[candA] - ep.minSpeeds[candA]);
            const lossB = Math.max(0, ep.entrySpeeds[candB] - ep.minSpeeds[candB]);
            overlapSpeedLossList[candA].push(lossA);
            overlapSpeedLossList[candB].push(lossB);
          }
        }
      }
    }

    // Check pending passes for retention (over 100m)
    for (const p of pendingPassList) {
      if (p.retained !== null) continue;
      if (p.carObj.race.progress - p.startProgress >= 100) {
        p.retained = p.carObj.race.progress > p.rivalObj.race.progress;
        if (p.retained) retainedPasses[p.car]++;
      }
    }

    // Check if all cars have finished
    const allFinished = session.activeCars.every(c => c.race.finishTime !== null);
    if (allFinished) break;
  }

  // Finalize any active overlaps
  for (const [key, ep] of overlapEpisodes) {
    if (ep.active) {
      ep.active = false;
      const [c1, c2] = key.split(':');
      if (ep.entrySpeeds[c1] !== undefined) {
        overlapSpeedLossList[c1].push(Math.max(0, ep.entrySpeeds[c1] - ep.minSpeeds[c1]));
      }
      if (ep.entrySpeeds[c2] !== undefined) {
        overlapSpeedLossList[c2].push(Math.max(0, ep.entrySpeeds[c2] - ep.minSpeeds[c2]));
      }
    }
  }

  // Finalize any pending passes that hadn't reached 100m before the finish
  for (const p of pendingPassList) {
    if (p.retained === null) {
      p.retained = p.carObj.race.progress > p.rivalObj.race.progress;
      if (p.retained) retainedPasses[p.car]++;
    }
  }

  // Push any final lap not yet captured in carLapTimes
  for (const car of session.activeCars) {
    const candId = field.bridges[car.id]?.candidateId;
    if (candId && car.race.finishTime !== null && carLapTimes[candId].length < laps) {
      carLapTimes[candId].push(car.race.lastLap);
    }
  }

  const finalStandings = session.standings();
  const rawResults = finalStandings.map((car, pos) => {
    const bridge = field.bridges[car.id];
    const candId = bridge?.candidateId;
    const offtrackSec = car.race.offtrack;
    const episodes = offtrackEpisodes[candId] || [];
    const substantiveOfftracks = episodes.filter(e => e.duration >= 0.25).length;
    const offtrackPenalty = substantiveOfftracks > 0 ? substantiveOfftracks * 5.0 : (offtrackSec > 0.5 ? 5.0 : 0);
    const contactsCount = contactTracker.get(candId) || 0;
    const contactPenalty = contactsCount * 5.0;
    const totalPenalty = offtrackPenalty + contactPenalty;
    const rawFinishTime = car.race.finishTime;
    const legalFinishTime = rawFinishTime !== null ? rawFinishTime + totalPenalty : null;

    const penaltyReasons = [];
    if (offtrackPenalty > 0) penaltyReasons.push(`+${offtrackPenalty.toFixed(1)}s (${substantiveOfftracks} offtrack ep, ${offtrackSec.toFixed(2)}s)`);
    if (contactPenalty > 0) penaltyReasons.push(`+${contactPenalty.toFixed(1)}s (${contactsCount} contacts)`);
    const penaltyDescription = penaltyReasons.length ? penaltyReasons.join(', ') : 'Clean (0 penalties)';

    const speedLosses = overlapSpeedLossList[candId] || [];
    const meanSpeedLoss = speedLosses.length > 0
      ? Number((speedLosses.reduce((a, b) => a + b, 0) / speedLosses.length).toFixed(3))
      : 0;

    return {
      rawPosition: pos + 1,
      position: pos + 1,
      id: candId,
      name: car.name,
      gridSlot: grid.indexOf(candId) + 1,
      gridToLineTime: gridToLineTimes[candId] ?? null,
      flyingLaps: carLapTimes[candId] || [],
      finishTime: rawFinishTime,
      bestLap: car.race.bestLap,
      lastLap: car.race.lastLap,
      completedLaps: car.race.lap - 1,
      offtrackSec,
      offtrackEpisodes: episodes.length,
      episodesList: episodes,
      contacts: contactsCount,
      passes: passes[candId] || 0,
      completedPasses: completedPasses[candId] || 0,
      retainedPasses: retainedPasses[candId] || 0,
      bodyOverlaps: bodyOverlaps[candId] || 0,
      overlapSpeedLossMps: meanSpeedLoss,
      overlapSpeedLossList: speedLosses,
      valid: car.race.valid,
      penalties: {
        offtrackPenalty,
        contactPenalty,
        totalPenalty,
        description: penaltyDescription
      },
      legalFinishTime
    };
  });

  const rawWinner = rawResults[0];
  const leaderTime = rawWinner.finishTime ?? 0;
  for (const res of rawResults) {
    res.gap = res.finishTime !== null && leaderTime > 0 ? res.finishTime - leaderTime : null;
  }

  // Legal finish standings
  const legalResults = [...rawResults].sort((a, b) => {
    if (a.legalFinishTime === null) return 1;
    if (b.legalFinishTime === null) return -1;
    return a.legalFinishTime - b.legalFinishTime;
  });
  const legalLeaderTime = legalResults[0]?.legalFinishTime ?? 0;
  legalResults.forEach((res, pos) => {
    res.legalPosition = pos + 1;
    res.legalGap = res.legalFinishTime !== null && legalLeaderTime > 0 ? res.legalFinishTime - legalLeaderTime : null;
  });

  return {
    grid,
    laps,
    elapsedSimTime: session.time,
    totalContacts: session.contacts,
    winner: rawWinner.id,
    legalWinner: legalResults[0]?.id,
    results: rawResults,
    legalResults
  };
}

export function runTriadBenchmark(options) {
  const { laps, rotations, json } = options;
  const preset = FIELDS[options.field ?? 'triad'];
  const ids = preset.ids;
  // --cyclic: one heat per start slot (n rotations) instead of all n! orders.
  const permutations = options.cyclic ? ids.map((_, k) => ids.map((_, i) => ids[(i + k) % ids.length])) : gridPermutations(ids);
  const totalHeats = rotations * permutations.length;

  console.log(`\n================================================================================`);
  console.log(`${preset.title} — ${preset.note}`);
  console.log(`Subjects: ${ids.map((id) => preset.subjects[id].label).join(' vs ')}`);
  console.log(`Format: ${rotations} rotation(s) × ${permutations.length} grid orders = ${totalHeats} total heats (${laps} laps/heat)`);
  console.log(`================================================================================\n`);

  const heats = [];
  const stats = {};
  for (const id of ids) {
    stats[id] = {
      id, label: preset.subjects[id].label,
      rawWins: 0, legalWins: 0,
      p2: 0, p3: 0, other: 0,
      finishTimes: [], legalFinishTimes: [], gaps: [], bestLaps: [],
      offtrackSec: 0, offtrackEpisodes: 0,
      passes: 0, completedPasses: 0, retainedPasses: 0,
      bodyOverlaps: 0, overlapSpeedLossList: [], contacts: 0
    };
  }

  let heatCount = 0;
  for (let rot = 0; rot < rotations; rot++) {
    for (let permIdx = 0; permIdx < permutations.length; permIdx++) {
      heatCount++;
      const grid = permutations[permIdx];
      const gridStr = grid.map(id => preset.subjects[id]?.label || id).join(' / ');
      process.stdout.write(`Heat ${String(heatCount).padStart(2, '0')}/${totalHeats} [${gridStr}] ... `);

      const heatResult = runTriadHeat({ grid, laps });
      heats.push({ heatIndex: heatCount, rotation: rot + 1, ...heatResult });

      const w = heatResult.winner;
      const lw = heatResult.legalWinner;
      const wLabel = preset.subjects[w]?.label || w;
      const lwLabel = preset.subjects[lw]?.label || lw;
      const wTime = heatResult.results[0]?.finishTime?.toFixed(2) ?? 'DNF';
      const gap2 = heatResult.results[1]?.gap?.toFixed(3) ?? '—';
      const gap3 = heatResult.results[2]?.gap?.toFixed(3) ?? '—';

      console.log(`Raw P1: ${wLabel.padEnd(7)} (${wTime}s) | +${gap2}s | +${gap3}s | Legal P1: ${lwLabel}`);

      for (const res of heatResult.results) {
        const s = stats[res.id];
        if (!s) continue;
        if (res.rawPosition === 1) s.rawWins++;
        if (res.legalPosition === 1) s.legalWins++;
        if (res.legalPosition === 2) s.p2++;
        else if (res.legalPosition === 3) s.p3++;
        else s.other++;

        if (res.finishTime !== null) s.finishTimes.push(res.finishTime);
        if (res.legalFinishTime !== null) s.legalFinishTimes.push(res.legalFinishTime);
        if (res.gap !== null) s.gaps.push(res.gap);
        if (res.bestLap !== null) s.bestLaps.push(res.bestLap);
        s.offtrackSec += res.offtrackSec;
        s.offtrackEpisodes += res.offtrackEpisodes;
        s.passes += res.passes;
        s.completedPasses += res.completedPasses;
        s.retainedPasses += res.retainedPasses;
        s.bodyOverlaps += res.bodyOverlaps;
        if (res.overlapSpeedLossList && res.overlapSpeedLossList.length > 0) {
          s.overlapSpeedLossList.push(...res.overlapSpeedLossList);
        }
        s.contacts += res.contacts;
      }
    }
  }

  // Compute aggregate averages
  console.log(`\n${'='.repeat(150)}`);
  console.log(`${preset.title} SUMMARY (${heatCount} HEATS)`);
  console.log(`${'-'.repeat(150)}`);
  console.log(`| Driver         | Raw W | Legal W | P2  | P3  | Win % | Mean Best Lap | Mean Gap (s) | Offtrack (s) | Contacts | Body Overlaps | Passes | Retained | Overlap Spd Loss |`);
  console.log(`${'-'.repeat(150)}`);

  const summary = {};
  for (const id of ids) {
    const s = stats[id];
    const legalWinPct = ((s.legalWins / heatCount) * 100).toFixed(1);
    const meanBestLap = s.bestLaps.length ? (s.bestLaps.reduce((a, b) => a + b, 0) / s.bestLaps.length).toFixed(3) : '—';
    const meanGap = s.gaps.length ? (s.gaps.reduce((a, b) => a + b, 0) / s.gaps.length).toFixed(3) : '—';
    const offtrack = s.offtrackSec.toFixed(2);
    const meanSpeedLoss = s.overlapSpeedLossList.length > 0
      ? (s.overlapSpeedLossList.reduce((a, b) => a + b, 0) / s.overlapSpeedLossList.length).toFixed(2)
      : '0.00';

    summary[id] = {
      label: s.label,
      rawWins: s.rawWins,
      legalWins: s.legalWins,
      p2: s.p2,
      p3: s.p3,
      other: s.other,
      legalWinPct: Number(legalWinPct),
      meanBestLap: Number(meanBestLap) || null,
      meanGap: Number(meanGap) || 0,
      totalOfftrackSec: s.offtrackSec,
      totalOfftrackEpisodes: s.offtrackEpisodes,
      totalPasses: s.passes,
      totalCompletedPasses: s.completedPasses,
      totalRetainedPasses: s.retainedPasses,
      totalBodyOverlaps: s.bodyOverlaps,
      meanOverlapSpeedLossMps: Number(meanSpeedLoss),
      totalContacts: s.contacts
    };

    console.log(
      `| ${preset.subjects[id].name.padEnd(14)} | ${String(s.rawWins).padStart(5)} | ${String(s.legalWins).padStart(7)} | ${String(s.p2).padStart(3)} | ${String(s.p3).padStart(3)} | ${legalWinPct.padStart(5)}% | ${String(meanBestLap).padStart(13)} | ${String(meanGap).padStart(12)} | ${offtrack.padStart(12)} | ${String(s.contacts).padStart(8)} | ${String(s.bodyOverlaps).padStart(13)} | ${String(s.completedPasses).padStart(6)} | ${String(s.retainedPasses).padStart(8)} | ${(meanSpeedLoss + ' m/s').padStart(16)} |`
    );
  }
  console.log(`${'='.repeat(150)}\n`);

  const benchmarkPayload = {
    benchmark: `harbor-${preset.id}`,
    timestamp: new Date().toISOString(),
    config: { field: preset.id, ids, laps, rotations, totalHeats: heatCount },
    summary,
    heats
  };

  if (json) {
    const fullPath = resolve(json);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(benchmarkPayload, null, 2));
    console.log(`Saved benchmark report to ${fullPath}`);
  }

  return benchmarkPayload;
}

if (process.argv[1] && process.argv[1].endsWith('run-triad.mjs')) {
  const options = parseArgs();
  runTriadBenchmark(options);
}
