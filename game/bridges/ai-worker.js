// One heavy AI per worker. The worker owns a replica Harbor Ring track and
// replica host Vehicles, rebuilds the exact driver context the host session
// would hand the driver, runs the unmodified bridge, and replies with controls.
import { Track } from '../engine/sim/track.js';
import { WaterField } from '../engine/sim/water.js';
import { Vehicle } from '../engine/sim/vehicle.js';
import { plain, assignDeep } from './remote-sync.js';

// Resolved at build time, so a bridge file that does not exist is simply absent.
const MODULES = import.meta.glob('./*-bridge.js');
const FACTORIES = {
  phantom: ['./phantom-bridge.js', 'createPhantomBridge'],
  'phantom-v2': ['./phantom-v2-bridge.js', 'createPhantomV2Bridge'],
  'solinator-6.1': ['./solinator-bridge.js', 'createBenchmarkSolinatorBridge'],
  solstice: ['./solstice-bridge.js', 'createSolsticeBridge']
};

let track = null, bridge = null, cars = [], id = null, lensTime, ghostSent = false, stepCount = 0;
const DEBUG_EVERY = 6;

function replica(snap) {
  while (cars.length < snap.length) {
    const s = snap[cars.length];
    cars.push(new Vehicle(s.id, s.name, s.color, s.classId));
  }
  for (let i = 0; i < snap.length; i += 1) assignDeep(cars[i], snap[i]);
  return cars.slice(0, snap.length);
}

function lensPayload(driver) {
  const planner = driver?.planner;
  if (!planner?.lens || planner.lens.time === undefined || planner.lens.time === lensTime) return null;
  lensTime = planner.lens.time;
  return plain({
    lens: planner.lens, trace: planner.trace, stats: planner.stats, times: planner.times,
    list: driver.field?.list ?? [], mode: driver.mode
  });
}

let booting = null;

async function boot(data) {
  id = data.id;
  const [file, name] = FACTORIES[id] ?? [];
  const load = MODULES[file];
  if (!load) throw new Error(`No worker factory for ${id}`);
  track = new Track(data.scenario);
  const module = await load();
  bridge = module[name]({ hostTrack: track, index: data.index });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    booting = boot(data).catch((error) => { self.postMessage({ type: 'fatal', message: String(error?.stack ?? error) }); });
    return;
  }
  await booting;
  if (data.type === 'reset') {
    bridge?.reset?.({ cars, track });
    lensTime = undefined;
    ghostSent = false;
    return;
  }
  if (data.type !== 'step') return;
  if (!bridge) { self.postMessage({ type: 'fatal', seq: data.seq, message: `${id} bridge unavailable` }); return; }

  if (data.rubber) track.rubber.set(data.rubber);
  if (data.wetness !== undefined) track.wetness = data.wetness;
  if (data.water) { track.water ??= new WaterField(track); track.water.depth.set(data.water); track.water.live = true; }
  if (data.weather) track.weatherInfo = data.weather;
  const active = replica(data.cars);
  const car = active[data.index];
  const projections = new Map(active.map((c) => [c.id, track.nearest(c.x, c.z)]));
  const order = [...active].sort((a, b) => (a.race.finishTime ?? Infinity) - (b.race.finishTime ?? Infinity) || b.race.progress - a.race.progress);
  const context = { projections, order, totalLaps: data.laps, mode: data.mode, time: data.time, paceObjective: data.paceObjective };

  const driver = bridge.driver;
  if (driver?.planner) {
    if (data.lens) { driver.planner.lens ??= {}; driver.planner.trace ??= []; }
    else if (driver.planner.lens) { driver.planner.lens = null; driver.planner.trace = null; lensTime = undefined; }
  }
  let failed = false;
  try { bridge.update(car, active, data.dt, context); }
  catch (error) { failed = true; bridge.lastError = error; }

  const reply = { type: 'controls', seq: data.seq, controls: { ...car.controls }, errors: bridge.errors ?? 0, failed };
  stepCount += 1;
  if (stepCount % DEBUG_EVERY === 1 || data.lens) {
    reply.debug = plain(bridge.debug?.() ?? null);
    reply.visual = plain(bridge.visualDebug?.() ?? null);
  }
  const d = bridge.driver;
  if (d?.ghost && !ghostSent) {
    ghostSent = true;
    reply.ghost = plain(d.ghost);
  }
  if (data.lens) reply.lens = lensPayload(d);
  self.postMessage(reply);
};
