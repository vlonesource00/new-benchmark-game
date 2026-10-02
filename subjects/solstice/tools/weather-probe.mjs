// Observe the normal race, strategist and weather fronts without changing them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark } from './bench.mjs';

const toolSha256 = createHash('sha256').update(readFileSync(new URL('./weather-probe.mjs', import.meta.url))).digest('hex');
const tyreState = car => ({ compounds: car.wheels.map(w => w.tyre.compound),
  wear: car.wheels.map(w => w.tyre.wear), fuel: car.fuel });

export function runWeatherProbe(options = {}) {
  const settings = { field: ['solstice', 'gemini-supreme-v4'], teams: 2,
    track: 'harbor-ring', laps: 12, seconds: 1800, seed: 7, sun: .6, ...options };
  const weatherAudit = { toolSha256, weatherSeed: settings.seed,
    note: 'Read-only onStep observer of native Changeable races; no forced tyre calls, weather or controls. Rain means rain > 0.02; wet means track wetness >= 0.08. Contact counts are field-wide.',
    phaseTransitions: [], phaseSeconds: {}, pitEvents: [], lapWeather: [], samples: [],
    contacts: { raining: 0, wet: 0, dry: 0 },
    range: { minWet: Infinity, maxWet: 0, maxRain: 0 },
    wettingSeconds: 0, dryingSeconds: 0, rainingSeconds: 0, wetSeconds: 0, drySeconds: 0 };
  const cursors = new Map(); let previousPhase = null, previousWet = null, previousContacts = 0, nextSample = 0;
  const report = runBenchmark({ ...settings, weather: 'changeable', onStep(race, dt) {
    if (dt <= 0) return;
    const w = race.weather.snapshot(), raining = w.rain > .02, wet = w.wet >= .08;
    const weather = { phase: w.phase, rain: w.rain, wet: w.wet, cloud: w.cloud };
    if (w.phase !== previousPhase) {
      weatherAudit.phaseTransitions.push({ time: race.time, ...weather }); previousPhase = w.phase;
    }
    weatherAudit.phaseSeconds[w.phase] = (weatherAudit.phaseSeconds[w.phase] ?? 0) + dt;
    weatherAudit.range.minWet = Math.min(weatherAudit.range.minWet, w.wet);
    weatherAudit.range.maxWet = Math.max(weatherAudit.range.maxWet, w.wet);
    weatherAudit.range.maxRain = Math.max(weatherAudit.range.maxRain, w.rain);
    if (previousWet !== null && w.wet > previousWet + 1e-10) weatherAudit.wettingSeconds += dt;
    if (previousWet !== null && w.wet < previousWet - 1e-10) weatherAudit.dryingSeconds += dt;
    previousWet = w.wet;
    if (raining) weatherAudit.rainingSeconds += dt;
    if (wet) weatherAudit.wetSeconds += dt; else weatherAudit.drySeconds += dt;
    const contacts = race.contacts - previousContacts; previousContacts = race.contacts;
    if (raining) weatherAudit.contacts.raining += contacts;
    weatherAudit.contacts[wet ? 'wet' : 'dry'] += contacts;
    for (const e of race.entries) {
      const car = e.car, driver = e.team.drivers[e.active].id;
      let c = cursors.get(car.id);
      if (!c) {
        c = { lap: car.race.lap, stopped: e.strategist.stops, plan: null, pit: null,
          finished: null, minWet: w.wet, maxWet: w.wet, rainSeconds: 0, wetSeconds: 0 };
        cursors.set(car.id, c);
      }
      // Include the finishing step, then stop observing that car's race interval.
      if (c.finished !== null) continue;
      const common = { car: car.id, driver, time: race.time, lap: car.race.lap, ...weather };
      const plan = e.pitPlan && { ...e.pitPlan }, signature = plan && JSON.stringify(plan);
      if (signature && signature !== c.plan) weatherAudit.pitEvents.push({ ...common,
        event: c.plan ? 'plan-update' : 'box-call', reason: e.strategist.reason, plan, ...tyreState(car) });
      c.plan = signature;
      const pit = e.pit?.phase ?? null;
      if (pit !== c.pit) weatherAudit.pitEvents.push({ ...common, event: 'pit-phase',
        from: c.pit, to: pit, reason: e.strategist.reason, plan, ...tyreState(car) });
      c.pit = pit;
      if (e.strategist.stops > c.stopped) weatherAudit.pitEvents.push({ ...common,
        event: 'service-complete', stop: e.strategist.stops, swap: e.strategist.swaps,
        reason: e.strategist.reason, plan, ...tyreState(car) });
      c.stopped = e.strategist.stops;
      c.minWet = Math.min(c.minWet, w.wet); c.maxWet = Math.max(c.maxWet, w.wet);
      if (raining) c.rainSeconds += dt;
      if (wet) c.wetSeconds += dt;
      if (car.race.lap !== c.lap) {
        if (c.lap > 0 && car.race.lastLap > 0) weatherAudit.lapWeather.push({ car: car.id,
          driver, lap: c.lap, time: race.time, lapTime: car.race.lastLap,
          minWet: c.minWet, maxWet: c.maxWet, rainSeconds: c.rainSeconds,
          wetSeconds: c.wetSeconds, ...tyreState(car) });
        c.lap = car.race.lap; c.minWet = w.wet; c.maxWet = w.wet; c.rainSeconds = 0; c.wetSeconds = 0;
      }
      c.finished = car.race.finishTime;
    }
    if (race.time >= nextSample) {
      weatherAudit.samples.push({ time: race.time, ...weather,
        cars: race.entries.filter(e => e.car.race.finishTime === null).map(e => ({
          car: e.car.id, lap: e.car.race.lap, speed: e.car.speed,
          pit: e.pit?.phase ?? null, ...tyreState(e.car) })) });
      nextSample = race.time + 5;
    }
  } });
  return { ...report, weatherAudit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {}; let output = null;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === '--output') output = value;
    else if (key === '--field') options.field = value.split(',');
    else if (['--laps', '--seconds', '--seed', '--teams', '--sun'].includes(key)) options[key.slice(2)] = Number(value);
    else if (['--track', '--compound'].includes(key)) options[key.slice(2)] = value;
    else throw new Error(`Unknown option ${key}`);
  }
  const report = runWeatherProbe(options);
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ track: report.config.track, seed: report.config.seed,
    phase: report.phase, truncated: report.truncated, contacts: report.totalContacts,
    weather: { range: report.weatherAudit.range, phases: report.weatherAudit.phaseSeconds,
      wettingSeconds: report.weatherAudit.wettingSeconds, dryingSeconds: report.weatherAudit.dryingSeconds,
      contacts: report.weatherAudit.contacts },
    results: report.results.map(({ driver, completedLaps, finishTime, stops, swaps,
      offtrackSeconds, damage, rescues, bridgeErrors, finite }) => ({ driver, completedLaps,
      finishTime, stops, swaps, offtrackSeconds, damage, rescues, bridgeErrors, finite })) }));
}
