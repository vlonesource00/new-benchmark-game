import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createSeatBridge } from '../../../game/core/field.js';
import { FIXED_DT } from '../../../game/core/race.js';
import { runBenchmark } from './bench.mjs';

// Model only output cadence and deterministic transport delay. Public car
// snapshots remain current when the controller is called; no host state is
// altered, and this does not emulate worker computation or message throughput.
export function cadenceBridgeFactory({ hz = 30, delayFrames = 1,
  nativeFactory = createSeatBridge } = {}) {
  if (![20, 30, 60, 120].includes(hz)) throw new Error('Use hz 20, 30, 60 or 120');
  if (![0, 1].includes(delayFrames)) throw new Error('Use delayFrames 0 or 1');
  const period = 1 / hz, metrics = [];
  const freshCounters = () => ({ wrapperCalls: 0, controllerCalls: 0,
    publications: 0, resets: 0, clockRollbacks: 0, heldFrames: 0,
    maxUpdateDt: 0, maxHeldControlAge: 0, controllerWallMs: 0, finiteControls: true });
  const makeBridge = (seat, index, race) => {
    const base = nativeFactory(seat, index, race);
    if (seat.id !== 'solstice' || seat.kind !== 'ai') return base;
    const m = { car: index, seat: metrics.filter(x => x.car === index).length,
      ...freshCounters(), postFinish: freshCounters() };
    metrics.push(m);
    let held = null, pending = null, lastAt = null, nextAt = null,
      publishedAt = null, lastObservedAt = null;
    const clear = () => {
      held = pending = null;
      lastAt = nextAt = publishedAt = lastObservedAt = null;
    };
    const wrapper = Object.create(base);
    wrapper.update = (car, cars, dt, context = {}) => {
      const count = car.race?.finishTime != null ? m.postFinish : m;
      const now = Number.isFinite(context.time) ? context.time :
        (lastObservedAt ?? 0) + dt;
      count.wrapperCalls++;
      if (lastObservedAt !== null && now + 1e-9 < lastObservedAt) {
        count.clockRollbacks++; clear(); base.reset?.({ cars, track: race.track });
      }
      lastObservedAt = now;
      held ??= { ...car.controls };
      if (pending && now + 1e-9 >= pending.releaseAt) {
        held = pending.controls; publishedAt = pending.computedAt;
        pending = null; count.publications++;
      }
      car.controls = { ...held };
      if (nextAt === null || now + 1e-9 >= nextAt) {
        const updateDt = lastAt === null ? dt : now - lastAt;
        const start = performance.now();
        base.update(car, cars, updateDt, { ...context, time: now });
        count.controllerWallMs += performance.now() - start;
        count.controllerCalls++; count.maxUpdateDt = Math.max(count.maxUpdateDt, updateDt);
        const controls = { ...car.controls };
        count.finiteControls &&= ['throttle', 'brake', 'steer'].every(key => Number.isFinite(controls[key]));
        lastAt = now; nextAt = now + period;
        if (delayFrames) pending = { controls, computedAt: now,
          releaseAt: now + delayFrames * FIXED_DT };
        else { held = controls; publishedAt = now; count.publications++; }
      } else count.heldFrames++;
      if (publishedAt !== null) count.maxHeldControlAge = Math.max(count.maxHeldControlAge, now - publishedAt);
      car.controls = { ...held };
    };
    wrapper.reset = (state) => {
      clear(); (state?.cars?.[index]?.race?.finishTime != null ? m.postFinish : m).resets++;
      return base.reset?.(state);
    };
    wrapper.dispose = () => { clear(); return base.dispose?.(); };
    return wrapper;
  };
  return { makeBridge, metrics, hz, delayFrames };
}

export function runCadenceBenchmark({ hz = 30, delayFrames = 1, teams = 1,
  seconds = 1800, laps = 6, track = 'harbor-ring', weather = 'clear', sun = .6,
  seed = 7, probe = false } = {}) {
  const model = cadenceBridgeFactory({ hz, delayFrames });
  let nextSample = 0, departureAt = null;
  const history = [], departures = [], previousOfftrack = new Map();
  const snapshot = (race, e) => {
    const c = e.car, d = e.bridges[e.active].driver;
    return { time: race.time, car: c.id, lap: c.race.lap, s: c.s, lateral: c.lateral,
      speed: c.speed, u: c.u, v: c.v, beta: Math.atan2(c.v, Math.max(.01, Math.abs(c.u))),
      yawRate: c.yawRate, controls: { ...c.controls }, fuel: c.fuel,
      tyres: c.wheels.map(w => ({ core: w.tyre.core, surface: w.tyre.surface,
        wear: w.tyre.wear, pressure: w.tyre.pressure, compound: w.tyre.compound })),
      pit: e.pit?.phase ?? null, pitPlan: e.pitPlan ? { ...e.pitPlan } : null, active: e.active,
      stops: e.strategist.stops, swaps: e.strategist.swaps,
      offtrackSeconds: c.race.offtrack, governor: { active: e.governor.active, k: e.governor.k },
      mode: d?.mode, trafficMode: d?.traffic.mode, targetSpeed: d?.targetSpeed,
      selected: d?.selected ? { ...d.selected } : null, planStats: d?.stats ? { ...d.stats } : null };
  };
  const onStep = probe ? (race, dt) => {
    if (dt <= 0) return;
    for (const e of race.entries) {
      const c = e.car, old = previousOfftrack.get(c.id) ?? 0;
      if (c.race.offtrack > old && !departures.some(x => x.car === c.id)) {
        departureAt ??= race.time; departures.push(snapshot(race, e));
      }
      previousOfftrack.set(c.id, c.race.offtrack);
    }
    if (race.time + 1e-9 >= nextSample) {
      history.push(...race.entries.map(e => snapshot(race, e)));
      nextSample = race.time + .1;
      if (departureAt === null) while (history[0]?.time < race.time - 3) history.shift();
    }
    if (departureAt !== null && race.time >= departureAt + 6) return false;
  } : null;
  const report = runBenchmark({ driver: 'solstice', teams, seconds, laps,
    track, weather, sun, seed, makeBridge: model.makeBridge, onStep });
  const controllerCalls = model.metrics.reduce((n, m) => n + m.controllerCalls, 0);
  const controllerWallMs = model.metrics.reduce((n, m) => n + m.controllerWallMs, 0);
  report.cadence = { hz, delayFrames, delaySeconds: delayFrames * FIXED_DT,
    model: 'Deterministic held controls with current public car snapshots at controller calls; optional delivery one physics frame later. No real workers or worker latency, concurrency or throughput are measured.',
    controllerCalls, controllerWallMs,
    controllerWallMsPerSimulatedSecondPerCar: controllerWallMs / (report.simulatedSeconds * teams),
    cpuNote: 'Race counters stop on each individual finish; subsequent counts are in each seat postFinish. Benchmark updateCalls counts 120 Hz wrapper calls; cadence controllerCalls counts actual driver calls. Stopwatch timings include cadence instrumentation and concurrent machine load.',
    postFinish: { controllerCalls: model.metrics.reduce((n, m) => n + m.postFinish.controllerCalls, 0),
      controllerWallMs: model.metrics.reduce((n, m) => n + m.postFinish.controllerWallMs, 0) },
    seats: model.metrics, ...(probe ? { probe: { departures, history,
      stopReason: departureAt === null ? 'normal benchmark limit' : 'six seconds after first offtrack' } } : {}),
    sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
  return report;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=', 2), value = inline ?? args[++i];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (['--hz', '--delayFrames', '--seconds', '--laps', '--teams', '--seed', '--sun', '--probe'].includes(key)) out[key.slice(2)] = Number(value);
    else if (['--track', '--weather', '--output'].includes(key)) out[key.slice(2)] = value;
    else throw new Error(`Unknown option ${key}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2)), report = runCadenceBenchmark(options);
  if (options.output) {
    const path = resolve(options.output); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ config: report.config, cadence: { hz: report.cadence.hz,
    delayFrames: report.cadence.delayFrames, controllerCalls: report.cadence.controllerCalls,
    controllerWallMsPerSimSecondPerCar: report.cadence.controllerWallMsPerSimulatedSecondPerCar },
    simulatedSeconds: report.simulatedSeconds, wallSeconds: report.wallSeconds,
    truncated: report.truncated, totalContacts: report.totalContacts,
    results: report.results.map(({ finishTime, bestCleanFlyingLap, medianCleanFlyingLap,
      offtrackSeconds, rescues, stops, swaps, finite, bridgeErrors }) => ({ finishTime,
      bestCleanFlyingLap, medianCleanFlyingLap, offtrackSeconds, rescues, stops, swaps, finite, bridgeErrors })) }));
}
