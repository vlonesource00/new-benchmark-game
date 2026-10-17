// Deterministic race/controller fixture for VANGUARD solo and head-to-head benchmarks.
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { VanguardDriver } from '../src/driver.js';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { classifyContact } from './combat-metrics.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2), flag = (key, d) => { const i = args.indexOf('--' + key); return i < 0 ? d : args[i + 1]; };
const wallStarted = performance.now();
const trackId = flag('track', 'harbor-ring'), cls = flag('cls', 'lmdh'), path = flag('path', 'worker'),
  seed = +flag('seed', 7), duration = +flag('time', 240),
  ids = flag('ids', 'vanguard').split(','), compound = flag('tyres', 'soft'), opts = JSON.parse(flag('opts', '{}')),
  classes = flag('classes', '').split(','), lapTarget = +flag('lap-target', 0), raceLaps = +flag('race-laps', 20),
  initialWear = Math.max(0, Math.min(0.99, +flag('wear', 0))), tracePeriod = +flag('trace', 0);

const root = fileURLToPath(new URL('../../../', import.meta.url)), sourceHashes = {};
function stamp(dir) {
  try { for (const e of readdirSync(root + dir, { withFileTypes: true })) {
    const f = dir + '/' + e.name;
    if (e.isDirectory()) stamp(f);
    else if (/\.(js|mjs|json)$/.test(f)) sourceHashes[f] = createHash('sha256').update(readFileSync(root + f)).digest('hex');
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const dir of ['game/core', 'game/bridges', 'game/engine/sim',
  ...new Set([...ids, 'vanguard', 'apex', 'intercept', 'razor'])].flatMap(p =>
    p.startsWith('game/') ? [p] : [`subjects/${p}/src`, `subjects/${p}/data`])) stamp(dir);
for (const f of [...new Set([...ids, 'vanguard', 'apex', 'intercept', 'razor'])].map(id => `subjects/${id}/config.json`)
  .concat(['scripts/json-loader.mjs', 'scripts/bench/lockstep-workers.mjs',
    'subjects/vanguard/tools/probe.mjs', 'subjects/vanguard/tools/combat-metrics.mjs'])) {
  sourceHashes[f] = createHash('sha256').update(readFileSync(root + f)).digest('hex');
}

const instances = [], updates = [], executions = [], original = VanguardDriver.prototype.update, prepare = VanguardDriver.prototype.prepare;
VanguardDriver.prototype.prepare = function (car) {
  if (!this.prepared) this.settings = { ...this.settings, ...opts };
  prepare.call(this, car);
  if (!this.benchSet) { Object.assign(this.options, opts); this.benchSet = true; this.course.refresh(car, true); }
};
VanguardDriver.prototype.update = function (...a) {
  if (!instances.includes(this)) instances.push(this);
  const t = performance.now();
  try { return original.apply(this, a); }
  finally { (this.settings.executor ? executions : updates).push(performance.now() - t); }
};

const shim = path === 'worker' ? installWorkerShim({
  frameSteps: +flag('frameSteps', 2), lagFrames: +flag('lagFrames', 0), lagJitter: +flag('lagJitter', 0), frameJitter: +flag('frameJitter', 0), seed
}) : null;
let seats;
const teams = ids.map((id, i) => ({
  id: 't' + i, name: id + i, short: id.slice(0, 3) + i, color: i ? '#f60' : '#00f5d4', index: i, starter: 0,
  classId: classes[i] || cls, raceClass: (classes[i] || cls) === 'lmdh' ? 'gtp' : 'gt3', grid: i,
  drivers: [{ kind: 'ai', id, name: id, short: id.slice(0, 3) }]
}));
const r = new EnduranceRace({
  track: new Track(trackId), teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false }, laps: raceLaps,
  startCompound: compound, startType: flag('start', 'rolling'), seed, weatherSeed: seed, weather: flag('weather', 'clear'), difficulty: 1,
  ...(shim ? { makeBridge: (seats = new AsyncSeats(trackId)).factory() } : {}), session: flag('session', 'race')
});
if (shim) { seats.wantDebug = tracePeriod > 0; const ready = seats.start(r); await shim.settle(); await ready; }
r.start(); // start() resets cars, tyres and formation; apply the fixture after it.
if (!args.includes('--strategy')) for (const e of r.entries) e.strategist.decide = () => null;
for (const c of r.cars) {
  r.fitTyres(c, compound, true);
  for (const w of c.wheels) w.tyre.wear = initialWear;
  if (args.includes('--fuel')) c.fuel = +flag('fuel', c.fuel);
}
const actualStart = r.cars.map(c => ({ classId: c.classId, fuel: c.fuel,
  compounds: c.wheels.map(w => w.tyre.compound), wear: c.wheels.map(w => w.tyre.wear),
  temperatures: c.wheels.map(w => w.tyre.core) }));
for (const e of r.entries) for (const b of e.bridges) b.reset?.({ cars: r.cars, track: r.track });
if (args.includes('--file') && r.formation) r.formation.slot = i => ({ row: i, lat: 0 });
let maxError = 0, lowStraight = 0, straight = 0, lastPedal = 0, pulses = 0, lastFlip = -99, lastTrace = -Infinity;
const trace = [], laps = ids.map(() => []), lapMarks = r.cars.map(c => c.race.lap),
  safety = ids.map(() => ({ peakDamage: 0, damageGained: 0, formationDamage: 0, drivingDamage: 0, pitRelatedDamage: 0 })),
  damageMarks = r.cars.map(c => c.damage), incidentEvents = ids.map(() => []);
const contactBooks = ids.map(() => ({ rubs: 0, nose: 0, rear: 0, other: 0, severe: 0, peakClosing: 0 }));
r.collisionStats.pairs.push = function(...events) {
  for (const [a, b, closing] of events) {
    for (const id of [a, b]) {
      const type = classifyContact(r.cars[id], r.cars[id === a ? b : a], closing);
      const book = contactBooks[id]; book.rubs += Number(type.rub); book.nose += Number(type.nose);
      book.rear += Number(type.rear); book.other += Number(!type.rub && !type.nose && !type.rear); book.severe += Number(type.severe);
      book.peakClosing = Math.max(book.peakClosing, closing);
    }
  }
  return Array.prototype.push.apply(this, events);
};

while (r.time < duration && r.phase !== 'finished' && !(lapTarget > 0 && laps.every(a => a.length >= lapTarget))) {
  const pitting = r.entries.map(e => Boolean(e.pit || e.pitPlan || e.car.race.boxThisLap));
  r.step(FIXED_DT); shim?.step();
  r.cars.forEach((c, i) => {
    safety[i].peakDamage = Math.max(safety[i].peakDamage, c.damage);
    const damageStep = Math.max(0, c.damage - damageMarks[i]);
    safety[i].damageGained += damageStep;
    if (pitting[i] || r.entries[i].pit) safety[i].pitRelatedDamage += damageStep;
    if (damageStep > 0) {
      const events = incidentEvents[i], previous = events.at(-1);
      if (previous && r.time - previous.lastTime < 0.5) { previous.damage += damageStep; previous.lastTime = r.time; }
      else if (events.length < 32) events.push({ time: r.time, lastTime: r.time, damage: damageStep,
        s: c.s, lap: c.race.lap, speed: c.speed, pit: r.entries[i].pit?.phase ?? null,
        boxCalled: pitting[i], offtrack: c.race.offtrack });
    }
    safety[i][r.formation || r.phase !== 'racing' ? 'formationDamage' : 'drivingDamage'] += damageStep;
    damageMarks[i] = c.damage;
    if (c.race.lap !== lapMarks[i]) {
      lapMarks[i] = c.race.lap;
      if (c.race.lastLap > 0) {
        laps[i].push({
          lap: c.race.lap - 1, time: c.race.lastLap,
          valid: !['red', 'pit'].includes(c.race.lastState), state: c.race.lastState,
          sectors: [...c.race.secCur],
          wear: Math.max(...c.wheels.map(w => w.tyre.wear)),
          fuel: c.fuel, soc: c.hybrid?.energy / 3e6, inc: r.stewards.of(r.entries[i]).inc
        });
      }
    }
  });
  if (tracePeriod > 0 && r.time - lastTrace >= tracePeriod) {
    lastTrace = r.time;
    trace.push({ time: r.time, phase: r.phase, formation: Boolean(r.formation), contacts: r.contacts,
      cars: r.entries.map(e => ({ id: e.car.id, driver: e.team.drivers[e.active]?.id,
        s: e.car.s, x: e.car.x, z: e.car.z, yaw: e.car.yaw, speed: e.car.speed,
        lap: e.car.race.lap, valid: e.car.race.valid, offtrack: e.car.race.offtrack,
        aquaplaning: Math.max(...e.car.wheels.map(w => w.aqua ?? 0)),
        damage: e.car.damage, controls: { ...e.car.controls }, debug: structuredClone(e.bridges[e.active]?.debug?.()) })) });
  }
  const c = r.cars[ids.indexOf('vanguard')], d = instances.find(d => d.lastCar?.id === c?.id && (path !== 'worker' || d.settings.executor));
  if (d && c && !r.formation && r.phase === 'racing') {
    maxError = Math.max(maxError, Math.abs(d.controller.e));
    if (Math.abs(d.path.sample(d.path.ks, d.controller.cur.i, d.controller.cur.f)) < 0.0006 && c.speed > 40) {
      straight++; if (c.controls.throttle < 0.9) lowStraight++;
    }
    const pedal = c.controls.brake > 0.05 ? -1 : c.controls.throttle > 0.1 ? 1 : 0;
    if (pedal && lastPedal && pedal !== lastPedal && r.time - lastFlip < 0.3) pulses++;
    if (pedal && pedal !== lastPedal) lastFlip = r.time;
    if (pedal) lastPedal = pedal;
  }
}
const q = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
const result = {
  track: trackId, cls, classes: teams.map(t => t.classId), path, ids, seed, tyres: compound, options: opts,
  weather: flag('weather', 'clear'), initialWear, lapTarget, raceLaps, time: r.time, phase: r.phase,
  harnessVersion: 'post-start-setup-v2', actualStart,
  scoreContract: 'race-budget-20pct-per-20laps-v1', damageAllowance: 0.20 * Math.min(1, raceLaps / 20),
  sourceHashes, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  changesDuringRun: Object.entries(sourceHashes).filter(([f, hash]) =>
    createHash('sha256').update(readFileSync(root + f)).digest('hex') !== hash).map(([f]) => f),
  cars: r.cars.map((c, i) => ({
    id: ids[i], best: c.race.bestLap, last: c.race.lastLap, lap: c.race.lap, progress: c.race.progress,
    finishTime: c.race.finishTime, finishLaps: c.race.finishLaps, dq: Boolean(c.race.dq),
    damage: c.damage, fuel: c.fuel, wear: c.wheels.map(w => w.tyre.wear), temps: c.wheels.map(w => w.tyre.core),
    soc: c.hybrid?.energy / 3e6, inc: r.stewards.of(r.entries[i]).inc, laps: laps[i], safety: safety[i],
    errors: r.entries[i].bridges.map(b => b.errors),
    stats: instances.find(d => d.lastCar?.id === c.id && (path !== 'worker' || d.settings.executor))?.outcomes.book,
    contactKinds: contactBooks[i],
    racecraftBudget: instances.find(d => d.lastCar?.id === c.id && (path !== 'worker' || d.settings.executor))?.racecraft.trace,
    pitStops: r.entries[i].strategist.stops
    , incidents: incidentEvents[i]
  })),
  contacts: r.contacts, severe: r.collisionStats.severeContacts, maxError,
  standings: r.classification().map(({ position, id, finishTime, lapsDone }) => ({ position, id, finishTime, lapsDone })),
  straightLift: straight ? lowStraight / straight : 0, pulses,
  cost: {
    wallSeconds: (performance.now() - wallStarted) / 1000,
    worker: { p50: q(updates, 0.5), p95: q(updates, 0.95), p99: q(updates, 0.99), max: q(updates, 1) },
    executor: { p50: q(executions, 0.5), p95: q(executions, 0.95), p99: q(executions, 0.99), max: q(executions, 1) }
  }
};
seats?.dispose();
const output = flag('out', '');
if (output) {
  const dir = fileURLToPath(new URL('../results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + output, JSON.stringify({ result, trace }, null, 2));
}
console.log(JSON.stringify(result));
