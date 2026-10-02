import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Track } from '../../../game/engine/sim/track.js';
import { EnduranceRace, FIXED_DT, maxWear } from '../../../game/core/race.js';
import { COMPOUNDS, FORMATS } from '../../../game/core/rules.js';
import { AI_DRIVERS, TEAM_LIVERIES } from '../../../game/core/teams.js';

const args = process.argv.slice(2), option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const trackName = option('track', 'alpine'), limit = Number(option('seconds', 700));
const targetCar = option('car', null) === null ? null : Number(option('car'));
const stopAfter = Number(option('after', 10)), seed = Number(option('seed', 7));
const output = option('output', null), driverId = option('driver', 'solstice');
const lapCount = Number(option('laps', 6)), teamCount = Number(option('teams', 4));
const compound = option('compound', 'medium'), weather = option('weather', 'clear');
if (!Object.hasOwn(COMPOUNDS, compound) || !Number.isInteger(teamCount) || teamCount < 1 || teamCount > TEAM_LIVERIES.length
  || !Number.isInteger(lapCount) || lapCount < 1) throw new Error('Invalid race probe format');
const trigger = option('event', 'offtrack');
if (!['offtrack', 'contact'].includes(trigger)) throw new Error('Unknown probe event');
const driver = AI_DRIVERS.find(d => d.id === driverId);
if (!driver) throw new Error(`Unknown driver ${driverId}`);
const teams = Array.from({ length: teamCount }, (_, index) => ({ ...TEAM_LIVERIES[index],
  id: `bench-${index}`, index, grid: index, starter: 0,
  drivers: [0, 1].map(() => ({ ...driver, kind: 'ai' })) }));
const race = new EnduranceRace({ track: new Track(trackName), teams,
  format: lapCount === 6 ? FORMATS.sprint : lapCount === 20 ? FORMATS.marathon : FORMATS.classic,
  laps: lapCount, startCompound: compound, difficulty: 1, weather, seed });
race.weather.sun = .6; race.weather.apply(race.track);
const wrapDelta = (a, b) => ((a - b + race.track.length / 2) % race.track.length + race.track.length) % race.track.length - race.track.length / 2;
const round = value => Number.isFinite(value) ? Number(value.toFixed(5)) : value;
function snapshot(entry) {
  const c = entry.car, bridge = entry.bridges[entry.active], d = bridge.driver;
  const p = race.track.nearest(c.x, c.z), point = d?.path?.at(c.s);
  return { car: c.id, time: round(race.time), lap: c.race.lap, s: round(c.s),
    lateral: round(c.lateral), speed: round(c.speed), u: round(c.u), v: round(c.v),
    beta: round(Math.atan2(c.v, c.u)), yawError: round(Math.atan2(Math.sin(c.yaw - p.heading), Math.cos(c.yaw - p.heading))),
    yawRate: round(c.yawRate), controls: Object.fromEntries(Object.entries(c.controls).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
    offtrack: round(c.race.offtrack), fuel: round(c.fuel), wear: round(maxWear(c)),
    tyres: c.wheels.map(w => ({ core: round(w.tyre.core), surface: round(w.tyre.surface), wear: round(w.tyre.wear), pressure: round(w.tyre.pressure), compound: w.tyre.compound,
      alpha: round(w.tyre.alpha), kappa: round(w.tyre.kappa), fx: round(w.tyre.fx), fy: round(w.tyre.fy), load: round(w.load), slipPower: round(w.tyre.slipPower) })),
    pit: entry.pit?.phase ?? null, pitPlan: entry.pitPlan ?? null, active: entry.active,
    stops: entry.strategist.stops, swaps: entry.strategist.swaps, rescueGhost: round(entry.rescueGhost ?? 0),
    mode: d?.mode ?? bridge.debug?.().intent, trafficMode: d?.traffic?.mode ?? null,
    selected: d?.selected ?? null, targetSpeed: round(d?.targetSpeed), envelopeSpeed: round(point?.speed),
    pathOffset: round(point?.offset), governorActive: entry.governor.active, governorK: round(entry.governor.k),
    planStats: d?.stats ?? null, errors: bridge.errors,
    neighbours: race.cars.filter(o => o.id !== c.id).map(o => ({ car: o.id, ds: round(wrapDelta(o.s, c.s)), lateral: round(o.lateral), speed: round(o.speed), pit: race.entryOf(o).pit?.phase ?? null })) };
}
const before = race.cars.map(c => ({ offtrack: 0, active: 0, ghost: 0, pit: null, lap: 1 }));
const frames = [], transitions = [], events = [], firstOfftrack = {};
let firstTargetAt = null, nextFrame = 0, lastEvent = 0;
const hashes = Object.fromEntries(['driver', 'policy', 'path', 'traffic', 'plant'].map(name =>
  [name, createHash('sha256').update(readFileSync(new URL(`../src/${name}.js`, import.meta.url))).digest('hex')]));
race.start();
const wall = performance.now();
while (race.time < limit && race.phase !== 'finished' && (firstTargetAt === null || race.time < firstTargetAt + stopAfter)) {
  const contactsBefore = race.contacts;
  race.step(FIXED_DT);
  if (race.contacts > contactsBefore) {
    if (trigger === 'contact' && firstTargetAt === null) firstTargetAt = race.time;
    if (contactsBefore === 0) transitions.push({ type: 'first-contact', time: race.time,
      contacts: race.contacts, cars: race.entries.map(snapshot) });
  }
  for (const e of race.entries) {
    const c = e.car, old = before[c.id];
    const beganOfftrack = c.race.offtrack > old.offtrack && !old.wasOfftrack;
    if (beganOfftrack) {
      firstOfftrack[c.id] ??= race.time;
      const hit = snapshot(e); transitions.push({ type: 'offtrack-start', ...hit });
      if (trigger === 'offtrack' && firstTargetAt === null && (targetCar === null || c.id === targetCar)) firstTargetAt = race.time;
    }
    const pit = e.pit?.phase ?? null;
    if (pit !== old.pit || e.active !== old.active || (e.rescueGhost ?? 0) > old.ghost + .1 || c.race.lap !== old.lap)
      transitions.push({ type: 'pit-seat-rescue-lap', ...snapshot(e) });
    Object.assign(old, { wasOfftrack: c.race.offtrack > old.offtrack, offtrack: c.race.offtrack,
      active: e.active, ghost: e.rescueGhost ?? 0, pit, lap: c.race.lap });
  }
  if (race.time >= nextFrame) {
    frames.push(race.entries.map(snapshot)); nextFrame = race.time + .2;
  }
  for (const event of race.events) if (event.id > lastEvent) { events.push(event); lastEvent = event.id; }
}
const report = { config: { track: trackName, seed, teams: 4, laps: 6, driver: driverId,
  weather: 'clear', sun: .6, difficulty: 'alien', targetCar, stopAfter, limit, trigger,
  solsticeOptions: process.env.SOLSTICE_OPTIONS ?? null }, hashes, simulatedSeconds: race.time,
  wallSeconds: (performance.now() - wall) / 1000, firstOfftrack, contacts: race.contacts,
  transitions, events, frames, final: race.entries.map(snapshot) };
if (output) { const path = resolve(output); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report) + '\n'); }
console.log(JSON.stringify({ config: report.config, hashes, simulatedSeconds: report.simulatedSeconds,
  wallSeconds: report.wallSeconds, firstOfftrack, contacts: race.contacts,
  transitions: transitions.filter(t => t.type === 'offtrack-start').map(({ car, time, lap, s, lateral, speed, u, v, beta, yawError, controls, wear, fuel, pit, active, stops, swaps, mode, trafficMode, selected, targetSpeed, envelopeSpeed, pathOffset, governorActive, neighbours }) =>
    ({ car, time, lap, s, lateral, speed, u, v, beta, yawError, controls, wear, fuel, pit, active, stops, swaps, mode, trafficMode, selected, targetSpeed, envelopeSpeed, pathOffset, governorActive, neighbours })) }));
