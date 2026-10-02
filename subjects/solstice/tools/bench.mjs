import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { COMPOUNDS, FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS, TEAM_LIVERIES } from '../../../game/core/teams.js';
import { TRACKS } from '../../../game/core/tracks.js';
import { MANAGE_ALIEN, MANAGE_CORE } from '../../../game/core/difficulty.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envOptions = () => {
  const raw = process.env.SOLSTICE_OPTIONS ?? null;
  return { raw, parsed: raw === null ? null : JSON.parse(raw) };
};
const sourceFiles = [
  ...readdirSync(resolve(repositoryRoot, 'subjects/solstice/src'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => `subjects/solstice/src/${entry.name}`),
  'subjects/solstice/config.json', 'subjects/solstice/data/lines.json', 'subjects/solstice/tools/bench.mjs',
  'subjects/solstice/tools/json-loader.mjs', 'game/bridges/solstice-bridge.js',
  'game/core/field.js', 'game/core/teams.js', 'game/bridges/index.js',
  'game/core/async-seats.js', 'game/core/seat-worker.js', 'game/bridges/ai-worker.js',
  'game/bridges/remote.js', 'game/bridges/remote-sync.js', 'game/sim-worker.js',
  'game/core/race.js', 'game/core/rules.js', 'game/core/weather.js', 'game/core/difficulty.js',
  'game/core/pit.js', 'game/core/strategy.js', 'game/engine/sim/vehicle.js',
  'game/engine/sim/tyre.js', 'game/engine/sim/track.js', 'game/engine/sim/car-specs.js'
].sort();
// One immutable module-start snapshot. A reused benchmark process retains the
// source version it imported; each run also records its current environment.
const sourceProvenance = Object.freeze({ capturedAt: new Date().toISOString(),
  nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  solsticeOptionsAtStartup: envOptions(),
  governor: { manageAlien: MANAGE_ALIEN, manageCore: MANAGE_CORE,
    manageFloor: Number(process.env.MANAGE_FLOOR ?? .92),
    manageGain: Number(process.env.MANAGE_GAIN ?? .004), spinLimit: Number(process.env.SPIN_LIMIT ?? .09) },
  configValues: JSON.parse(readFileSync(resolve(repositoryRoot, 'subjects/solstice/config.json'), 'utf8')),
  sha256: Object.freeze(Object.fromEntries(sourceFiles.map(path => {
    const absolute = resolve(repositoryRoot, path);
    return [path, existsSync(absolute) ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null];
  }))) });

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const finiteCar = (c) => [c.x, c.z, c.yaw, c.vx, c.vz, c.yawRate, c.speed, c.s,
  c.lateral, c.fuel, c.damage, c.race.progress, c.controls.throttle,
  c.controls.brake, c.controls.steer,
  ...c.wheels.flatMap((w) => [w.omega, w.tyre.surface, w.tyre.core, w.tyre.wear])].every(Number.isFinite);
const freshMetrics = () => ({ fuelUsed: 0, fuelAdded: 0, wearUsed: 0, tyreResets: 0,
  tempCoreIntegral: 0, tempSurfaceIntegral: 0, observedSeconds: 0, governorSeconds: 0,
  rescues: 0, impactEpisodes: 0, offtrackEpisodes: 0, wasOfftrack: false,
  offtrackSeconds: 0, finite: true, firstNonfiniteAt: null, cpuMs: 0, updateCalls: 0,
  bridgeErrors: 0, trafficAvailable: false,
  traffic: { attackStarts: 0, defendMoves: 0, alongsideEpisodes: 0, completedPasses: 0, capEpisodes: 0 } });
const carMetricSnapshot = (e, time) => ({ time, completedLaps: e.car.race.finishLaps ?? e.car.race.lap - 1,
  distanceM: e.car.race.progress, nativeBestLap: e.car.race.bestLap,
  offtrackSeconds: e.car.race.offtrack, damage: e.car.damage,
  stops: e.strategist.stops, swaps: e.strategist.swaps,
  fuelRemainingLitres: e.car.fuel, finalMaxWear: maxWear(e.car) });
const resourceCursor = (s, c, time, phase) => ({ phase, time, progress: c.race.progress,
  fuelUsed: s.fuelUsed, fuelAdded: s.fuelAdded, wearUsed: s.wearUsed,
  tyreResets: s.tyreResets, fuel: c.fuel, maxWear: maxWear(c) });
const resourceSegment = (s, cursor, end, trackLength) => {
  const distanceM = Math.max(0, end.distanceM - cursor.progress);
  const lapEquivalents = distanceM / trackLength;
  const fuelUsedLitres = s.fuelUsed - cursor.fuelUsed, cumulativeMaxWear = s.wearUsed - cursor.wearUsed;
  return { phase: cursor.phase, startTime: cursor.time, endTime: end.time,
    elapsedSeconds: end.time - cursor.time, distanceM, lapEquivalents,
    fuelUsedLitres, fuelAddedLitres: s.fuelAdded - cursor.fuelAdded,
    cumulativeMaxWear, tyreResets: s.tyreResets - cursor.tyreResets,
    fuelAtStartLitres: cursor.fuel, fuelAtEndLitres: end.fuelRemainingLitres,
    maxWearAtStart: cursor.maxWear, maxWearAtEnd: end.finalMaxWear,
    fuelUsedLitresPerLapEquivalent: lapEquivalents > 0 ? fuelUsedLitres / lapEquivalents : null,
    cumulativeMaxWearPerLapEquivalent: lapEquivalents > 0 ? cumulativeMaxWear / lapEquivalents : null };
};

export function runBenchmark({ driver = 'phantom', field = null, track = 'harbor-ring',
  seconds = 150, laps = 6, teams = null, seed = 7, weather = 'clear', sun = .6,
  compound = 'medium', format = null,
  makeBridge = undefined, onStep = null } = {}) {
  const solsticeOptions = envOptions();
  const ids = field ?? [driver], count = teams ?? (field ? ids.length : 4);
  if (!TRACKS.some((t) => t.scenario === track)) throw new Error(`Unknown track ${track}`);
  if (![seconds, laps, seed, sun].every(Number.isFinite) || seconds <= 0 ||
    !Number.isInteger(laps) || laps < 3 || laps > 30 || !Number.isInteger(seed) || sun < 0 || sun > 1) {
    throw new Error('Use positive finite seconds, integer laps 3–30, integer seed and sun 0–1');
  }
  if (!ids.length || !Number.isInteger(count) || count < 1) throw new Error('Provide at least one driver and team');
  if (field && count < ids.length) throw new Error('Mixed field needs at least one team for every driver');
  if (!Object.hasOwn(COMPOUNDS, compound)) throw new Error(`Unknown starting compound ${compound}`);
  const raceFormat = format == null ? (laps === 6 ? FORMATS.sprint : laps === 20 ? FORMATS.marathon : FORMATS.classic)
    : FORMATS[format];
  if (!raceFormat) throw new Error(`Unknown race format ${format}`);
  const roster = Array.from({ length: count }, (_, i) => {
    const id = ids[i % ids.length], known = AI_DRIVERS.find((d) => d.id === id);
    if (!known) throw new Error(`Unknown AI driver ${id}`);
    const livery = TEAM_LIVERIES[i % TEAM_LIVERIES.length];
    return { ...livery, id: `bench-${i}`, index: i, grid: i, starter: 0,
      drivers: [0, 1].map(() => ({ ...known, kind: 'ai' })) };
  });
  const wallStart = performance.now();
  const race = new EnduranceRace({ track: new Track(track), teams: roster,
    format: raceFormat, laps, classId: 'gt', startCompound: compound, difficulty: 1, weather, seed, makeBridge });
  race.weather.sun = sun;
  race.weather.apply(race.track);
  const stats = race.entries.map((e) => ({ ...freshMetrics(), driver: e.team.drivers[0].id,
    laps: [], finishedMetrics: null, postFinish: freshMetrics(),
    startProgress: 0, cursor: null, gridApproachResources: null }));
  const initialisationMs = performance.now() - wallStart;
  let cpuClockOverheadMs = 0;
  const overheadStart = performance.now();
  for (let i = 0; i < 20000; i++) { const t = performance.now(); cpuClockOverheadMs += performance.now() - t; }
  cpuClockOverheadMs /= 20000;
  const overheadWallMs = performance.now() - overheadStart;
  const previousCounters = new WeakMap();
  const captureCounters = (index, bridge, baselineOnly = false) => {
    const s = stats[index], target = s.finishedMetrics ? s.postFinish : s;
    const traffic = bridge.driver?.traffic?.stats ?? null;
    const errorCount = Number.isFinite(bridge.errors) ? bridge.errors : 0;
    const previous = previousCounters.get(bridge);
    if (traffic && Object.keys(target.traffic).some(key => Number.isFinite(traffic[key]))) target.trafficAvailable = true;
    const values = Object.fromEntries(Object.keys(target.traffic).map(key =>
      [key, Number.isFinite(traffic?.[key]) ? traffic[key] : 0]));
    if (!baselineOnly) {
      const oldErrors = previous?.errors ?? 0;
      target.bridgeErrors += errorCount >= oldErrors ? errorCount - oldErrors : errorCount;
      for (const [key, value] of Object.entries(values)) {
        const sameEpoch = previous && previous.traffic === traffic;
        const oldValue = sameEpoch ? previous.values[key] : 0;
        target.traffic[key] += value >= oldValue ? value - oldValue : value;
      }
    }
    previousCounters.set(bridge, { traffic, values, errors: errorCount });
  };
  race.entries.forEach((e, i) => e.bridges.forEach((bridge) => {
    const update = bridge.update;
    const reset = bridge.reset;
    bridge.update = function (...args) {
      const t = performance.now();
      try { return update.apply(this, args); }
      finally {
        const target = stats[i].finishedMetrics ? stats[i].postFinish : stats[i];
        target.cpuMs += Math.max(0, performance.now() - t - cpuClockOverheadMs); target.updateCalls++;
        captureCounters(i, this);
      }
    };
    if (reset) bridge.reset = function (...args) {
      captureCounters(i, this);
      try { return reset.apply(this, args); }
      finally { captureCounters(i, this, true); }
    };
  }));
  // Count marshal recoveries directly; the engine contact count belongs to the entire field.
  const rescue = race.rescue;
  race.rescue = function (entry, dt) {
    const before = entry.rescueGhost ?? 0;
    const result = rescue.call(this, entry, dt);
    const s = stats[entry.car.id], target = s.finishedMetrics ? s.postFinish : s;
    if ((entry.rescueGhost ?? 0) > before + .1) target.rescues++;
    return result;
  };
  const raceStartAt = performance.now();
  race.start();
  race.entries.forEach((e, i) => {
    stats[i].startProgress = e.car.race.progress;
    stats[i].cursor = resourceCursor(stats[i], e.car, race.time,
      e.car.race.progress < 0 ? 'grid-approach' : 'timed-lap');
  });
  const raceStartMs = performance.now() - raceStartAt;
  const simulationStart = performance.now();
  let steps = 0;
  const maxSteps = Math.ceil((seconds + 10) / FIXED_DT);
  const previous = race.cars.map((c) => ({ fuel: c.fuel, wear: maxWear(c),
    lap: c.race.lap, impact: c.impact, offtrack: c.race.offtrack,
    progress: c.race.progress, wheelTyres: c.wheels.map((w) => w.tyre) }));
  while (steps < maxSteps && race.time + FIXED_DT / 2 < seconds && race.phase !== 'finished') {
    const previousTime = race.time;
    race.step(FIXED_DT);
    const observedDt = race.time - previousTime;
    steps++;
    race.entries.forEach((e, i) => {
      const c = e.car, raceStats = stats[i], p = previous[i];
      // The first frame with finishTime set still belongs to this car's race.
      // Native physics and controllers continue after the flag until the field
      // finishes, so later measurements go to a separate diagnostic account.
      const s = raceStats.finishedMetrics ? raceStats.postFinish : raceStats;
      const fuelDelta = c.fuel - p.fuel;
      s.fuelUsed += Math.max(0, -fuelDelta); s.fuelAdded += Math.max(0, fuelDelta);
      const wear = maxWear(c), tyreReset = c.wheels.some((w, k) => w.tyre !== p.wheelTyres[k]);
      s.wearUsed += Math.max(0, tyreReset ? wear : wear - p.wear);
      if (tyreReset) s.tyreResets++;
      s.tempCoreIntegral += c.wheels.reduce((t, w) => t + w.tyre.core, 0) / 4 * observedDt;
      s.tempSurfaceIntegral += c.wheels.reduce((t, w) => t + w.tyre.surface, 0) / 4 * observedDt;
      s.observedSeconds += observedDt;
      if (e.governor.active) s.governorSeconds += observedDt;
      if (c.impact > .05 && p.impact <= .05) s.impactEpisodes++;
      const offtrack = c.race.offtrack > p.offtrack;
      s.offtrackSeconds += Math.max(0, c.race.offtrack - p.offtrack);
      if (offtrack && !s.wasOfftrack) s.offtrackEpisodes++;
      s.wasOfftrack = offtrack;
      if (!finiteCar(c)) { s.finite = false; s.firstNonfiniteAt ??= race.time; }
      if (!raceStats.finishedMetrics) {
        const end = carMetricSnapshot(e, race.time);
        if (p.progress < 0 && c.race.progress >= 0) {
          raceStats.gridApproachResources = resourceSegment(s, raceStats.cursor, end, race.track.length);
          raceStats.cursor = resourceCursor(s, c, race.time, 'timed-lap');
        }
        if (c.race.lap > p.lap) {
          s.laps.push({ lap: p.lap, time: c.race.lastLap,
            state: c.race.lastState, clean: ['purple', 'green', 'yellow'].includes(c.race.lastState),
            // timing() starts lap 1 when the car crosses the line after its grid approach.
            flying: true, steady: p.lap > 1, startTime: race.time - c.race.lastLap, endTime: race.time,
            tyresAtLine: c.wheels.map(w => ({ compound: w.tyre.compound, core: w.tyre.core,
              surface: w.tyre.surface, wear: w.tyre.wear, pressure: w.tyre.pressure })),
            governorAtLine: { active: e.governor.active, k: e.governor.k, manage: e.governor.manage },
            resources: resourceSegment(s, raceStats.cursor, end, race.track.length) });
          raceStats.cursor = resourceCursor(s, c, race.time, 'timed-lap');
        }
        if (c.race.finishTime !== null) raceStats.finishedMetrics = end;
      }
      Object.assign(p, { fuel: c.fuel, wear, lap: c.race.lap, impact: c.impact, offtrack: c.race.offtrack,
        progress: c.race.progress,
        wheelTyres: c.wheels.map((w) => w.tyre) });
    });
    if (onStep?.(race, observedDt) === false) break;
  }
  const wallSeconds = (performance.now() - simulationStart) / 1000;
  const order = race.standings(), cpuMs = stats.reduce((a, s) => a + s.cpuMs, 0);
  const results = order.map((c, position) => {
    const s = stats[c.id], e = race.entryOf(c), clean = s.laps.filter((l) => l.clean).map((l) => l.time);
    const steady = s.laps.filter((l) => l.clean && l.steady).map((l) => l.time);
    const end = s.finishedMetrics ?? carMetricSnapshot(e, race.time), post = s.postFinish;
    const raceDistanceM = Math.max(0, end.distanceM - s.startProgress);
    const distanceLapEquivalents = raceDistanceM / race.track.length;
    const partialResources = resourceSegment(s, s.cursor, end, race.track.length);
    return { car: c.id, driver: s.driver, position: position + 1, finishTime: c.race.finishTime,
      gap: race.interval(c, order[0]), metricEndTime: end.time, raceObservedSeconds: s.observedSeconds,
      completedLaps: end.completedLaps, distanceM: end.distanceM,
      raceDistanceM, distanceLapEquivalents,
      gridApproachLapEquivalent: Math.max(0, -s.startProgress / race.track.length),
      partialTimedLapEquivalent: Math.max(0, end.distanceM / race.track.length - end.completedLaps),
      fuelUsedLitresPerLapEquivalent: distanceLapEquivalents > 0 ? s.fuelUsed / distanceLapEquivalents : null,
      cumulativeMaxWearPerLapEquivalent: distanceLapEquivalents > 0 ? s.wearUsed / distanceLapEquivalents : null,
      fuelUsedLitresPerCompletedLap: end.completedLaps > 0 ? s.fuelUsed / end.completedLaps : null,
      cumulativeMaxWearPerCompletedLap: end.completedLaps > 0 ? s.wearUsed / end.completedLaps : null,
      gridApproachResources: s.gridApproachResources, partialResources,
      bestCleanFlyingLap: clean.length ? Math.min(...clean) : null,
      medianCleanFlyingLap: median(clean), cleanFlyingLaps: clean.length, lapRecords: s.laps,
      bestCleanSteadyLap: steady.length ? Math.min(...steady) : null,
      medianCleanSteadyLap: median(steady), cleanSteadyLaps: steady.length,
      nativeBestLap: end.nativeBestLap, offtrackSeconds: end.offtrackSeconds,
      offtrackEpisodes: s.offtrackEpisodes, impactEpisodes: s.impactEpisodes,
      damage: end.damage, rescues: s.rescues,
      bridgeErrors: s.bridgeErrors, trafficAvailable: s.trafficAvailable, traffic: { ...s.traffic }, finite: s.finite,
      firstNonfiniteAt: s.firstNonfiniteAt, stops: end.stops, swaps: end.swaps,
      fuelUsedLitres: s.fuelUsed, fuelAddedLitres: s.fuelAdded, fuelRemainingLitres: end.fuelRemainingLitres,
      cumulativeMaxWear: s.wearUsed, finalMaxWear: end.finalMaxWear, tyreResets: s.tyreResets,
      meanTyreCoreC: s.observedSeconds ? s.tempCoreIntegral / s.observedSeconds : null,
      meanTyreSurfaceC: s.observedSeconds ? s.tempSurfaceIntegral / s.observedSeconds : null,
      governorActiveFraction: s.observedSeconds ? s.governorSeconds / s.observedSeconds : null,
      updateCpuMs: s.cpuMs, updateCalls: s.updateCalls,
      updateCpuMsPerSimulatedSecond: s.observedSeconds ? s.cpuMs / s.observedSeconds : null,
      updateCpuMsPerActiveSecond: s.updateCalls ? s.cpuMs / (s.updateCalls * FIXED_DT) : null,
      postFinish: { observedSeconds: post.observedSeconds, finite: post.finite,
        firstNonfiniteAt: post.firstNonfiniteAt, bridgeErrors: post.bridgeErrors,
        updateCpuMs: post.cpuMs, updateCalls: post.updateCalls,
        trafficAvailable: post.trafficAvailable, traffic: { ...post.traffic },
        fuelUsedLitres: post.fuelUsed, fuelAddedLitres: post.fuelAdded,
        cumulativeMaxWear: post.wearUsed, tyreResets: post.tyreResets,
        offtrackSeconds: post.offtrackSeconds, offtrackEpisodes: post.offtrackEpisodes,
        impactEpisodes: post.impactEpisodes, rescues: post.rescues,
        stops: e.strategist.stops - end.stops, swaps: e.strategist.swaps - end.swaps,
        finalState: s.finishedMetrics ? carMetricSnapshot(e, race.time) : null } };
  });
  return { schemaVersion: 2, config: { driver: field ? null : driver, field: ids, track, requestedSeconds: seconds,
    laps: race.laps, teams: count, seed, weather: race.weather.id, sun, difficulty: 'alien',
    classId: race.classId, startCompound: compound,
    format: race.format.id, mandatoryStops: race.format.mandatoryStops, mandatorySwap: race.format.mandatorySwap,
    fuelLaps: race.cal.fuelLaps, tyreLaps: race.cal.tyreLaps, trackLengthM: race.track.length, fixedDt: FIXED_DT,
    solsticeOptions: solsticeOptions.parsed, solsticeOptionsRaw: solsticeOptions.raw },
    sourceProvenance,
    simulatedSeconds: race.time, phase: race.phase, truncated: race.phase !== 'finished',
    wallSeconds, initialisationMs, raceStartMs, timingProbeOverheadMs: overheadWallMs,
    totalContacts: race.contacts, collisionStats: race.collisionStats,
    postFinishUpdateCpuMs: stats.reduce((n, s) => n + s.postFinish.cpuMs, 0),
    totalActiveRaceCarSeconds: stats.reduce((n, s) => n + s.observedSeconds, 0),
    updateCpuMsPerActiveRaceCarSecond: cpuMs / stats.reduce((n, s) => n + s.observedSeconds, 0),
    updateCpuMs: cpuMs, updateCpuMsPerSimulatedSecondPerCar: cpuMs / (race.time * count),
    cpuMeasurement: 'performance.now around bridge update, adjacent-clock-call overhead subtracted; includes wrapper argument overhead; excludes bridge initialisation, race-start preparation and host/pit/governor updates',
    measurementNotes: {
      raceMetrics: 'Schema2 per-car metrics stop at that car\'s own finish including its finishing step, or at the run limit. Finished cars keep running in the native host; subsequent finite/error, resource, incident and CPU diagnostics are recorded only in postFinish. Older reports without schemaVersion included postfinish simulation in per-car metrics.',
      resources: 'Fuel used/refilled are sums of negative/positive observed tank deltas; burning during a net-positive refill is not separately visible. Wear is cumulative increases of the most worn wheel, including tyre replacement epochs. Distance equivalents use net native progress gained from the initial grid position, divided by track length. Completed-lap averages divide all race consumption by completed laps and therefore include grid approach and any partial lap; lapRecords.resources instead isolates each full timed lap. gridApproachResources and partialResources disclose the remainder.',
      totalContacts: 'Global engine car-pair contact-step events across the entire field simulation, including already-finished cars; repeated overlaps count on repeated steps. This counter cannot be attributed to individual cars or their active race intervals.',
      impactEpisodes: 'Per-car upward crossings of the impact signal above 0.05. The signal combines car and barrier impacts; this is not a distinct-collision counter.',
      traffic: 'Controller-reported tactical counter deltas accumulated across both seats and counter resets; they are not independently observed physical passes or contacts.',
      laps: 'Lap 1 is a full rolling timed lap after the initial line crossing. Clean steady laps additionally require lap >= 2.'
    },
    results };
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=', 2);
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${args[i]}`);
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === '--field') out.field = value.split(',');
    else if (['--seconds', '--laps', '--teams', '--seed', '--sun'].includes(key)) out[key.slice(2)] = Number(value);
    else if (['--driver', '--track', '--weather', '--compound', '--format', '--output'].includes(key)) out[key.slice(2)] = value;
    else throw new Error(`Unknown option ${key}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const report = runBenchmark(options);
  if (options.output) {
    const path = resolve(options.output); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ config: report.config, simulatedSeconds: report.simulatedSeconds,
    wallSeconds: report.wallSeconds, totalContacts: report.totalContacts, truncated: report.truncated,
    cpuMsPerSimSecondPerCar: report.updateCpuMsPerSimulatedSecondPerCar,
    results: report.results.map(({ driver, position, bestCleanFlyingLap, medianCleanFlyingLap,
      offtrackSeconds, rescues, stops, finite, bridgeErrors }) => ({ driver, position,
      bestCleanFlyingLap, medianCleanFlyingLap, offtrackSeconds, rescues, stops, finite, bridgeErrors })) }));
}
