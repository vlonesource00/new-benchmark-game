import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT } from '../../../game/core/race.js';
import { FORMATS } from '../../../game/core/rules.js';
import { AsyncSeats } from '../../../game/core/async-seats.js';
import { installWorkerShim } from '../../../scripts/bench/lockstep-workers.mjs';
import { Course } from '../src/course.js';
import { settingsFor } from '../src/settings.js';
import { VanguardDriver } from '../src/driver.js';
import { Resources } from '../src/strategy.js';
import { gap } from '../src/math.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const cls = arg('cls', 'lmdh'), trackId = arg('track', 'harbor-ring'), rival = arg('rival', 'apex'), path = arg('path', 'worker'),
  seed = +arg('seed', 7), s = +arg('s', 250), distance = +arg('gap', 23), v = +arg('v', 58), rv = +arg('rv', 48),
  T = +arg('time', 30), follow = args.includes('--follow'), hazard = arg('hazard', '');
if (args.includes('--energy-stock')) Resources.prototype.energy = function (car) { car.intent = null; };
const all = [], u = VanguardDriver.prototype.update, prepare = VanguardDriver.prototype.prepare;
const opts = JSON.parse(arg('opts', '{}'));
VanguardDriver.prototype.prepare = function (car) { prepare.call(this, car); this.options.combat = !follow; Object.assign(this.options, opts); };
VanguardDriver.prototype.update = function (...a) { if (!all.includes(this)) all.push(this); return u.apply(this, a); };
const ids = [rival, 'vanguard'], teams = ids.map((id, i) => ({
  id: 'e' + i, name: id, short: id.slice(0, 3), index: i, color: i ? '#00f5d4' : '#f60',
  grid: i, classId: i === 0 ? arg('rivalClass', cls) : cls, starter: 0,
  drivers: [{ id, name: id, short: id.slice(0, 3), kind: 'ai' }]
}));
const shim = path === 'worker' ? installWorkerShim({ frameSteps: +arg('frameSteps', 2), lagFrames: +arg('lagFrames', 0), lagJitter: +arg('lagJitter', 0), seed }) : null;
let seats;
const race = new EnduranceRace({
  track: new Track(trackId), teams, format: { ...FORMATS.custom, mandatoryStops: 0, mandatorySwap: false },
  laps: 20, startCompound: 'soft', startType: 'standing', seed, difficulty: 1,
  ...(shim ? { makeBridge: (seats = new AsyncSeats(trackId)).factory() } : {})
});
if (shim) { const ready = seats.start(race); await shim.settle(); await ready; }
race.start(); while (race.phase !== 'racing') { race.step(FIXED_DT); shim?.step(); }
race.time = 10;
const courses = new Map();
for (let i = 0; i < 2; i++) {
  const car = race.cars[i], state = car.race, fuel = car.fuel, road = s + (i === 0 ? distance : 0), speed = i === 0 ? rv : v;
  const settings = settingsFor(trackId), course = courses.get(car.classId) ?? new Course(race.track, { ...settings, ...settings.perClass?.[car.classId] });
  course.prepare(car); courses.set(car.classId, course);
  let index = 0, nearest = Infinity;
  for (let n = 0; n < course.line.N; n++) { const delta = Math.abs(gap(course.line.st[n], road, race.track.length)); if (delta < nearest) { index = n; nearest = delta; } }
  car.place(race.track, road, course.line.lat[index], speed);
  car.race = { ...state, lap: 1, progress: road, previousS: road, lapStart: 10 };
  car.fuel = fuel; car.gear = course.model.gearAt(speed, 4);
  car.yaw = course.line.h[index]; car.vx = Math.sin(car.yaw) * speed; car.vz = Math.cos(car.yaw) * speed;
  race.fitTyres(car, 'soft', true);
  for (const b of race.entries[i].bridges) b.reset?.({ cars: race.cars, track: race.track });
  race.entries[i].strategist.decide = () => null;
}
if (hazard) {
  const c = race.cars[0], e = race.entries[0];
  if (['stopped', 'spun', 'offroad'].includes(hazard)) {
    c.place(race.track, s + distance, hazard === 'offroad' ? race.track.halfWidth + 5 : +arg('rivalLat', race.cars[1].lateral), 0);
    if (hazard === 'spun') c.yaw += Math.PI * +arg('hazardYaw', 0.55);
    for (const b of e.bridges) b.update = car => { car.controls = { throttle: 0, brake: 1, steer: 0 }; };
    if (!args.includes('--rescue')) { const rescue = race.rescue.bind(race); race.rescue = (entry, dt) => entry === e ? undefined : rescue(entry, dt); }
  } else if (hazard === 'boxing') e.pitPlan = { litres: 0, tyres: false, swap: false, compound: 'soft' };
}
const brakeAt = +arg('brake-at', Infinity), brakeDuration = +arg('brake-duration', 1), leadBrake = +arg('lead-brake', 0.8);
if (Number.isFinite(brakeAt)) {
  for (const bridge of race.entries[0].bridges) {
    const update = bridge.update.bind(bridge);
    bridge.update = (car, ...rest) => {
      update(car, ...rest);
      if (race.time >= 10 + brakeAt && race.time < 10 + brakeAt + brakeDuration) car.controls = { ...car.controls, throttle: 0, brake: leadBrake };
    };
  }
}
const trace = []; let tracedAt = -Infinity;
while (race.time < 10 + T) {
  race.step(FIXED_DT); shim?.step();
  for (const d of all) if (d.prepared) { d.options.combat = !follow; }
  if (args.includes('--trace') && race.time - tracedAt >= 0.25) {
    tracedAt = race.time;
    trace.push({ time: race.time, contacts: race.contacts,
      cars: race.cars.map(c => ({ speed: c.speed, s: c.s, lateral: c.lateral, controls: { ...c.controls } })),
      drivers: all.filter(d => d.lastCar?.id === 1).map(d => ({ executor: Boolean(d.settings.executor),
        state: d.battle.state, returnReason: d.battle.returnReason, side: d.battle.side,
        route: d.path?.key, targetSpeed: d.controller.targetSpeed, source: d.controller.trace?.source,
        yieldingTo: d.controller.trace?.yieldingTo, delay: d.course.anchorDelay,
        candidates: d.battle.candidates.map(c => ({ kind: c.kind, risk: c.risk, progress: c.progress,
          side: c.side, score: c.score, finalGap: c.finalGap, chosen: c.path === d.path })) })) });
  }
}
const driver = all.find(d => d.lastCar?.id === 1 && (path === 'native' || d.settings.executor));
const summary = {
  contacts: race.contacts,
  severe: race.collisionStats.severeContacts,
  damage: race.cars[1].damage,
  otherDamage: race.cars[0].damage,
  incidents: race.stewards.of(race.entries[1]).inc,
  errors: race.entries[1].bridges.map(b => b.errors),
  finalGap: (race.cars[0].s - race.cars[1].s + race.track.length * 1.5) % race.track.length - race.track.length / 2,
  stats: driver?.outcomes.book
};
if (args.includes('--trace')) summary.trace = trace;
seats?.dispose();
const out = arg('out', '');
if (out) {
  const dir = fileURLToPath(new URL('../results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + out, JSON.stringify({ summary }, null, 2));
}
console.log(JSON.stringify(summary));
