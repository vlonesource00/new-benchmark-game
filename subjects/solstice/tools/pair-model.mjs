import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// An analytical planning aid, not a simulated human or an achieved race time.
// Input pace must come from clean, incident-free station probes. Each stop
// alternates the driver, and its measured penalty already includes the swap.
export function pairedSchedule(profiles, { laps = 20, humanLap = 65,
  humanMaxStint = 8, minimumStops = 2, maximumStops = laps - 1, stopPenalty = 38,
  maximumFade = 4, starter = 'human' } = {}) {
  if (![laps, humanLap, humanMaxStint, minimumStops, maximumStops, stopPenalty, maximumFade].every(Number.isFinite)
    || ![laps, humanMaxStint, minimumStops, maximumStops].every(Number.isInteger)
    || laps < 1 || humanLap <= 0 || humanMaxStint < 1 || stopPenalty < 0 || maximumFade < 0
    || minimumStops < 0 || maximumStops < minimumStops || maximumStops >= laps
    || !['human', 'solstice'].includes(starter)) throw new Error('Invalid pair assumptions');
  if (profiles.some(p => !p.times.length || p.times.some(t => !Number.isFinite(t) || t <= 0)))
    throw new Error('Invalid measured stint');
  const candidates = profiles.flatMap(profile => profile.times.map((_, index) => {
    const times = profile.times.slice(0, index + 1);
    return { driver: 'solstice', profile: profile.id, laps: times.length,
      seconds: times.reduce((sum, time) => sum + time, 0),
      fade: Math.max(...times) - Math.min(...times) };
  })).filter(stint => stint.fade <= maximumFade);
  const memo = new Map();
  const solve = (remaining, driver, stopsLeft, stopsAllowed) => {
    if (!remaining) return stopsLeft <= 0 ? { seconds: 0, stints: [] } : null;
    const key = `${remaining}:${driver}:${stopsLeft}:${stopsAllowed}`;
    if (memo.has(key)) return memo.get(key);
    let best = null;
    const options = driver === 'human' ? Array.from({ length: Math.min(remaining, humanMaxStint) }, (_, index) =>
      ({ driver, laps: index + 1, seconds: humanLap * (index + 1), fade: null })) : candidates;
    for (const stint of options) {
      if (stint.laps > remaining) continue;
      if (stint.laps < remaining && stopsAllowed <= 0) continue;
      const next = solve(remaining - stint.laps, driver === 'human' ? 'solstice' : 'human',
        stopsLeft - (stint.laps < remaining ? 1 : 0), stopsAllowed - (stint.laps < remaining ? 1 : 0));
      if (!next) continue;
      const seconds = stint.seconds + next.seconds + (stint.laps < remaining ? stopPenalty : 0);
      if (!best || seconds < best.seconds) best = { seconds, stints: [stint, ...next.stints] };
    }
    memo.set(key, best); return best;
  };
  const result = solve(laps, starter, minimumStops, maximumStops);
  return result && { ...result, stops: result.stints.length - 1,
    swaps: result.stints.length - 1, solsticeLaps: result.stints.filter(s => s.driver === 'solstice').reduce((n, s) => n + s.laps, 0) };
}

function profilesFrom(probe) {
  if (probe.offtrackSeconds || probe.rescues || probe.bridgeErrors || probe.contactsFieldWide
    || probe.conditions.codeChangedDuringRun) throw new Error('Pair model requires an incident-free, source-stable probe');
  const groups = [], pitPenalties = [];
  let group = null;
  for (let index = 0; index < probe.completed.length; index++) {
    const lap = probe.completed[index];
    if (!lap.clean) {
      group = null;
      const next = probe.completed[index + 1], before = probe.completed[index - 1], after = probe.completed[index + 2];
      if (lap.state === 'pit' && next?.state === 'pit' && before?.clean && after?.clean)
        pitPenalties.push(lap.time + next.time - before.time - after.time);
      continue;
    }
    if (!group) {
      group = { id: `${lap.tyresAtLine[0].compound}-lap${lap.lap}`,
        firstObservedLap: lap.lap, afterPit: index > 0 && probe.completed[index - 1].state === 'pit', times: [] };
      groups.push(group);
    }
    group.times.push(lap.time);
  }
  return { profiles: groups, pitPenalties };
}

if (process.argv[1]?.endsWith('pair-model.mjs')) {
  const source = process.argv[2];
  if (!source) throw new Error('Pass an incident-free station-probe JSON');
  const raw = readFileSync(source), probe = JSON.parse(raw);
  const { profiles, pitPenalties } = profilesFrom(probe);
  const warmProfiles = profiles.filter(p => p.afterPit);
  if (!warmProfiles.length) throw new Error('At least one measured post-pit stint is required');
  const ordered = [...pitPenalties].sort((a, b) => a - b);
  const measuredPenalty = ordered.length ? ordered[Math.floor(ordered.length / 2)] : 38;
  const assumptions = { laps: 20, humanLap: 65, humanMaxStint: 8,
    minimumStops: 2, maximumFade: 4, starter: 'human' };
  const result = { type: 'pair-estimate', source: source.replace(/\\/g, '/').split('/').at(-1),
    sourceHash: createHash('sha256').update(raw).digest('hex'), assumptions,
    sourceConditions: probe.conditions, profiles, measuredPitPenalties: pitPenalties,
    limitations: [
      'Human 65-second clean laps are user-provided. Eight-lap resource reach is a model assumption, not measured human driving.',
      'Post-pit profiles begin at the first fully clean timed lap; the preceding out-lap already ages the tyres. Reusing these prefixes is a conservative pace model, not an exact fresh-tyre simulation.',
      'A pit penalty is the measured in/out-lap pair minus adjacent clean laps. It includes native fuel, tyres, transit and driver swap, and depends on service and traffic.',
      'No human tyre/fuel telemetry is available. This tool recommends no compound and does not change the game strategist.'
    ],
    estimates: [30, measuredPenalty, 50].map(stopPenalty => ({ stopPenalty,
      ...pairedSchedule(warmProfiles, { ...assumptions, stopPenalty }) })),
    stopComparison: [2, 3, 4, 5].map(stops => ({ stops,
      ...pairedSchedule(warmProfiles, { ...assumptions, stopPenalty: measuredPenalty,
        minimumStops: stops, maximumStops: stops }) })),
    humanReachSensitivity: [4, 6, 8, 9].map(humanMaxStint => ({ humanMaxStint,
      ...pairedSchedule(warmProfiles, { ...assumptions, humanMaxStint, stopPenalty: measuredPenalty }) })) };
  const outputAt = process.argv.indexOf('--output');
  if (outputAt >= 0) writeFileSync(process.argv[outputAt + 1], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ assumptions, measuredPitPenalties: pitPenalties, estimates: result.estimates,
    stopComparison: result.stopComparison, humanReachSensitivity: result.humanReachSensitivity }));
}
